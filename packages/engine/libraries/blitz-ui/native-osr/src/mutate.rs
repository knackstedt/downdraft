//! Incremental DOM mutation FFI — selector queries + DocumentMutator ops let
//! the host update text/attrs/styles/fragments without a full HTML reparse.
//! Node handles are raw `NodeId` u64s; they invalidate on structural edits —
//! the host must re-query after set_inner_html.

use std::os::raw::c_int;

use blitz_dom::{
    Document, DocumentMutator, LocalName, NodeId, QualName, ScrollBehavior, ScrollLogicalPosition,
    ns,
};

use crate::{OsrDoc, ffi, read_str};

fn attr_qname(name: &str) -> QualName {
    QualName::new(None, ns!(), LocalName::from(name))
}

fn node_id(raw: u64) -> NodeId {
    NodeId::from_u64(raw)
}

/// Validates the target NodeId first — NodeIds are
/// slotmap keys that invalidate on structural edits, and every mutator op
/// indexes `doc.nodes[id]` unchecked (stale keys panic).
fn with_node_mutator(
    handle: *mut OsrDoc,
    node: u64,
    f: impl FnOnce(&mut DocumentMutator, NodeId) -> c_int,
) -> c_int {
    if node == 0 {
        return -1;
    }
    let id = node_id(node);
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        if d.doc.inner().get_node(id).is_none() {
            return -1; // stale/missing node — no-op
        }
        let mut doc = d.doc.inner_mut();
        let mut mutator = DocumentMutator::new(&mut doc);
        let r = f(&mut mutator, id);
        drop(mutator); // flush mutations
        d.dirty = true;
        r
    })
}

/// CSS selector → raw NodeId (0 on miss/parse error). NodeIds invalidate on
/// structural mutations — re-query after set_inner_html / node removal.
#[no_mangle]
pub extern "C" fn dd_osr_query(handle: *mut OsrDoc, sel_ptr: *const u8, sel_len: usize) -> u64 {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return 0;
        };
        let Some(sel) = (unsafe { read_str(sel_ptr, sel_len) }) else {
            return 0;
        };
        let doc = d.doc.inner();
        doc.query_selector(sel)
            .ok()
            .flatten()
            .map(|n| n.as_u64())
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn dd_osr_set_text(
    handle: *mut OsrDoc,
    node: u64,
    text_ptr: *const u8,
    text_len: usize,
) -> c_int {
    with_node_mutator(handle, node, |m, id| {
        let Some(text) = (unsafe { read_str(text_ptr, text_len) }) else {
            return -1;
        };
        if m.element_name(id).is_some() {
            // Element target: textContent semantics — replace children with a
            // single text node (set_node_text itself only handles text nodes).
            let text_node = m.create_text_node(text);
            m.replace_children(id, &[text_node]);
        } else {
            m.set_node_text(id, text);
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_osr_set_attr(
    handle: *mut OsrDoc,
    node: u64,
    name_ptr: *const u8,
    name_len: usize,
    val_ptr: *const u8,
    val_len: usize,
) -> c_int {
    with_node_mutator(handle, node, |m, id| {
        let Some(name) = (unsafe { read_str(name_ptr, name_len) }) else {
            return -1;
        };
        let Some(val) = (unsafe { read_str(val_ptr, val_len) }) else {
            return -1;
        };
        m.set_attribute(id, attr_qname(name), val);
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_osr_remove_attr(
    handle: *mut OsrDoc,
    node: u64,
    name_ptr: *const u8,
    name_len: usize,
) -> c_int {
    with_node_mutator(handle, node, |m, id| {
        let Some(name) = (unsafe { read_str(name_ptr, name_len) }) else {
            return -1;
        };
        m.clear_attribute(id, attr_qname(name));
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_osr_set_style(
    handle: *mut OsrDoc,
    node: u64,
    prop_ptr: *const u8,
    prop_len: usize,
    val_ptr: *const u8,
    val_len: usize,
) -> c_int {
    with_node_mutator(handle, node, |m, id| {
        let Some(prop) = (unsafe { read_str(prop_ptr, prop_len) }) else {
            return -1;
        };
        let Some(val) = (unsafe { read_str(val_ptr, val_len) }) else {
            return -1;
        };
        m.set_style_property(id, prop, val);
        0
    })
}

/// Replace a node's children with parsed HTML (DocumentMutator::set_inner_html
/// — requires the HtmlProvider set in build_doc).
#[no_mangle]
pub extern "C" fn dd_osr_set_inner_html(
    handle: *mut OsrDoc,
    node: u64,
    html_ptr: *const u8,
    html_len: usize,
) -> c_int {
    with_node_mutator(handle, node, |m, id| {
        let Some(html) = (unsafe { read_str(html_ptr, html_len) }) else {
            return -1;
        };
        m.set_inner_html(id, html);
        0
    })
}

/// Get an attribute's value (or input's current text for <input>/<textarea>)
/// into the doc's out-buffer. Read `dd_osr_out_len` for the byte length.
/// NULL when the node/attr is absent.
#[no_mangle]
pub extern "C" fn dd_osr_get_attr(
    handle: *mut OsrDoc,
    node: u64,
    name_ptr: *const u8,
    name_len: usize,
) -> *const u8 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return std::ptr::null();
        };
        let Some(name) = (unsafe { read_str(name_ptr, name_len) }) else {
            return std::ptr::null();
        };
        let doc = d.doc.inner();
        let Some(node_ref) = doc.get_node(node_id(node)) else {
            return std::ptr::null();
        };
        let value: Option<String> = if let Some(input) = node_ref
            .element_data()
            .and_then(|e| e.text_input_data())
            .filter(|_| name == "value")
        {
            Some(input.editor.text().to_string())
        } else {
            node_ref.attr(LocalName::from(name)).map(|s| s.to_string())
        };
        let Some(value) = value else {
            return std::ptr::null();
        };
        d.out_buf.clear();
        d.out_buf.extend_from_slice(value.as_bytes());
        d.out_buf.as_ptr()
    })
}

/// Node border-box rect in logical (CSS) px relative to the document origin:
/// writes [x, y, w, h] into the doc's rect buffer and returns its pointer.
/// NULL when the node id is stale/missing. Matches the coordinate space of
/// DOM event client_x/client_y.
#[no_mangle]
pub extern "C" fn dd_osr_node_rect(handle: *mut OsrDoc, node: u64) -> *const f64 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return std::ptr::null();
        };
        if node == 0 {
            return std::ptr::null();
        }
        let rect = {
            let doc = d.doc.inner();
            let Some(node_ref) = doc.get_node(node_id(node)) else {
                return std::ptr::null();
            };
            let pos = node_ref.unrounded_absolute_position(0.0, 0.0);
            let size = node_ref.final_layout().size;
            [pos.x as f64, pos.y as f64, size.width as f64, size.height as f64]
        };
        d.rect_buf = rect;
        d.rect_buf.as_ptr()
    })
}

/// Byte length of the out-buffer written by dd_osr_get_attr.
#[no_mangle]
pub extern "C" fn dd_osr_out_len(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        d.out_buf.len()
    })
}

