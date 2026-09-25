//! downdraft-blitz-osr — headless Blitz HTML/CSS rasterizer behind a C ABI.
//!
//! Native OSR backend (Track D): `blitz_html::HtmlDocument` + vello_cpu
//! rasterize HTML/CSS into an RGBA8 buffer inside a plain cdylib, loadable
//! via `bun:ffi` — no wasm, no Dioxus, no winit.
//!
//! The host (platform-native NativeOsrHost) owns one handle per OSR panel or
//! dedicated renderer, pushes HTML via `dd_osr_init`/`dd_osr_set_html`,
//! forwards synthetic input via `dd_osr_pointer`/`dd_osr_wheel`/`dd_osr_key`,
//! and polls `dd_osr_frame` for dirty RGBA output.

use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::str::FromStr;
use std::sync::Arc;

use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use atomic_refcell::AtomicRefCell;
use blitz_dom::{Document, DocumentConfig, FontContext};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent,
    KeyState, MouseEventButton, MouseEventButtons, PointerCoords, PointerDetails,
    UiEvent,
};
use blitz_traits::shell::{ColorScheme, Viewport};
use keyboard_types::{Code, Key, Location, Modifiers};
use linebender_resource_handle::Blob;

/// Same single-font fallback the Dioxus shell uses — the OSR crate has no
/// system font collection either.
const FONT_BYTES: &[u8] = include_bytes!("../../native/assets/DejaVuSans.woff2");

/// Modifier bitmask for the C ABI — bit0=shift, bit1=ctrl, bit2=alt, bit3=meta.
fn kbt_modifiers(bits: u32) -> Modifiers {
    let mut m = Modifiers::default();
    if bits & 1 != 0 {
        m.insert(Modifiers::SHIFT);
    }
    if bits & 2 != 0 {
        m.insert(Modifiers::CONTROL);
    }
    if bits & 4 != 0 {
        m.insert(Modifiers::ALT);
    }
    if bits & 8 != 0 {
        m.insert(Modifiers::SUPER);
    }
    m
}

/// DOM `MouseEvent.button` mapping: 0=left, 1=middle, 2=right.
fn dom_button(button: c_int) -> MouseEventButton {
    match button {
        1 => MouseEventButton::Auxiliary,
        2 => MouseEventButton::Secondary,
        3 => MouseEventButton::Fourth,
        4 => MouseEventButton::Fifth,
        _ => MouseEventButton::Main,
    }
}

fn font_ctx() -> FontContext {
    let mut ctx = blitz_dom::build_single_font_ctx(FONT_BYTES);
    ctx.collection
        .register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);
    ctx
}

fn build_doc(width: u32, height: u32, scale: f32, html: &str) -> HtmlDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            font_ctx: Some(font_ctx()),
            viewport: Some(Viewport::new(width, height, scale, ColorScheme::Dark)),
            ..Default::default()
        },
    )
}

pub struct OsrDoc {
    doc: HtmlDocument,
    renderer: VelloCpuImageRenderer,
    pixels: Vec<u8>,
    dirty: bool,
    /// Currently-pressed mouse buttons (mirrors winit shell bookkeeping).
    buttons: MouseEventButtons,
    /// Last pointer position in physical px — wheel events reuse it.
    pointer_pos: (f64, f64),
    /// Active-pointer list shared into every dispatched event (multi-touch).
    active_pointers: Arc<AtomicRefCell<Vec<BlitzPointerEvent>>>,
}

/// Run an FFI body with panic isolation — a Rust panic must never unwind
/// across the FFI boundary. Returns `default` on panic.
fn ffi<R, F>(default: R, f: F) -> R
where
    F: FnOnce() -> R,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(default)
}

unsafe fn read_str<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).ok()
}

