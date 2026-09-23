//! downdraft-blitz-osr — headless Blitz HTML/CSS rasterizer behind a C ABI.
//!
//! Spike for native OSR (Track D): proves `blitz_html::HtmlDocument` +
//! vello_cpu can rasterize arbitrary HTML/CSS into an RGBA8 buffer inside a
//! plain cdylib, loadable via `bun:ffi` — no wasm, no Dioxus, no winit.
//!
//! Modelled on `../native/src/shell.rs` (the Dioxus headless shell), minus
//! the vdom: the host pushes an HTML document once, then calls `frame`
//! whenever `tick`-equivalent dirtiness matters. OSR panels are mostly
//! static, so dirtiness is recompute-on-load/resize only for now.

use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{Document, DocumentConfig, FontContext};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use linebender_resource_handle::Blob;

/// Same single-font fallback the Dioxus shell uses — the OSR crate has no
/// system font collection either.
const FONT_BYTES: &[u8] = include_bytes!("../../native/assets/DejaVuSans.woff2");

fn font_ctx() -> FontContext {
    let mut ctx = blitz_dom::build_single_font_ctx(FONT_BYTES);
    ctx.collection
        .register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);
    ctx
}

pub struct OsrDoc {
    doc: HtmlDocument,
    renderer: VelloCpuImageRenderer,
    pixels: Vec<u8>,
    dirty: bool,
}

/// Run an FFI body with panic isolation — a Rust panic must never unwind
/// across the FFI boundary. Returns `default` on panic.
fn ffi<R, F>(default: R, f: F) -> R
where
    F: FnOnce() -> R,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(default)
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
        if html_ptr.is_null() || html_len == 0 {
            return std::ptr::null_mut();
        }
        let bytes = unsafe { std::slice::from_raw_parts(html_ptr, html_len) };
        let html = match std::str::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => return std::ptr::null_mut(),
        };
        let w = width.max(1.0) as u32;
        let h = height.max(1.0) as u32;
        let scale = if scale > 0.0 { scale as f32 } else { 1.0 };
        let doc = HtmlDocument::from_html(
            html,
            DocumentConfig {
                font_ctx: Some(font_ctx()),
                viewport: Some(Viewport::new(w, h, scale, ColorScheme::Dark)),
                ..Default::default()
            },
        );
        let doc = OsrDoc {
            doc,
            renderer: VelloCpuImageRenderer::new(w, h),
            pixels: Vec::new(),
            dirty: true,
        };
        Box::into_raw(Box::new(doc))
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