/// Focus a node programmatically (mirrors click-focus). Pass 0 to blur.
#[no_mangle]
pub extern "C" fn dd_osr_focus(handle: *mut OsrDoc, node: u64) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let mut doc = d.doc.inner_mut();
        if node == 0 {
            doc.clear_focus();
        } else {
            let id = node_id(node);
            if doc.get_node(id).is_none() {
                return -1;
            }
            doc.set_focus_to(id);
        }
        d.dirty = true;
        0
    })
}

/// CSS selector → all matching raw NodeIds, written into the doc's query
/// buffer. Returns the buffer pointer; read `dd_osr_query_all_len` for the
/// element count. Pointer is invalidated by the next query_all call (and by
/// doc teardown). NodeIds invalidate on structural mutations.
#[no_mangle]
pub extern "C" fn dd_osr_query_all(
    handle: *mut OsrDoc,
    sel_ptr: *const u8,
    sel_len: usize,
) -> *const u64 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return std::ptr::null();
        };
        let Some(sel) = (unsafe { read_str(sel_ptr, sel_len) }) else {
            return std::ptr::null();
        };
        let doc = d.doc.inner();
        d.query_buf.clear();
        if let Ok(ids) = doc.query_selector_all(sel) {
            d.query_buf.extend(ids.into_iter().map(|n| n.as_u64()));
        }
        d.query_buf.as_ptr()
    })
}

/// Element count in the buffer returned by dd_osr_query_all.
#[no_mangle]
pub extern "C" fn dd_osr_query_all_len(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        d.query_buf.len()
    })
}

/// Scroll the viewport so that `node` is visible.
///   behavior: 0 = instant, 1 = smooth
///   v_align/h_align: 0 = start, 1 = center, 2 = end, 3 = nearest
#[no_mangle]
pub extern "C" fn dd_osr_scroll_into_view(
    handle: *mut OsrDoc,
    node: u64,
    behavior: c_int,
    v_align: c_int,
    h_align: c_int,
) -> c_int {
    fn align(v: c_int) -> ScrollLogicalPosition {
        match v {
            0 => ScrollLogicalPosition::Start,
            1 => ScrollLogicalPosition::Center,
            2 => ScrollLogicalPosition::End,
            _ => ScrollLogicalPosition::Nearest,
        }
    }
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let id = node_id(node);
        {
            let doc = d.doc.inner();
            if node == 0 || doc.get_node(id).is_none() {
                return -1;
            }
        }
        d.doc.inner_mut().scroll_into_view(
            id,
            if behavior == 1 { ScrollBehavior::Smooth } else { ScrollBehavior::Instant },
            align(v_align),
            align(h_align),
        );
        d.dirty = true;
        0
    })
}

/// Nearest ancestor-or-self matching a CSS selector → raw NodeId (0 on miss).
/// Used by nav zoning (e.g. closest("[data-nav-zone]")).
#[no_mangle]
pub extern "C" fn dd_osr_closest(
    handle: *mut OsrDoc,
    node: u64,
    sel_ptr: *const u8,
    sel_len: usize,
) -> u64 {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return 0;
        };
        let Some(sel) = (unsafe { read_str(sel_ptr, sel_len) }) else {
            return 0;
        };
        let doc = d.doc.inner();
        doc.closest(node_id(node), sel)
            .ok()
            .flatten()
            .map(|n| n.as_u64())
            .unwrap_or(0)
    })
}

/// Currently-focused node id, or 0 when nothing is focused.
#[no_mangle]
pub extern "C" fn dd_osr_focused_node(handle: *mut OsrDoc) -> u64 {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        d.doc
            .inner()
            .get_focussed_node_id()
            .map(|id| id.as_u64())
            .unwrap_or(0)
    })
}