/// Create a document from an HTML string. `html` may be a full document or
/// a fragment — html5ever normalizes either into <html>/<body>.
/// Returns an opaque handle, or NULL on bad input / panic.
#[no_mangle]
pub extern "C" fn dd_osr_init(
    width: f64,
    height: f64,
    scale: f64,
    html_ptr: *const u8,
    html_len: usize,
) -> *mut OsrDoc {
    ffi(std::ptr::null_mut(), || {
        let Some(html) = (unsafe { read_str(html_ptr, html_len) }) else {
            return std::ptr::null_mut();
        };
        let w = width.max(1.0) as u32;
        let h = height.max(1.0) as u32;
        let scale = if scale > 0.0 { scale as f32 } else { 1.0 };
        let doc = OsrDoc {
            doc: build_doc(w, h, scale, html),
            renderer: VelloCpuImageRenderer::new(w, h),
            pixels: Vec::new(),
            dirty: true,
            buttons: MouseEventButtons::None,
            pointer_pos: (0.0, 0.0),
            active_pointers: Arc::new(AtomicRefCell::new(Vec::new())),
        };
        Box::into_raw(Box::new(doc))
    })
}

/// Replace the document's HTML content. The viewport, scale and renderer are
/// preserved; the DOM is rebuilt from scratch (Blitz has no in-place HTML
/// reparse). Marks the document dirty. Returns 0 on success.
#[no_mangle]
pub extern "C" fn dd_osr_set_html(handle: *mut OsrDoc, html_ptr: *const u8, html_len: usize) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let Some(html) = (unsafe { read_str(html_ptr, html_len) }) else {
            return -2;
        };
        let (w, h) = d.doc.inner().viewport().window_size;
        let scale = d.doc.inner().viewport().scale_f64() as f32;
        d.doc = build_doc(w, h, scale, html);
        d.buttons = MouseEventButtons::None;
        d.active_pointers.borrow_mut().clear();
        d.dirty = true;
        0
    })
}

/// Rasterize into the internal RGBA8 buffer when dirty. Returns a pointer
/// to `width*height*4` bytes owned by the handle (valid until the next
/// `dd_osr_frame`/`dd_osr_resize`/`dd_osr_destroy`), or NULL when there is
/// nothing new to upload.
#[no_mangle]
pub extern "C" fn dd_osr_frame(handle: *mut OsrDoc) -> *const u8 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return std::ptr::null();
        };
        if !d.dirty {
            return std::ptr::null();
        }
        let mut inner = d.doc.inner_mut();
        inner.resolve(0.0);
        let (w, h) = inner.viewport().window_size;
        let scale = inner.viewport().scale_f64();
        if inner.has_pending_critical_resources() {
            return std::ptr::null();
        }
        d.renderer.reset();
        d.renderer.render_to_vec(
            |scene| paint_scene(scene, &mut inner, scale, w, h, 0, 0),
            &mut d.pixels,
        );
        d.dirty = inner.is_animating();
        d.pixels.as_ptr()
    })
}

/// Current pixel-buffer length (width*height*4) — lets the host size its
/// copy without trusting its own bookkeeping.
#[no_mangle]
pub extern "C" fn dd_osr_pixels_len(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        d.pixels.len()
    })
}

/// Resize the viewport. Marks the document dirty.
#[no_mangle]
pub extern "C" fn dd_osr_resize(handle: *mut OsrDoc, width: f64, height: f64, scale: f64) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let w = width.max(1.0) as u32;
        let h = height.max(1.0) as u32;
        {
            let mut inner = d.doc.inner_mut();
            let mut vp = inner.viewport_mut();
            vp.window_size = (w, h);
            if scale > 0.0 {
                vp.set_hidpi_scale(scale as f32);
            }
        }
        d.renderer.resize(w, h);
        d.dirty = true;
        0
    })
}

/// Pointer coords in Blitz terms — physical px → logical, no safe-area
/// insets, scroll offset folded into page coords. Mirrors the winit shell.
fn pointer_coords(d: &OsrDoc, x: f64, y: f64) -> PointerCoords {
    let inner = d.doc.inner();
    let scale = inner.viewport().scale_f64();
    let lx = (x / scale) as f32;
    let ly = (y / scale) as f32;
    let scroll = inner.viewport_scroll();
    PointerCoords {
        screen_x: lx,
        screen_y: ly,
        client_x: lx,
        client_y: ly,
        page_x: lx + scroll.x as f32,
        page_y: ly + scroll.y as f32,
    }
}

fn make_pointer_event(
    d: &OsrDoc,
    x: f64,
    y: f64,
    button: MouseEventButton,
) -> BlitzPointerEvent {
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: pointer_coords(d, x, y),
        button,
        buttons: d.buttons,
        mods: Modifiers::default(),
        details: PointerDetails::default(),
        element: Default::default(),
        active_pointers: Arc::clone(&d.active_pointers),
    }
}

