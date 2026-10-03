//! DOM event observation — QueueingHandler is installed into the EventDriver
//! that processes UiEvents, capturing DomEvents (click/input/key/focus/scroll)
//! and serializing them into a per-doc JSON queue drained by dd_osr_poll_events.

use std::cell::RefCell;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::rc::Rc;

use blitz_dom::{Document, EventHandler, NodeId};
use blitz_traits::events::{DomEvent, DomEventData, EventState, MouseEventButton};
use keyboard_types::Modifiers;

pub type EventQueue = Rc<RefCell<VecDeque<String>>>;

pub fn new_event_queue() -> EventQueue {
    Rc::new(RefCell::new(VecDeque::with_capacity(32)))
}

/// Events worth reporting to the host — noisy moves/enters/leaves are dropped
/// because :hover etc. repaint locally and need no round-trip.
const EMIT: &[&str] = &[
    "click",
    "dblclick",
    "contextmenu",
    "mousedown",
    "mouseup",
    "keydown",
    "keyup",
    "input",
    "focus",
    "blur",
    "scroll",
    "pointermove", // only emitted while a button is held (see handle_event)
];

const QUEUE_CAP: usize = 4096;

fn json_escape(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

fn mods_bits(m: Modifiers) -> u32 {
    let mut bits = 0;
    if m.contains(Modifiers::SHIFT) {
        bits |= 1;
    }
    if m.contains(Modifiers::CONTROL) {
        bits |= 2;
    }
    if m.contains(Modifiers::ALT) {
        bits |= 4;
    }
    if m.contains(Modifiers::SUPER) {
        bits |= 8;
    }
    bits
}

fn button_num(b: MouseEventButton) -> u32 {
    match b {
        MouseEventButton::Auxiliary => 1,
        MouseEventButton::Secondary => 2,
        MouseEventButton::Fourth => 3,
        MouseEventButton::Fifth => 4,
        _ => 0,
    }
}

fn key_str(k: &keyboard_types::Key) -> String {
    match k {
        keyboard_types::Key::Character(s) => s.to_string(),
        other => format!("{:?}", other),
    }
}

/// Target element's tag name ("" for non-element targets).
fn target_tag(doc: &dyn Document, target: NodeId) -> String {
    doc.inner()
        .get_node(target)
        .and_then(|n| n.element_data())
        .map(|e| e.name.local.to_string())
        .unwrap_or_default()
}

/// Walk target → ancestors collecting `data-*` attrs (closest wins) plus the
/// first non-empty `id`. Deliberately ignores `chain` ordering.
fn collect_target_data(doc: &dyn Document, target: NodeId) -> (String, Vec<(String, String)>) {
    let mut id_attr = String::new();
    let mut data: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let inner = doc.inner();
    let mut cur = Some(target);
    while let Some(node_id) = cur {
        let Some(node) = inner.get_node(node_id) else { break };
        if let Some(attrs) = node.attrs() {
            for a in attrs {
                let local: &str = &a.name.local;
                if local == "id" && id_attr.is_empty() {
                    id_attr = a.value.clone();
                } else if let Some(stripped) = local.strip_prefix("data-") {
                    if seen.insert(stripped.to_string()) {
                        data.push((stripped.to_string(), a.value.clone()));
                    }
                }
            }
        }
        cur = node.parent;
    }
    (id_attr, data)
}

pub struct QueueingHandler {
    pub queue: EventQueue,
}

impl EventHandler for QueueingHandler {
    fn handle_event(
        &mut self,
        _chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        _event_state: &mut EventState,
    ) {
        let name = event.name();
        if !EMIT.contains(&name) {
            return;
        }
        // pointermove is drag-only: bare hover moves stay inside the doc.
        if name == "pointermove" {
            let dragging = matches!(&event.data, DomEventData::PointerMove(p) if !p.buttons.is_empty());
            if !dragging {
                return;
            }
        }
        let mut q = self.queue.borrow_mut();
        if q.len() >= QUEUE_CAP {
            q.pop_front();
        }

        let mut out = String::with_capacity(192);
        out.push_str("{\"t\":\"");
        out.push_str(name);
        out.push_str("\",\"n\":");
        out.push_str(&event.target.as_u64().to_string());

        let tag = target_tag(doc, event.target);
        if !tag.is_empty() {
            out.push_str(",\"g\":\"");
            json_escape(&mut out, &tag);
            out.push('"');
        }

        match &event.data {
            DomEventData::PointerMove(p) => {
                out.push_str(",\"x\":");
                out.push_str(&p.coords.client_x.to_string());
                out.push_str(",\"y\":");
                out.push_str(&p.coords.client_y.to_string());
                out.push_str(",\"m\":");
                out.push_str(&mods_bits(p.mods).to_string());
            }
            DomEventData::PointerDown(p)
            | DomEventData::PointerUp(p)
            | DomEventData::MouseMove(p)
            | DomEventData::MouseDown(p)
            | DomEventData::MouseUp(p)
            | DomEventData::Click(p)
            | DomEventData::DoubleClick(p)
            | DomEventData::ContextMenu(p) => {
                out.push_str(",\"x\":");
                out.push_str(&p.coords.client_x.to_string());
                out.push_str(",\"y\":");
                out.push_str(&p.coords.client_y.to_string());
                out.push_str(",\"b\":");
                out.push_str(&button_num(p.button).to_string());
                out.push_str(",\"m\":");
                out.push_str(&mods_bits(p.mods).to_string());
            }
            DomEventData::KeyDown(k) | DomEventData::KeyUp(k) => {
                out.push_str(",\"k\":\"");
                json_escape(&mut out, &key_str(&k.key));
                out.push_str("\",\"c\":\"");
                json_escape(&mut out, &format!("{:?}", k.code));
                out.push_str("\",\"m\":");
                out.push_str(&mods_bits(k.modifiers).to_string());
            }
            DomEventData::Input(i) => {
                out.push_str(",\"v\":\"");
                json_escape(&mut out, &i.value);
                out.push('"');
            }
            DomEventData::Scroll(s) => {
                out.push_str(",\"st\":");
                out.push_str(&s.scroll_top.to_string());
                out.push_str(",\"sl\":");
                out.push_str(&s.scroll_left.to_string());
            }
            _ => {}
        }

        let (id_attr, data) = collect_target_data(doc, event.target);
        if !id_attr.is_empty() {
            out.push_str(",\"id\":\"");
            json_escape(&mut out, &id_attr);
            out.push('"');
        }
        if !data.is_empty() {
            out.push_str(",\"d\":{");
            for (i, (k, v)) in data.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                json_escape(&mut out, k);
                out.push_str("\":\"");
                json_escape(&mut out, v);
                out.push('"');
            }
            out.push('}');
        }
        out.push('}');
        q.push_back(out);
    }
}
