//! downdraft-blitz-shell — shared headless Blitz/Dioxus UI shell.
//!
//! This crate owns everything except the app's UI: the vdom driver,
//! vello_cpu rasterizer, input dispatch, and the JS bridge. App crates
//! provide the Dioxus root component and a snapshot applier through
//! `ShellConfig`, and re-expose `#[wasm_bindgen]` entry points as thin
//! shims (see `apps/sandjongg/blitz-ui` for the pattern).
//!
//! Coordinates passed to `push_input`/`hit_test` are canvas *backing*
//! (physical) pixels — the engine's InputManager already converts DOM
//! client coords to canvas space.

mod bridge;
mod fonts;
mod input;
mod shell;

/// Minimal console bindings so the shell can report snapshot errors
/// without pulling web_sys into the crate.
pub mod console {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = console)]
        pub fn warn(s: &str);
        #[wasm_bindgen(js_namespace = console)]
        pub fn error(s: &str);
        #[wasm_bindgen(js_namespace = console)]
        pub fn log(s: &str);
    }
}

pub use bridge::{
    dispatch_action, hit_test as doc_hit_test, push_input, push_snapshot, set_action_cb, AppBridge,
    BRIDGE,
};
pub use input::PendingInput;
pub use shell::{frame, init, resize, shutdown, tick, ShellConfig};

/// Is (x, y) — physical px — over an interactive UI element? Used by the
/// engine router so clicks on transparent areas fall through to the app.
/// Conservatively returns true if the document is mid-mutation.
pub fn hit_test(x: f64, y: f64) -> bool {
    BRIDGE.with(|b| {
        let b = b.borrow();
        let Some(doc) = &b.doc else { return false };
        let result = match doc.try_borrow() {
            Ok(doc) => doc_hit_test(&doc, x, y),
            // Reentrant call while an event/render holds the borrow — the
            // pointer is interacting with the UI, so claim it.
            Err(_) => true,
        };
        result
    })
}

/// Debug: dump the DOM tree (interactive nodes marked with `*`).
pub fn dump_dom() -> String {
    fn walk(doc: &blitz_dom::BaseDocument, id: blitz_dom::NodeId, depth: usize, out: &mut String) {
        let Some(node) = doc.get_node(id) else { return };
        let marker = if node.attr(blitz_dom::LocalName::from("data-ui")).is_some() {
            "*"
        } else {
            " "
        };
        let tag = node
            .element_data()
            .map(|e| e.name.local.to_string())
            .or_else(|| node.text_data().map(|_| "#text".to_string()))
            .unwrap_or_else(|| "#node".to_string());
        out.push_str(&format!("{}{} {:?}\n", "  ".repeat(depth), marker, tag));
        for &child in node.children.iter() {
            walk(doc, child, depth + 1, out);
        }
    }

    BRIDGE.with(|b| {
        let b = b.borrow();
        let Some(doc) = &b.doc else {
            return String::from("(no document)");
        };
        let result = match doc.try_borrow() {
            Ok(doc) => {
                let mut out = String::new();
                let root = doc.root_node().id;
                walk(&doc, root, 0, &mut out);
                out
            }
            Err(_) => String::from("(document borrowed)"),
        };
        result
    })
}
