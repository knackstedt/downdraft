//! downdraft-blitz-osr — headless Blitz HTML/CSS rasterizer behind a C ABI.
//!
//! Native OSR backend (Track D): `blitz_html::HtmlDocument` + vello_cpu
//! rasterize HTML/CSS into an RGBA8 buffer inside a plain cdylib, loadable
//! via `bun:ffi` — no wasm, no Dioxus, no winit.
//!
//! The host (platform-native NativeOsrHost) owns one handle per OSR panel or
//! dedicated renderer, pushes HTML via `dd_osr_init`/`dd_osr_set_html`,
//! forwards synthetic input via `dd_osr_pointer`/`dd_osr_wheel`/`dd_osr_key`,
//! and pulls dirty RGBA frames via `dd_osr_frame` (pointer into an owned
//! buffer) or `dd_osr_frame_into` (copy into a host-bound SharedArrayBuffer —
//! the zero-copy path used by the html-ui worker channel).

use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use atomic_refcell::AtomicRefCell;
use blitz_dom::{Document, DocumentConfig, EventDriver, FontContext};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent,
    KeyState, MouseEventButton, MouseEventButtons, PointerCoords, PointerDetails,
    UiEvent,
};
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use keyboard_types::{Code, Key, Location, Modifiers};
use linebender_resource_handle::Blob;

mod events;
mod mutate;
mod resources;

use events::{new_event_queue, EventQueue, QueueingHandler};
use resources::{register_resource, UiNetProvider};

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

/// ShellProvider that records `request_redraw` calls. Blitz invokes it for
/// every repaint-worthy change — hover/active restyles, scrolls, focus and
/// caret updates, pending device changes — so the flag is a complete dirty
/// signal for event-driven work (unconditional raster on every input event
/// used to repaint the whole document 60×/s while merely moving the mouse).
struct FlagShell {
    flag: Arc<AtomicBool>,
}
impl ShellProvider for FlagShell {
    fn request_redraw(&self) {
        self.flag.store(true, Ordering::Relaxed);
    }
}

fn build_doc(
    width: u32,
    height: u32,
    scale: f32,
    html: &str,
    redraw: Arc<AtomicBool>,
) -> HtmlDocument {
    HtmlDocument::from_html(
        html,
        DocumentConfig {
            font_ctx: Some(font_ctx()),
            viewport: Some(Viewport::new(width, height, scale, ColorScheme::Dark)),
            net_provider: Some(Arc::new(UiNetProvider)),
            html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
            shell_provider: Some(Arc::new(FlagShell { flag: redraw })),
            ..Default::default()
        },
    )
}

/// Host-shared frame buffer bound via `dd_osr_bind_frame_buf`. The host owns
/// the underlying SharedArrayBuffer; we only hold a raw pointer. Layout
/// (u32 fields): [seq][x][y][w][h][pw][ph][flags][stride][reserved..16 words]
/// then pixel rows at `stride` bytes each, starting at byte 64. `seq` is a
/// seqlock: odd while a write is in flight, even when the buffer is stable —
/// the host treats an odd value or a changed value across the read as torn.
struct BoundBuf {
    ptr: *mut u8,
    len: usize,
    seq: u32,
}
unsafe impl Send for BoundBuf {}
unsafe impl Sync for BoundBuf {}

const FRAME_HEADER: usize = 64;

fn align256(n: usize) -> usize {
    (n + 255) & !255
}

pub struct OsrDoc {
    pub(crate) doc: HtmlDocument,
    renderer: VelloCpuImageRenderer,
    pixels: Vec<u8>,
    /// Previous frame's pixels — diffed against to produce the dirty rect.
    prev_pixels: Vec<u8>,
    /// Pixel-space bounding box [x,y,w,h] of the last frame()'s changes.
    dirty_rect: [u32; 4],
    pub(crate) dirty: bool,
    /// Set by FlagShell whenever the document requests a repaint (hover,
    /// scroll, focus, ...). Folded into `dirty` by pending()/frame().
    pub(crate) redraw: Arc<AtomicBool>,
    /// Per-frame timings + counters surfaced via dd_osr_last_stats.
    /// [resolve_ms, paint_ms, diff_ms, pixels_len, rasters, skips]
    stats: [f64; 8],
    /// Optional SAB staging buffer for zero-copy frame delivery.
    frame_buf: Option<BoundBuf>,
    /// Currently-pressed mouse buttons (mirrors winit shell bookkeeping).
    buttons: MouseEventButtons,
    /// Last pointer position in physical px — wheel events reuse it.
    pointer_pos: (f64, f64),
    /// Active-pointer list shared into every dispatched event (multi-touch).
    active_pointers: Arc<AtomicRefCell<Vec<BlitzPointerEvent>>>,
    /// DOM events captured during dispatch — drained by dd_osr_poll_events.
    events: EventQueue,
    /// Owned buffer returned by dd_osr_poll_events (JSON array).
    events_buf: Vec<u8>,
    /// Owned buffer for string-returning FFI calls (dd_osr_get_attr).
    pub(crate) out_buf: Vec<u8>,
    /// Owned rect buffer written by dd_osr_node_rect: [x, y, w, h] logical px.
    pub(crate) rect_buf: [f64; 4],
    /// Owned node-id list written by dd_osr_query_all.
    pub(crate) query_buf: Vec<u64>,
}

