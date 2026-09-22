//! Bridge between the JS host and the Rust UI.
//!
//! - `BRIDGE` is the thread_local the wasm exports mutate: pending snapshots
//!   (raw JSON — deserialization is the game crate's job, see
//!   `ShellConfig::apply_snapshot`), pending input events, the action
//!   callback, and a shared handle to the document for synchronous queries
//!   like `ui_hit_test` / `ui_dump`.
//! - `GameBridge` is the cloneable context injected into the VirtualDom so
//!   RSX event handlers can dispatch actions back to JS.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use blitz_dom::BaseDocument;
use js_sys::Function;

use crate::input::PendingInput;

/// Pending work pushed by wasm exports, drained inside the event loop.
pub struct BridgeQueues {
    pub doc: Option<Rc<RefCell<BaseDocument>>>,
    pub pending_events: VecDeque<PendingInput>,
    /// Raw snapshot JSON, latest-wins. The game's `apply_snapshot` callback
    /// deserializes it into its own snapshot type inside `Shell::tick`.
    pub pending_snapshot: Option<String>,
    pub shutdown: bool,
}

thread_local! {
    pub static BRIDGE: RefCell<BridgeQueues> = const {
        RefCell::new(BridgeQueues {
            doc: None,
            pending_events: VecDeque::new(),
            pending_snapshot: None,
            shutdown: false,
        })
    };
    pub static ACTION_CB: RefCell<Option<Function>> = const { RefCell::new(None) };
}

/// Push a pending input event (drained by `ui_tick`).
pub fn push_input(input: PendingInput) {
    BRIDGE.with(|b| b.borrow_mut().pending_events.push_back(input));
}

/// Set the latest snapshot JSON (applied by `ui_tick`).
pub fn push_snapshot(json: String) {
    BRIDGE.with(|b| b.borrow_mut().pending_snapshot = Some(json));
}

/// Store the JS action callback invoked by `dispatch_action`.
pub fn set_action_cb(cb: Function) {
    ACTION_CB.with(|slot| *slot.borrow_mut() = Some(cb));
}

/// Hit-test shared by both shells: is (x, y) — in physical px — over an
/// interactive element (marked with a `data-ui` attribute)?
pub fn hit_test(doc: &BaseDocument, x: f64, y: f64) -> bool {
    let scale = doc.viewport().scale_f64();
    let lx = (x / scale) as f32;
    let ly = (y / scale) as f32;
    let mut id = doc.element_from_point(lx, ly);
    while let Some(node_id) = id {
        let Some(node) = doc.get_node(node_id) else { break };
        if node.attr(blitz_dom::LocalName::from("data-ui")).is_some() {
            return true;
        }
        id = node.parent;
    }
    false
}

/// Invoke the JS action callback with (action, payload_json).
pub fn dispatch_action(action: &str, payload_json: &str) {
    ACTION_CB.with(|cb| {
        if let Some(cb) = cb.borrow().as_ref() {
            let _ = cb.call2(
                &wasm_bindgen::JsValue::NULL,
                &action.into(),
                &payload_json.into(),
            );
        }
    });
}

/// Context provided to the VirtualDom root so components can dispatch
/// actions without touching the thread_local directly.
#[derive(Clone, Copy)]
pub struct GameBridge;

impl GameBridge {
    pub fn dispatch(&self, action: &str) {
        dispatch_action(action, "{}");
    }

    pub fn dispatch_json(&self, action: &str, payload_json: &str) {
        dispatch_action(action, payload_json);
    }
}