/// Pointer event dispatch. `kind`: 0=move, 1=down, 2=up.
/// `button` uses DOM numbering (0=left, 1=middle, 2=right) for down/up and is
/// ignored for move. `mods` is the shift/ctrl/alt/meta bitmask above.
/// Returns 0 on success. Always marks dirty — event handlers may mutate the
/// DOM or flip :hover styles.
#[no_mangle]
pub extern "C" fn dd_osr_pointer(
    handle: *mut OsrDoc,
    kind: c_int,
    x: f64,
    y: f64,
    button: c_int,
    mods: u32,
) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        d.pointer_pos = (x, y);
        let mut event = make_pointer_event(d, x, y, dom_button(button));
        event.mods = kbt_modifiers(mods);
        let ui_event = match kind {
            1 => {
                d.buttons |= event.button.into();
                event.buttons = d.buttons;
                UiEvent::PointerDown(event)
            }
            2 => {
                d.buttons ^= event.button.into();
                event.buttons = d.buttons;
                UiEvent::PointerUp(event)
            }
            _ => UiEvent::PointerMove(event),
        };
        d.doc.handle_ui_event(ui_event);
        d.dirty = true;
        0
    })
}

/// Wheel event at the last pointer position. Deltas are in pixels.
#[no_mangle]
pub extern "C" fn dd_osr_wheel(
    handle: *mut OsrDoc,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    mods: u32,
) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let event = BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(delta_x, delta_y),
            coords: pointer_coords(d, x, y),
            buttons: d.buttons,
            mods: kbt_modifiers(mods),
            element: Default::default(),
        };
        d.doc.handle_ui_event(UiEvent::Wheel(event));
        d.dirty = true;
        0
    })
}

/// Keyboard event. `kind`: 0=down, 1=up. `key`/`code` are W3C UI-Events
/// strings ("Enter", "a", "KeyF", "Escape") parsed via keyboard-types'
/// FromStr; `text` is the text to insert (usually the key when printable).
#[no_mangle]
pub extern "C" fn dd_osr_key(
    handle: *mut OsrDoc,
    kind: c_int,
    key_ptr: *const u8,
    key_len: usize,
    code_ptr: *const u8,
    code_len: usize,
    text_ptr: *const u8,
    text_len: usize,
    mods: u32,
) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let key_s = unsafe { read_str(key_ptr, key_len) }.unwrap_or("Unidentified");
        let code_s = unsafe { read_str(code_ptr, code_len) }.unwrap_or("");
        let key = Key::from_str(key_s).unwrap_or(Key::Unidentified);
        let code = Code::from_str(code_s).unwrap_or(Code::Unidentified);
        let text = unsafe { read_str(text_ptr, text_len) }.map(|t| t.into());
        let event = BlitzKeyEvent {
            key,
            code,
            modifiers: kbt_modifiers(mods),
            location: Location::Standard,
            is_auto_repeating: false,
            is_composing: false,
            state: if kind == 1 {
                KeyState::Released
            } else {
                KeyState::Pressed
            },
            text,
        };
        let ui_event = if kind == 1 {
            UiEvent::KeyUp(event)
        } else {
            UiEvent::KeyDown(event)
        };
        d.doc.handle_ui_event(ui_event);
        d.dirty = true;
        0
    })
}

/// Is (x, y) — physical px — over an element marked `data-ui`? Mirrors
/// `bridge::hit_test` in the Dioxus shell.
#[no_mangle]
pub extern "C" fn dd_osr_hit_test(handle: *mut OsrDoc, x: f64, y: f64) -> c_int {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return 0;
        };
        let doc = d.doc.inner();
        let scale = doc.viewport().scale_f64();
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut id = doc.element_from_point(lx, ly);
        while let Some(node_id) = id {
            let Some(node) = doc.get_node(node_id) else { break };
            if node.attr(blitz_dom::LocalName::from("data-ui")).is_some() {
                return 1;
            }
            id = node.parent;
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_osr_destroy(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        if handle.is_null() {
            return -1;
        }
        drop(unsafe { Box::from_raw(handle) });
        0
    })
}