/// O(1) "did anything change" check: Blitz propagates a damaged_descendants
/// flag to ancestors when a node is marked for restyle, so the root flag plus
/// the shell's redraw request covers event-driven visual changes.
fn doc_has_damage(d: &OsrDoc) -> bool {
    let doc = d.doc.inner();
    let root = doc.root_node();
    root.has_damaged_descendants() || root.damage().is_some_and(|dmg| !dmg.is_empty())
}

/// Fold pending repaint signals into `d.dirty`. Called after input dispatch
/// and from pending()/frame() so a redraw request never gets missed.
fn fold_redraw(d: &mut OsrDoc) {
    if d.redraw.swap(false, Ordering::Relaxed) || doc_has_damage(d) {
        d.dirty = true;
    }
}

/// Dispatch a UiEvent through the EventDriver, observing DOM events via
/// QueueingHandler (replaces the default NoopEventHandler dispatch).
fn dispatch(d: &mut OsrDoc, ui_event: UiEvent) {
    let mut driver = EventDriver::new(
        &mut d.doc,
        QueueingHandler {
            queue: std::rc::Rc::clone(&d.events),
        },
    );
    driver.handle_ui_event(ui_event);
}

/// Pixel-space bounding box of the difference between `prev` and `cur`
/// (w = row width in px), or None when identical. Size mismatch → full rect.
fn diff_rect(prev: &[u8], cur: &[u8], w: usize) -> Option<[u32; 4]> {
    let h = if w > 0 { cur.len() / (w * 4) } else { 0 };
    if prev.len() != cur.len() || h == 0 {
        return Some([0, 0, w as u32, h as u32]);
    }
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    for y in 0..h {
        let rs = y * w * 4;
        let row = &cur[rs..rs + w * 4];
        let prow = &prev[rs..rs + w * 4];
        if row == prow {
            continue;
        }
        min_y = min_y.min(y);
        max_y = y;
        let mut first = None;
        let mut last = 0usize;
        for x in 0..w {
            let i = x * 4;
            if row[i..i + 4] != prow[i..i + 4] {
                if first.is_none() {
                    first = Some(x);
                }
                last = x;
            }
        }
        if let Some(f) = first {
            min_x = min_x.min(f);
            max_x = max_x.max(last);
        }
    }
    if min_y > max_y {
        return None;
    }
    Some([min_x as u32, min_y as u32, (max_x + 1 - min_x) as u32, (max_y + 1 - min_y) as u32])
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
        let redraw = Arc::new(AtomicBool::new(true));
        let doc = OsrDoc {
            doc: build_doc(w, h, scale, html, Arc::clone(&redraw)),
            renderer: VelloCpuImageRenderer::new(w, h),
            pixels: Vec::new(),
            prev_pixels: Vec::new(),
            dirty_rect: [0, 0, 0, 0],
            dirty: true,
            redraw,
            stats: [0.0; 8],
            frame_buf: None,
            buttons: MouseEventButtons::None,
            pointer_pos: (0.0, 0.0),
            active_pointers: Arc::new(AtomicRefCell::new(Vec::new())),
            events: new_event_queue(),
            events_buf: Vec::new(),
            out_buf: Vec::new(),
            rect_buf: [0.0; 4],
            query_buf: Vec::new(),
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
        d.doc = build_doc(w, h, scale, html, Arc::clone(&d.redraw));
        d.buttons = MouseEventButtons::None;
        d.active_pointers.borrow_mut().clear();
        d.events.borrow_mut().clear();
        d.prev_pixels.clear();
        d.dirty = true;
        0
    })
}

/// Resolve + rasterize + diff when dirty. Returns Some(rect) when the pixel
/// buffer changed (rect = pixel-space dirty region), None when clean or
/// identical. Writes per-call timings into d.stats.
fn raster_if_dirty(d: &mut OsrDoc) -> Option<[u32; 4]> {
    fold_redraw(d);
    if !d.dirty {
        return None;
    }
    let t0 = Instant::now();
    let mut inner = d.doc.inner_mut();
    inner.resolve(0.0);
    let (w, h) = inner.viewport().window_size;
    let scale = inner.viewport().scale_f64();
    if inner.has_pending_critical_resources() {
        // Leave dirty set — retry once resources land.
        return None;
    }
    d.stats[0] = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    d.renderer.reset();
    d.renderer.render_to_vec(
        |scene| paint_scene(scene, &mut inner, scale, w, h, 0, 0),
        &mut d.pixels,
    );
    d.stats[1] = t1.elapsed().as_secs_f64() * 1000.0;
    d.dirty = inner.is_animating();
    drop(inner);
    let t2 = Instant::now();
    // Diff against the retained frame — identical output means no upload.
    let rect = diff_rect(&d.prev_pixels, &d.pixels, w as usize);
    d.stats[2] = t2.elapsed().as_secs_f64() * 1000.0;
    d.stats[3] = d.pixels.len() as f64;
    match rect {
        Some(rect) => {
            d.dirty_rect = rect;
            d.prev_pixels.clear();
            d.prev_pixels.extend_from_slice(&d.pixels);
            d.stats[4] += 1.0;
            Some(rect)
        }
        None => {
            d.stats[5] += 1.0;
            None
        }
    }
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
        if raster_if_dirty(d).is_none() {
            return std::ptr::null();
        }
        d.pixels.as_ptr()
    })
}

/// Bytes required for a bound frame buffer at the document's current size:
/// 64-byte header + 256-aligned pixel rows for a full frame.
fn needed_buf_len(d: &OsrDoc) -> usize {
    let (w, h) = d.doc.inner().viewport().window_size;
    FRAME_HEADER + align256(w as usize * 4) * h as usize
}

#[no_mangle]
pub extern "C" fn dd_osr_buf_needed(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        needed_buf_len(d)
    })
}

/// Bind a host-owned buffer (a SharedArrayBuffer on the JS side) for
/// zero-copy frame delivery. Returns 0 when the buffer is large enough for
/// the current frame size, -2 when it must be regrown.
#[no_mangle]
pub extern "C" fn dd_osr_bind_frame_buf(handle: *mut OsrDoc, ptr: *mut u8, len: usize) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        if ptr.is_null() || len < needed_buf_len(d) {
            return -2;
        }
        d.frame_buf = Some(BoundBuf { ptr, len, seq: 0 });
        0
    })
}

/// Write `pixels`' dirty rect into the bound buffer (seqlock-guarded header).
/// Returns 1 on write. Pixel rows land at `stride`-byte offsets so the host
/// can upload straight out of the buffer via writeTexture(bytesPerRow).
fn write_bound_frame(d: &mut OsrDoc, rect: [u32; 4]) -> c_int {
    let Some(buf) = d.frame_buf.as_mut() else {
        return -3;
    };
    let [x, y, w, h] = rect;
    let (pw, ph) = d.doc.inner().viewport().window_size;
    let stride = align256(pw as usize * 4);
    unsafe {
        let base = buf.ptr;
        buf.seq = buf.seq.wrapping_add(1) | 1; // odd — write in flight
        (base as *mut u32).write_volatile(buf.seq);
        (base.add(4) as *mut u32).write_volatile(x);
        (base.add(8) as *mut u32).write_volatile(y);
        (base.add(12) as *mut u32).write_volatile(w);
        (base.add(16) as *mut u32).write_volatile(h);
        (base.add(20) as *mut u32).write_volatile(pw);
        (base.add(24) as *mut u32).write_volatile(ph);
        let full = (x == 0 && y == 0 && w == pw && h == ph) as u32;
        (base.add(28) as *mut u32).write_volatile(full);
        (base.add(32) as *mut u32).write_volatile(stride as u32);
        let src = d.pixels.as_ptr();
        for r in 0..h as usize {
            let src_off = ((y as usize + r) * pw as usize + x as usize) * 4;
            let dst_off = FRAME_HEADER + (y as usize + r) * stride + x as usize * 4;
            std::ptr::copy_nonoverlapping(src.add(src_off), base.add(dst_off), w as usize * 4);
        }
        buf.seq = buf.seq.wrapping_add(1); // even — stable
        (base as *mut u32).write_volatile(buf.seq);
    }
    1
}

/// Rasterize (when dirty) and copy the dirty rect into the bound buffer.
/// Returns 1 when a frame was written, 0 when nothing changed, -2 when the
/// bound buffer is too small (rebind + call dd_osr_refresh_into), -3 when no
/// buffer is bound (caller should use dd_osr_frame + copy instead).
#[no_mangle]
pub extern "C" fn dd_osr_frame_into(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let Some(buf) = d.frame_buf.as_ref() else {
            return -3;
        };
        if buf.len < needed_buf_len(d) {
            return -2;
        }
        let Some(rect) = raster_if_dirty(d) else {
            return 0;
        };
        write_bound_frame(d, rect)
    })
}

/// Re-emit the current pixel buffer into the bound buffer (no raster) — used
/// by the host to recover from a torn seqlock read or after a rebind.
#[no_mangle]
pub extern "C" fn dd_osr_refresh_into(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return -1;
        };
        let Some(buf) = d.frame_buf.as_ref() else {
            return -3;
        };
        if buf.len < needed_buf_len(d) {
            return -2;
        }
        if d.pixels.is_empty() {
            return 0;
        }
        write_bound_frame(d, d.dirty_rect)
    })
}

/// Per-frame stats: [resolve_ms, paint_ms, diff_ms, pixels_len, rasters,
/// skipped-clean rasters] — 64 bytes, pointer owned by the handle.
#[no_mangle]
pub extern "C" fn dd_osr_last_stats(handle: *mut OsrDoc) -> *const f64 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return std::ptr::null();
        };
        d.stats.as_ptr()
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
/// Returns 0 on success. Marks dirty only when the document signals a repaint
/// (redraw request or stylo damage) — a move that changes nothing costs the
/// dispatch alone.
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
        dispatch(d, ui_event);
        fold_redraw(d);
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
        dispatch(d, UiEvent::Wheel(event));
        fold_redraw(d);
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
        dispatch(d, ui_event);
        fold_redraw(d);
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

/// Packed dirty rect for the last successful dd_osr_frame: x<<48|y<<32|w<<16|h.
#[no_mangle]
pub extern "C" fn dd_osr_frame_rect(handle: *mut OsrDoc) -> u64 {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        let [x, y, w, h] = d.dirty_rect;
        ((x as u64) << 48) | ((y as u64) << 32) | ((w as u64) << 16) | h as u64
    })
}

/// Non-destructive dirty check: does this doc have damage worth a raster?
/// (dirty flag set by input/mutations/redraw requests, or CSS animations
/// still running)
#[no_mangle]
pub extern "C" fn dd_osr_pending(handle: *mut OsrDoc) -> c_int {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return 0;
        };
        fold_redraw(d);
        if d.dirty || d.doc.inner().is_animating() {
            1
        } else {
            0
        }
    })
}

/// Drain the DOM-event queue into a JSON array in events_buf → ptr.
/// NULL (len 0) when no events are pending.
#[no_mangle]
pub extern "C" fn dd_osr_poll_events(handle: *mut OsrDoc) -> *const u8 {
    ffi(std::ptr::null(), || {
        let Some(d) = (unsafe { handle.as_mut() }) else {
            return std::ptr::null();
        };
        let mut q = d.events.borrow_mut();
        if q.is_empty() {
            return std::ptr::null();
        }
        d.events_buf.clear();
        d.events_buf.push(b'[');
        let mut first = true;
        while let Some(ev) = q.pop_front() {
            if !first {
                d.events_buf.push(b',');
            }
            first = false;
            d.events_buf.extend_from_slice(ev.as_bytes());
        }
        d.events_buf.push(b']');
        d.events_buf.as_ptr()
    })
}

/// Byte length of the buffer returned by dd_osr_poll_events.
#[no_mangle]
pub extern "C" fn dd_osr_events_len(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(d) = (unsafe { handle.as_ref() }) else {
            return 0;
        };
        d.events_buf.len()
    })
}

/// Register a process-wide `ui://` resource (fonts, images, stylesheets)
/// served to every document's NetProvider. Copy semantics — safe to reuse
/// the caller's buffer after return.
#[no_mangle]
pub extern "C" fn dd_osr_register_resource(
    url_ptr: *const u8,
    url_len: usize,
    bytes_ptr: *const u8,
    bytes_len: usize,
) -> c_int {
    ffi(-1, || {
        let Some(url) = (unsafe { read_str(url_ptr, url_len) }) else {
            return -1;
        };
        if bytes_ptr.is_null() && bytes_len > 0 {
            return -1;
        }
        let bytes = unsafe { std::slice::from_raw_parts(bytes_ptr, bytes_len) };
        register_resource(url, bytes);
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
