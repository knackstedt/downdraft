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

use std::cell::RefCell;
use std::collections::HashSet;
use std::os::raw::c_int;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use anyrender::ImageRenderer;
use anyrender_vello_cpu::{ImageCacheConfig, VelloCpuImageRenderer};
use atomic_refcell::AtomicRefCell;
use blitz_dom::{BaseDocument, Document, DocumentConfig, EventDriver, FontContext, NodeId};
use blitz_html::HtmlDocument;
use blitz_paint::paint_scene;
use blitz_traits::events::{
    BlitzFocusEvent, BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta,
    BlitzWheelEvent, DomEvent, DomEventData, KeyState, MouseEventButton, MouseEventButtons,
    PointerCoords, PointerDetails, UiEvent,
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
    thread_local! {
        /// Primed once per thread: the woff2 decode, bullet-font
        /// registration and generic-family mapping run once, then every
        /// document clones this context. make_shared() turns the collection
        /// internals Arc-backed so clones share registered families and
        /// font blobs (docs on this thread all want the identical font
        /// set); query caches stay per-clone.
        static BASE: RefCell<Option<FontContext>> = const { RefCell::new(None) };
    }
    BASE.with(|b| {
        let mut b = b.borrow_mut();
        b.get_or_insert_with(|| {
            let mut ctx = blitz_dom::build_single_font_ctx(FONT_BYTES);
            ctx.collection
                .register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);
            ctx.collection.make_shared();
            ctx
        })
        .clone()
    })
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

    #[cfg(not(target_os = "android"))]
    fn get_clipboard_text(&self) -> Result<String, blitz_traits::shell::ClipboardError> {
        clipboard()
            .and_then(|mut cb| cb.get_text().ok())
            .ok_or(blitz_traits::shell::ClipboardError)
    }

    #[cfg(not(target_os = "android"))]
    fn set_clipboard_text(&self, text: String) -> Result<(), blitz_traits::shell::ClipboardError> {
        clipboard()
            .and_then(|mut cb| cb.set_text(text).ok())
            .ok_or(blitz_traits::shell::ClipboardError)
    }
}

/// Long-lived process clipboard. On X11 the clipboard owner must keep serving
/// selection requests while it owns the selection, so a fresh `Clipboard` per
/// call is wrong: its `Drop` hands contents to the clipboard manager and
/// destroys the server window, which races requesters and can leave stale or
/// empty contents. Klipper already snapshots content on ownership changes, so
/// keeping the context alive for the process is the normal-app pattern.
#[cfg(not(target_os = "android"))]
fn clipboard() -> Option<std::sync::MutexGuard<'static, arboard::Clipboard>> {
    static CB: std::sync::OnceLock<Option<std::sync::Mutex<arboard::Clipboard>>> =
        std::sync::OnceLock::new();
    CB.get_or_init(|| arboard::Clipboard::new().ok().map(std::sync::Mutex::new))
        .as_ref()
        .and_then(|m| m.lock().ok())
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
    /// Raster target + diff source. Only populated on the legacy pointer
    /// path (dd_osr_frame) or transiently inside dd_osr_frame_into, where a
    /// thread-local shared scratch is swapped in — docs on the SAB path
    /// keep this EMPTY between calls instead of each retaining a full
    /// frame buffer.
    pixels: Vec<u8>,
    /// Previous frame's pixels — diffed against to produce the dirty rect.
    /// Only maintained while no frame buffer is bound; a bound SAB already
    /// retains the last delivered frame and serves as the diff reference,
    /// so SAB-path docs keep this empty.
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
    /// The bound buffer currently holds the last delivered frame — set by
    /// write_bound_frame, cleared on (re)bind, doc rebuild and resize.
    /// dd_osr_refresh_into republishes it header-only; with no retained
    /// pixels to copy, a false flag is the only honest "no frame yet".
    sab_valid: bool,
    /// Currently-pressed mouse buttons (mirrors winit shell bookkeeping).
    buttons: MouseEventButtons,
    /// Node under the last main-button press, via element_from_point. Blitz's
    /// own mousedown_node_id stays None over background (hit() misses the
    /// root), which click reconciliation needs to distinguish "press on page
    /// chrome" from "no press at all".
    press_node: Option<NodeId>,
    /// Last pointer position in physical px — wheel events reuse it.
    pointer_pos: (f64, f64),
    /// Active-pointer list shared into every dispatched event (multi-touch).
    active_pointers: Arc<AtomicRefCell<Vec<BlitzPointerEvent>>>,
    /// DOM events captured during dispatch — drained by dd_osr_poll_events.
    pub(crate) events: EventQueue,
    /// Owned buffer returned by dd_osr_poll_events (JSON array).
    events_buf: Vec<u8>,
    /// Owned buffer for string-returning FFI calls (dd_osr_get_attr).
    pub(crate) out_buf: Vec<u8>,
    /// Owned rect buffer written by dd_osr_node_rect: [x, y, w, h] logical px.
    pub(crate) rect_buf: [f64; 4],
    /// Owned node-id list written by dd_osr_query_all.
    pub(crate) query_buf: Vec<u64>,
    /// Serialization flag — set for the duration of each FFI call. The ABI
    /// exposes a raw `*mut OsrDoc`, so nothing prevents a host from calling
    /// the same doc from two threads at once (which would alias `&mut` and
    /// corrupt the DOM instantly). Callers that arrive while busy get -1.
    busy: AtomicBool,
    /// Animation clock epoch — `resolve(now)` wants elapsed seconds, and a
    /// hardcoded 0.0 froze every CSS transition/animation at its first frame.
    t0: Instant,
}

// ── Handle registry + per-doc call serialization ──
//
// Every handle handed out by dd_osr_init is registered here and removed by
// dd_osr_destroy *before* the Box is freed, so FFI entry points can tell a
// live handle from a stale/garbage pointer without dereferencing it. The
// `busy` flag is then swapped under the registry lock so the
// contains-check → claim sequence is atomic against destroy: after a doc
// leaves the registry no thread can newly enter it, and destroy only frees
// the Box once it owns `busy` (no in-flight call).
static DOCS: OnceLock<Mutex<HashSet<usize>>> = OnceLock::new();

fn docs() -> Option<&'static Mutex<HashSet<usize>>> {
    // Mutex poisoning turns into a permanent OSR outage if a call ever panics
    // while holding it — treat a poisoned/lock failure as "unknown handle".
    DOCS.get_or_init(|| Mutex::new(HashSet::new())).into()
}

/// RAII claim on a live doc — releases `busy` on drop (including unwind).
pub(crate) struct DocGuard {
    doc: *mut OsrDoc,
}

impl DocGuard {
    /// Safety: registry membership keeps the Box alive (destroy removes the
    /// handle before freeing) and `busy` guarantees exclusive access.
    pub(crate) fn get(&mut self) -> &mut OsrDoc {
        unsafe { &mut *self.doc }
    }
}

impl Drop for DocGuard {
    fn drop(&mut self) {
        unsafe { (*self.doc).busy.store(false, Ordering::Release) };
    }
}

/// Validate `handle` against the live-doc registry and claim exclusive
/// access to it. Returns None for null/stale handles or a doc already
/// inside an FFI call.
pub(crate) fn doc_enter(handle: *mut OsrDoc) -> Option<DocGuard> {
    if handle.is_null() {
        return None;
    }
    let key = handle as usize;
    let reg = docs()?.lock().ok()?;
    if !reg.contains(&key) {
        return None;
    }
    // SAFETY: still under the registry lock — the doc cannot be freed here.
    let d = unsafe { &*handle };
    if d.busy.swap(true, Ordering::Acquire) {
        return None;
    }
    Some(DocGuard { doc: handle })
}

/// O(1) "did anything change" check: Blitz propagates a damaged_descendants
/// flag to ancestors when a node is marked for restyle, so the root flag plus
/// the shell's redraw request covers event-driven visual changes.
fn doc_has_damage(d: &OsrDoc) -> bool {
    let doc = d.doc.inner();
    // Read the root ELEMENT's flags, not the document root node's: ancestor
    // marking propagates flags through the document node, but resolve()'s
    // clear pass starts at the root element — the document node's flags are
    // residue that is never cleared, which kept every frame permanently
    // "damaged" (full raster+diff each pump tick that diffed to nothing).
    let root = doc.try_root_element().unwrap_or_else(|| doc.root_node());
    // has_damaged_descendants covers post-restyle layout/paint damage;
    // has_dirty_descendants covers queued restyle work — pseudo-state flips
    // (focus/active from clicks, :hover from moves) mark ancestors dirty but
    // set no damage until resolve() restyles, and without this check a
    // focus-ring change waits invisibly for the next event to flag damage.
    root.has_damaged_descendants()
        || root.has_dirty_descendants()
        || root.damage().is_some_and(|dmg| !dmg.is_empty())
}

/// Fold pending repaint signals into `d.dirty`. Called after input dispatch
/// and from pending()/frame() so a redraw request never gets missed.
fn fold_redraw(d: &mut OsrDoc) {
    if d.redraw.swap(false, Ordering::Relaxed) || doc_has_damage(d) {
        d.dirty = true;
    }
}

/// Resolve pending DOM damage before a hit test. Mutations (set_inner_html
/// & friends) drop nodes from the slab eagerly but only flag ancestors
/// dirty — layout/paint child lists still reference the dead NodeIds until
/// the next resolve(), and hit_inner's Node::with() unwraps them. Frame
/// rastering resolves eventually, but pointer dispatch hit-tests first;
/// without this every pointer move in the mutate→frame window panics.
fn resolve_pending_damage(d: &mut OsrDoc) {
    if !doc_has_damage(d) {
        return;
    }
    let anim_now = d.t0.elapsed().as_secs_f64();
    d.doc.inner_mut().resolve(anim_now);
}

/// Dispatch a UiEvent through the EventDriver, observing DOM events via
/// QueueingHandler (replaces the default NoopEventHandler dispatch).
fn dispatch(d: &mut OsrDoc, ui_event: UiEvent) {
    resolve_pending_damage(d);
    let mut driver = EventDriver::new(
        &mut d.doc,
        QueueingHandler {
            queue: std::rc::Rc::clone(&d.events),
        },
    );
    driver.handle_ui_event(ui_event);
}

/// Pixel-space bounding box of the difference between `prev` and `cur`
/// (w = row width in px, prev_stride = byte offset between `prev` rows —
/// the bound frame buffer pads rows to 256B), or None when identical.
/// A `prev` too short to hold h strided rows → full rect.
fn diff_rect(prev: &[u8], prev_stride: usize, cur: &[u8], w: usize) -> Option<[u32; 4]> {
    let h = if w > 0 { cur.len() / (w * 4) } else { 0 };
    if prev_stride < w * 4 || prev.len() < prev_stride * h || h == 0 {
        return Some([0, 0, w as u32, h as u32]);
    }
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    for y in 0..h {
        let rs = y * w * 4;
        let row = &cur[rs..rs + w * 4];
        let prow = &prev[y * prev_stride..y * prev_stride + w * 4];
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
    Some([
        min_x as u32,
        min_y as u32,
        (max_x + 1 - min_x) as u32,
        (max_y + 1 - min_y) as u32,
    ])
}

/// Run an FFI body with panic isolation — a Rust panic must never unwind
/// across the FFI boundary. Returns `default` on panic.
fn ffi<R, F>(default: R, f: F) -> R
where
    F: FnOnce() -> R,
{
    catch_unwind(AssertUnwindSafe(f)).unwrap_or(default)
}

// ── Heap: glibc trim + per-doc memory census ──
//
// This cdylib allocates through the system malloc (glibc arenas on Linux —
// Bun's mimalloc does not interpose), and the innerHtml churn pattern
// (reparse + subtree drop every tick) ratchets each thread arena to its
// high-water mark and never gives it back. malloc_trim(0) releases the
// free top to the OS, but it walks the whole arena — so the big-drop FFI
// call sites funnel through a process-wide 5s throttle.

#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Default)]
struct Mallinfo2 {
    arena: usize,
    ordblks: usize,
    smblks: usize,
    hblks: usize,
    hblkhd: usize,
    usmblks: usize,
    fsmblks: usize,
    uordblks: usize,
    fordblks: usize,
    keepcost: usize,
}

#[cfg(target_os = "linux")]
fn glibc_mallinfo() -> Mallinfo2 {
    extern "C" {
        fn mallinfo2() -> Mallinfo2;
    }
    unsafe { mallinfo2() }
}

#[cfg(target_os = "linux")]
fn trim_malloc_arena() -> c_int {
    extern "C" {
        fn malloc_trim(pad: usize) -> c_int;
    }
    unsafe { malloc_trim(0) }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static LAST_TRIM_MS: AtomicU64 = AtomicU64::new(0);

/// malloc_trim after big drops (doc rebuild/destroy, subtree clears), max
/// once per 5s process-wide. No-op off glibc.
pub(crate) fn maybe_trim_malloc() {
    #[cfg(target_os = "linux")]
    {
        let now = now_millis();
        let last = LAST_TRIM_MS.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= 5_000
            && LAST_TRIM_MS
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            trim_malloc_arena();
        }
    }
}

/// Force a glibc malloc_trim(0) on the CALLING thread's arena — invoke from
/// the thread that owns the docs (the html-ui worker). Returns glibc's
/// result (nonzero = memory released); 0 on non-Linux.
#[no_mangle]
pub unsafe extern "C" fn dd_osr_trim_memory() -> c_int {
    ffi(0, || {
        #[cfg(target_os = "linux")]
        {
            LAST_TRIM_MS.store(now_millis(), Ordering::Relaxed);
            return trim_malloc_arena();
        }
        #[cfg(not(target_os = "linux"))]
        0
    })
}

/// JSON memory snapshot for the doc — written to out_buf (same ownership
/// rules as dd_osr_get_attr; length via dd_osr_out_len). Fields: DOM census
/// (nodes/elements/textNodes), the doc's retained raster buffers
/// (pixelsLen/prevPixelsLen/sabLen), viewport px size, and on Linux the
/// process's glibc arena totals — the arena is shared by every allocation
/// in this cdylib, so those are library-not-doc numbers.
///
/// # Safety
/// `handle` must be a live OsrDoc from dd_osr_init.
#[no_mangle]
pub unsafe extern "C" fn dd_osr_memory_stats(handle: *mut OsrDoc) -> *const u8 {
    ffi(std::ptr::null(), || {
        let Some(mut g) = doc_enter(handle) else {
            return std::ptr::null();
        };
        let d = g.get();
        let doc = d.doc.inner();
        let mut nodes = 0usize;
        let mut elements = 0usize;
        let mut texts = 0usize;
        let mut node_bytes = 0usize;
        doc.visit(|_id, n| {
            nodes += 1;
            node_bytes += std::mem::size_of_val(n);
            if n.is_element() {
                elements += 1;
            } else if n.is_text_node() {
                texts += 1;
            }
        });
        let (vw, vh) = doc.viewport().window_size;
        let scratch = RASTER_SCRATCH.with(|s| s.borrow().capacity());
        let (img_entries, img_bytes, img_cap) = d.renderer.image_cache_stats();
        let (atlas_pages, atlas_w, atlas_h) = d.renderer.glyph_atlas_stats().unwrap_or((0, 0, 0));
        let mut json = format!(
            "{{\"nodes\":{nodes},\"elements\":{elements},\"textNodes\":{texts},\
             \"nodeBytes\":{node_bytes},\"pixelsLen\":{},\"prevPixelsLen\":{},\
             \"sabLen\":{},\"scratchCap\":{scratch},\"vpW\":{vw},\"vpH\":{vh},\
             \"imgCacheEntries\":{img_entries},\"imgCacheBytes\":{img_bytes},\
             \"imgCacheCap\":{img_cap},\"atlasPages\":{atlas_pages},\
             \"atlasPageW\":{atlas_w},\"atlasPageH\":{atlas_h},\
             \"atlasBytes\":{}",
            d.pixels.len(),
            d.prev_pixels.len(),
            d.frame_buf.as_ref().map(|b| b.len).unwrap_or(0),
            atlas_pages * atlas_w as usize * atlas_h as usize * 4,
        );
        #[cfg(target_os = "linux")]
        {
            let m = glibc_mallinfo();
            json += &format!(
                ",\"glibcArena\":{},\"glibcInUse\":{},\"glibcFree\":{},\
                 \"glibcMmap\":{},\"glibcKeep\":{}",
                m.arena, m.uordblks, m.fordblks, m.hblkhd, m.keepcost,
            );
        }
        json.push('}');
        d.out_buf.clear();
        d.out_buf.extend_from_slice(json.as_bytes());
        d.out_buf.as_ptr()
    })
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
///
/// # Safety
/// `html_ptr` must point to `html_len` readable bytes (UTF-8).
#[no_mangle]
pub unsafe extern "C" fn dd_osr_init(
    width: f64,
    height: f64,
    scale: f64,
    html_ptr: *const u8,
    html_len: usize,
) -> *mut OsrDoc {
    ffi(std::ptr::null_mut(), || {
        static LOG_INIT: std::sync::Once = std::sync::Once::new();
        LOG_INIT.call_once(|| {
            let _ =
                env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("off"))
                    .try_init();
        });
        let Some(html) = (unsafe { read_str(html_ptr, html_len) }) else {
            return std::ptr::null_mut();
        };
        let w = width.max(1.0) as u32;
        let h = height.max(1.0) as u32;
        let scale = if scale > 0.0 { scale as f32 } else { 1.0 };
        let redraw = Arc::new(AtomicBool::new(true));
        // Glyph atlas page side — upstream's 4096 costs 64MiB of address space
        // per page per renderer (calloc'd, but hblkhd counts it fully and the
        // page dirties as glyphs accumulate). OSR docs are UI-scale: 1024 (4MiB
        // per page) is plenty; DD_GLYPH_ATLAS_SIZE overrides for experiments.
        let atlas_size: u16 = std::env::var("DD_GLYPH_ATLAS_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .map(|v: u16| v.clamp(256, 4096))
            .unwrap_or(1024);
        let mut renderer = VelloCpuImageRenderer::with_image_cache_config(
            w,
            h,
            ImageCacheConfig {
                // OSR docs draw pre-scaled app icons only — the default 64MB
                // soft cap is per-renderer over-provisioning × N docs.
                max_bytes: 8 * 1024 * 1024,
                ..ImageCacheConfig::default()
            },
        );
        renderer.set_glyph_atlas_size(atlas_size);
        let doc = OsrDoc {
            doc: build_doc(w, h, scale, html, Arc::clone(&redraw)),
            renderer,
            pixels: Vec::new(),
            prev_pixels: Vec::new(),
            dirty_rect: [0, 0, 0, 0],
            dirty: true,
            redraw,
            stats: [0.0; 8],
            frame_buf: None,
            sab_valid: false,
            buttons: MouseEventButtons::None,
            press_node: None,
            pointer_pos: (0.0, 0.0),
            active_pointers: Arc::new(AtomicRefCell::new(Vec::new())),
            events: new_event_queue(),
            events_buf: Vec::new(),
            out_buf: Vec::new(),
            rect_buf: [0.0; 4],
            query_buf: Vec::new(),
            busy: AtomicBool::new(false),
            t0: Instant::now(),
        };
        let handle = Box::into_raw(Box::new(doc));
        match docs().and_then(|m| m.lock().ok()) {
            Some(mut reg) => {
                reg.insert(handle as usize);
                handle
            }
            // Registry unavailable — don't hand out an untracked handle.
            None => {
                drop(unsafe { Box::from_raw(handle) });
                std::ptr::null_mut()
            }
        }
    })
}

/// Replace the document's HTML content. The viewport, scale and renderer are
/// preserved; the DOM is rebuilt from scratch (Blitz has no in-place HTML
/// reparse). Marks the document dirty. Returns 0 on success.
///
/// # Safety
/// `handle` must be a live OsrDoc from dd_osr_init; `html_ptr` must point to
/// `html_len` readable bytes (UTF-8).
#[no_mangle]
pub unsafe extern "C" fn dd_osr_set_html(
    handle: *mut OsrDoc,
    html_ptr: *const u8,
    html_len: usize,
) -> c_int {
    ffi(-1, || {
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        let Some(html) = (unsafe { read_str(html_ptr, html_len) }) else {
            return -2;
        };
        let (w, h) = d.doc.inner().viewport().window_size;
        let scale = d.doc.inner().viewport().scale_f64() as f32;
        // Focus dies with the doc — emit the blur so the host's editing
        // state clears (the event queue is wiped with the rebuild, so this
        // has to go back in after the clear).
        let prev_focus = d.doc.inner().get_focussed_node_id();
        d.doc = build_doc(w, h, scale, html, Arc::clone(&d.redraw));
        d.buttons = MouseEventButtons::None;
        d.active_pointers.borrow_mut().clear();
        d.events.borrow_mut().clear();
        if let Some(f) = prev_focus {
            push_blur_event(d, f);
        }
        d.prev_pixels.clear();
        // The bound buffer still holds the last delivered (stale) frame —
        // it stays the diff reference, and a refresh may legitimately
        // republish it until the pending raster lands.
        d.dirty = true;
        maybe_trim_malloc();
        0
    })
}

/// taffy's `round_layout` snaps each border side to whole layout units via
/// `round(c + w) - round(c)`, so a sub-unit border side (a 1px border at
/// zoom 1.25 computes as 0.8px) can round to 0 depending on the node's
/// cumulative position. A zero side makes blitz-paint's corner-split math
/// divide by zero and emit NaN border paths — the adjacent edges (e.g. the
/// left border) then paint nothing. Restore any side taffy collapsed that
/// layout says is nonzero.
fn restore_collapsed_borders(doc: &mut BaseDocument) {
    let root = doc.root_element().id;
    doc.iter_subtree_mut(root, |id, doc| {
        let Some(node) = doc.get_node_mut(id) else {
            return;
        };
        let Some(ld) = node.try_layout_data_mut() else {
            return;
        };
        let ub = ld.unrounded_layout.border;
        let fb = &mut ld.final_layout.border;
        if fb.left == 0.0 && ub.left > 0.0 {
            fb.left = ub.left;
        }
        if fb.right == 0.0 && ub.right > 0.0 {
            fb.right = ub.right;
        }
        if fb.top == 0.0 && ub.top > 0.0 {
            fb.top = ub.top;
        }
        if fb.bottom == 0.0 && ub.bottom > 0.0 {
            fb.bottom = ub.bottom;
        }
    });
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
    let anim_now = d.t0.elapsed().as_secs_f64();
    let mut inner = d.doc.inner_mut();
    inner.resolve(anim_now);
    restore_collapsed_borders(&mut inner);
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
    // Diff source: a bound frame buffer already holds exactly what the host
    // last received, so it doubles as the previous-frame reference and the
    // doc needs no private copy (the SAB's only writer is write_bound_frame,
    // serialized with this call by the doc's busy flag; a freshly bound SAB
    // is zeroed, which diffs to a full frame — rebind recovery for free).
    // Docs on the pointer path (no bound buffer) keep the prev_pixels copy.
    let wu = w as usize;
    let hu = if wu > 0 { d.pixels.len() / (wu * 4) } else { 0 };
    let sab_prev = d
        .frame_buf
        .as_ref()
        .is_some_and(|b| b.len >= needed_buf_len(d));
    let rect = if sab_prev {
        let buf = d.frame_buf.as_ref().unwrap();
        let stride = align256(wu * 4);
        // SAFETY: buf.len >= FRAME_HEADER + stride*ph (needed_buf_len) and
        // ph == hu, so the pixel rows are in bounds. The SAB is stable here:
        // reads race nothing — its only writer is this thread.
        let prev = unsafe { std::slice::from_raw_parts(buf.ptr.add(FRAME_HEADER), stride * hu) };
        diff_rect(prev, stride, &d.pixels, wu)
    } else if d.prev_pixels.len() == d.pixels.len() {
        diff_rect(&d.prev_pixels, wu * 4, &d.pixels, wu)
    } else {
        Some([0, 0, w, hu as u32])
    };
    d.stats[2] = t2.elapsed().as_secs_f64() * 1000.0;
    d.stats[3] = d.pixels.len() as f64;
    match rect {
        Some(rect) => {
            d.dirty_rect = rect;
            // Retain only the changed rows — copying the whole buffer each
            // dirty frame doubles memory traffic for a small HUD update.
            // SAB-diffed docs need no copy at all: the bound buffer is the
            // reference and gets the same dirty rows in write_bound_frame.
            if !sab_prev {
                let [rx, ry, rw, rh] = rect.map(|v| v as usize);
                if d.prev_pixels.len() != d.pixels.len() {
                    d.prev_pixels.clear();
                    d.prev_pixels.extend_from_slice(&d.pixels);
                } else {
                    for row in ry..ry + rh {
                        let s = (row * wu + rx) * 4;
                        let e = s + rw * 4;
                        d.prev_pixels[s..e].copy_from_slice(&d.pixels[s..e]);
                    }
                }
            }
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
        let Some(mut g) = doc_enter(handle) else {
            return std::ptr::null();
        };
        let d = g.get();
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
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
        needed_buf_len(d)
    })
}

/// Bind a host-owned buffer (a SharedArrayBuffer on the JS side) for
/// zero-copy frame delivery. Returns 0 when the buffer is large enough for
/// the current frame size, -2 when it must be regrown.
#[no_mangle]
pub extern "C" fn dd_osr_bind_frame_buf(handle: *mut OsrDoc, ptr: *mut u8, len: usize) -> c_int {
    ffi(-1, || {
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        if ptr.is_null() || len < needed_buf_len(d) {
            return -2;
        }
        d.frame_buf = Some(BoundBuf { ptr, len, seq: 0 });
        // The bound buffer takes over as the diff reference — release the
        // private copy (a zeroed SAB diffs to a full frame, so delivery is
        // self-correcting on the next raster).
        d.prev_pixels = Vec::new();
        // A freshly bound buffer is zeroed — no delivered frame to
        // republish until the first write lands.
        d.sab_valid = false;
        0
    })
}

/// Seqlock header open: bumps seq to odd (write in flight) and writes the
/// dirty-rect/frame-geometry fields. Caller writes pixel rows (if any) then
/// calls write_bound_close to publish an even seq.
fn write_bound_header(d: &mut OsrDoc, rect: [u32; 4]) -> c_int {
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
    }
    0
}

/// Seqlock close: publishes an even seq and marks the bound buffer as
/// holding a deliverable frame (refresh_into may republish it header-only).
fn write_bound_close(d: &mut OsrDoc) {
    let Some(buf) = d.frame_buf.as_mut() else {
        return;
    };
    buf.seq = buf.seq.wrapping_add(1); // even — stable
    unsafe {
        (buf.ptr as *mut u32).write_volatile(buf.seq);
    }
    d.sab_valid = true;
}

/// Write `pixels`' dirty rect into the bound buffer (seqlock-guarded header).
/// Returns 1 on write. Pixel rows land at `stride`-byte offsets so the host
/// can upload straight out of the buffer via writeTexture(bytesPerRow).
fn write_bound_frame(d: &mut OsrDoc, rect: [u32; 4]) -> c_int {
    if write_bound_header(d, rect) != 0 {
        return -3;
    }
    let [x, y, w, h] = rect;
    let pw = d.doc.inner().viewport().window_size.0;
    let stride = align256(pw as usize * 4);
    let buf = d.frame_buf.as_mut().unwrap();
    unsafe {
        let base = buf.ptr;
        let src = d.pixels.as_ptr();
        for r in 0..h as usize {
            let src_off = ((y as usize + r) * pw as usize + x as usize) * 4;
            let dst_off = FRAME_HEADER + (y as usize + r) * stride + x as usize * 4;
            std::ptr::copy_nonoverlapping(src.add(src_off), base.add(dst_off), w as usize * 4);
        }
    }
    write_bound_close(d);
    1
}

thread_local! {
    /// Raster scratch shared by every SAB-bound doc on this thread. Docs
    /// pump sequentially, so one buffer sized to the largest frame serves
    /// all of them — retaining a private w*h*4 target per doc would idle
    /// N-1 full-frame buffers between frames. Swapped into `d.pixels` for
    /// the raster+diff+copy window only; the doc keeps it empty otherwise.
    static RASTER_SCRATCH: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Rasterize (when dirty) and copy the dirty rect into the bound buffer.
/// Returns 1 when a frame was written, 0 when nothing changed, -2 when the
/// bound buffer is too small (rebind + call dd_osr_refresh_into), -3 when no
/// buffer is bound (caller should use dd_osr_frame + copy instead).
#[no_mangle]
pub extern "C" fn dd_osr_frame_into(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        let Some(buf) = d.frame_buf.as_ref() else {
            return -3;
        };
        if buf.len < needed_buf_len(d) {
            return -2;
        }
        RASTER_SCRATCH.with(|s| {
            let mut scratch = s.borrow_mut();
            // The bound buffer is both the diff reference and the delivery
            // target, so pixels are only needed transiently — raster into
            // the shared scratch and leave d.pixels empty. The swap restores
            // it on every path (raster_if_dirty catches nothing itself, so a
            // panic lands at the ffi boundary with the scratch parked in
            // d.pixels — harmless: the next swap recovers it).
            std::mem::swap(&mut d.pixels, &mut *scratch);
            let rc = match raster_if_dirty(d) {
                Some(rect) => write_bound_frame(d, rect),
                None => 0,
            };
            std::mem::swap(&mut d.pixels, &mut *scratch);
            rc
        })
    })
}

/// Re-emit the last delivered frame into the bound buffer (no raster) — used
/// by the host to recover from a torn seqlock read or a fresh GPU texture.
/// The bound buffer already holds that frame, so this republishes the
/// seqlock header with a full-frame rect (the host's texture may have been
/// recreated since the last upload — a partial dirty rect would not cover
/// what's missing). Returns 0 when nothing was ever delivered or the
/// retained frame is stale (resize) — the pending raster owns those cases.
#[no_mangle]
pub extern "C" fn dd_osr_refresh_into(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        let Some(buf) = d.frame_buf.as_ref() else {
            return -3;
        };
        if buf.len < needed_buf_len(d) {
            return -2;
        }
        if !d.sab_valid {
            return 0;
        }
        let (pw, ph) = d.doc.inner().viewport().window_size;
        write_bound_header(d, [0, 0, pw, ph]);
        write_bound_close(d);
        1
    })
}

/// Per-frame stats: [resolve_ms, paint_ms, diff_ms, pixels_len, rasters,
/// skipped-clean rasters] — 64 bytes, pointer owned by the handle.
#[no_mangle]
pub extern "C" fn dd_osr_last_stats(handle: *mut OsrDoc) -> *const f64 {
    ffi(std::ptr::null(), || {
        let Some(mut g) = doc_enter(handle) else {
            return std::ptr::null();
        };
        let d = g.get();
        d.stats.as_ptr()
    })
}

/// Current pixel-buffer length (width*height*4) — lets the host size its
/// copy without trusting its own bookkeeping.
#[no_mangle]
pub extern "C" fn dd_osr_pixels_len(handle: *mut OsrDoc) -> usize {
    ffi(0, || {
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
        d.pixels.len()
    })
}

/// Resize the viewport. Marks the document dirty.
#[no_mangle]
pub extern "C" fn dd_osr_resize(handle: *mut OsrDoc, width: f64, height: f64, scale: f64) -> c_int {
    ffi(-1, || {
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
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
        // The bound buffer's retained frame is the old size — a refresh
        // must not republish it under the new viewport's header.
        d.sab_valid = false;
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

fn make_pointer_event(d: &OsrDoc, x: f64, y: f64, button: MouseEventButton) -> BlitzPointerEvent {
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
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        d.pointer_pos = (x, y);
        let mut event = make_pointer_event(d, x, y, dom_button(button));
        event.mods = kbt_modifiers(mods);
        // Click reconciliation applies only to main-button releases that
        // weren't scrollbar drags — checked before dispatch, which consumes
        // the drag state. `had_down` records whether a main press is still
        // outstanding (before arm 2 clears it) — a stray release must not
        // synthesize a click.
        let reconcile = kind == 2
            && event.button == MouseEventButton::Main
            && d.doc.inner().scrollbar_drag_target().is_none();
        let main_down = kind == 1 && event.button == MouseEventButton::Main;
        let events_before = if reconcile {
            d.events.borrow().len()
        } else {
            0
        };
        let had_down = reconcile && d.buttons.contains(MouseEventButtons::Primary);
        // Snapshot focus: a popped cross-subtree click may still have run
        // blitz's clear-focus default action — it gets restored after.
        let focus_before = reconcile
            .then(|| d.doc.inner().get_focussed_node_id())
            .flatten();
        // Cloned for reconcile_click — the event itself moves into ui_event.
        let up_event = reconcile.then(|| event.clone());
        let ui_event = match kind {
            1 => {
                d.buttons |= event.button.into();
                event.buttons = d.buttons;
                UiEvent::PointerDown(event)
            }
            2 => {
                // Release clears the bit — XOR would toggle it back on for a
                // button-up that never had a matching down (double-up races,
                // focus-loss sequences), leaving a phantom pressed state.
                d.buttons &= !MouseEventButtons::from(event.button);
                event.buttons = d.buttons;
                UiEvent::PointerUp(event)
            }
            _ => UiEvent::PointerMove(event),
        };
        dispatch(d, ui_event);
        if main_down {
            // Record the press target post-dispatch (layout is current now).
            // mousedown_node_id misses root-element hits; element_from_point
            // returns the root over background, so the release side can tell
            // a real press from a stray up.
            let doc = d.doc.inner();
            let scale = doc.viewport().scale_f64();
            d.press_node = doc
                .get_mousedown_node_id()
                .or_else(|| doc.element_from_point((x / scale) as f32, (y / scale) as f32));
        }
        if let Some(ev) = up_event {
            let up_node = {
                let doc = d.doc.inner();
                let scale = doc.viewport().scale_f64();
                doc.element_from_point((x / scale) as f32, (y / scale) as f32)
                    .or_else(|| doc.get_hover_node_id())
            };
            let down_node = d
                .press_node
                .or_else(|| d.doc.inner().get_mousedown_node_id());
            d.press_node = None;
            reconcile_click(
                d,
                &ev,
                events_before,
                had_down,
                focus_before,
                down_node,
                up_node,
            );
        }
        fold_redraw(d);
        0
    })
}

/// Is `anc` an ancestor-or-self of `id`?
fn subtree_contains(doc: &BaseDocument, anc: NodeId, mut id: NodeId) -> bool {
    loop {
        if id == anc {
            return true;
        }
        match doc.get_node(id).and_then(|n| n.parent) {
            Some(p) => id = p,
            None => return false,
        }
    }
}

/// Press and release landing inside the same element subtree — either
/// direction — counts as one click. Descendant-down → ancestor-up covers
/// release on a small control's own padding/children; ancestor-down →
/// descendant-up covers press on a container's bare area.
fn same_subtree(doc: &BaseDocument, a: NodeId, b: NodeId) -> bool {
    subtree_contains(doc, a, b) || subtree_contains(doc, b, a)
}

/// A click whose release landed outside the pressed node's own subtree must
/// not move DOM focus — real DOMs drive focus from pointerdown, not the
/// release — but blitz's handle_click may already have run its clear-focus
/// default action. Restore the pre-release focus, re-emitting blur/focus so
/// host-side editing state stays consistent.
fn restore_focus(d: &mut OsrDoc, focus_before: Option<NodeId>) {
    let Some(prev) = focus_before else { return };
    let moved = d.doc.inner().get_focussed_node_id();
    if moved == focus_before || d.doc.inner().get_node(prev).is_none() {
        return;
    }
    d.doc.inner_mut().set_focus_to(prev);
    emit_focus_change(d, moved);
}

/// Dispatch one DomEvent through an EventDriver so both the DOM-event queue
/// and blitz's default actions (focus changes, checkbox toggles, labels,
/// dblclick synthesis) run as they would for a natively emitted event.
fn dispatch_dom_event(d: &mut OsrDoc, event: DomEvent) {
    let mut driver = EventDriver::new(
        &mut d.doc,
        QueueingHandler {
            queue: std::rc::Rc::clone(&d.events),
        },
    );
    driver.handle_dom_event(event);
}

/// Push a serialized blur for a node that no longer exists. DomEvent
/// dispatch on a removed id would panic, but the host still needs the blur
/// to clear its editing state when a mutation drops the focused element.
pub(crate) fn push_blur_event(d: &mut OsrDoc, node: NodeId) {
    let mut q = d.events.borrow_mut();
    if q.len() >= 4096 {
        q.pop_front();
    }
    q.push_back(format!("{{\"t\":\"blur\",\"n\":{}}}", node.as_u64()));
}

/// Emit DOM blur/focus events for a focus transition that happened outside
/// the click path (programmatic dd_osr_focus, node removal). `prev` is the
/// pre-change focused node; the new focus is read from the doc. Nodes that
/// were removed get a raw JSON blur instead of a real DomEvent.
pub(crate) fn emit_focus_change(d: &mut OsrDoc, prev: Option<NodeId>) {
    let cur = d.doc.inner().get_focussed_node_id();
    if prev == cur {
        return;
    }
    if let Some(old) = prev {
        if d.doc.inner().get_node(old).is_some() {
            dispatch_dom_event(d, DomEvent::new(old, DomEventData::Blur(BlitzFocusEvent)));
            dispatch_dom_event(
                d,
                DomEvent::new(old, DomEventData::FocusOut(BlitzFocusEvent)),
            );
        } else {
            push_blur_event(d, old);
        }
    }
    if let Some(new) = cur {
        if d.doc.inner().get_node(new).is_some() {
            dispatch_dom_event(d, DomEvent::new(new, DomEventData::Focus(BlitzFocusEvent)));
            dispatch_dom_event(
                d,
                DomEvent::new(new, DomEventData::FocusIn(BlitzFocusEvent)),
            );
        }
    }
}

/// Releases that drift off the pressed element onto an ancestor by less than
/// this many logical px are treated as click jitter and retargeted to the
/// pressed node. Bigger outward drifts keep the browser-like outcome — the
/// click lands on the ancestor container itself.
const RELEASE_JITTER_PX: f32 = 8.0;

/// Node border-box rect in document space: [x, y, w, h], matching
/// PointerCoords.page_x/page_y.
fn node_page_rect(doc: &BaseDocument, id: NodeId) -> Option<[f32; 4]> {
    let node = doc.get_node(id)?;
    let pos = node.unrounded_absolute_position(0.0, 0.0);
    let size = node.final_layout().size;
    Some([
        pos.x as f32,
        pos.y as f32,
        size.width as f32,
        size.height as f32,
    ])
}

/// Drop `click`/`dblclick` events this dispatch pushed onto the queue — used
/// when the native click's target (or existence) is being overridden.
fn pop_queued_clicks(d: &mut OsrDoc, events_before: usize) {
    let mut q = d.events.borrow_mut();
    let mut i = events_before;
    while i < q.len() {
        let s = &q[i];
        if s.starts_with("{\"t\":\"click\"") || s.starts_with("{\"t\":\"dblclick\"") {
            q.remove(i);
        } else {
            i += 1;
        }
    }
}

/// Post-dispatch click reconciliation for main-button releases.
///
/// Blitz gates `click` on `drag_mode == None`: >2px of pointer travel during
/// a press enters `Selecting` and eats the click entirely — real-world
/// mouse jitter — including the focus-clearing default action. And when no
/// drag mode starts (e.g. the pressed node has user-select:none) it emits
/// the click on the release node even when the press began on a different
/// element, so a press-drag-release onto another control activates it.
///
/// Policy here follows nearest-common-ancestor click semantics: a click is
/// synthesized iff a main-button press was outstanding and press and release
/// hit the same element subtree. When the press node contains the release
/// (press on chrome, release on a child control), the click targets the
/// PRESS node — controls don't activate for gestures that started outside
/// them. When the release lands on an ancestor of the press (a jittered
/// release just outside a small control's border), it retargets to the press
/// node within RELEASE_JITTER_PX; further out it's a genuine container
/// click. Releases on unrelated subtrees — or with no press at all — drop
/// the click entirely.
fn reconcile_click(
    d: &mut OsrDoc,
    event: &BlitzPointerEvent,
    events_before: usize,
    had_down: bool,
    focus_before: Option<NodeId>,
    down: Option<NodeId>,
    up: Option<NodeId>,
) {
    let emitted = {
        let q = d.events.borrow();
        (events_before..q.len()).any(|i| q[i].starts_with("{\"t\":\"click\""))
    };
    let related = had_down
        && match (down, up) {
            (Some(a), Some(b)) => same_subtree(&d.doc.inner(), a, b),
            _ => false,
        };
    // The release-side focus move blitz may have applied is only undone when
    // the press began inside the element that held focus (dragging out of a
    // focused input keeps it focused in a real DOM) — or when there was no
    // press at all (stray release). A press that started outside the focused
    // node legitimately steals focus, like mousedown does in a real DOM.
    let press_in_focused = match (down, focus_before) {
        (Some(dn), Some(f)) => subtree_contains(&d.doc.inner(), dn, f),
        _ => false,
    };
    let undo_focus = down.is_none() || press_in_focused;

    if related {
        let (down, up) = (down.unwrap(), up.unwrap());
        // Release strictly on an ancestor of the press: jitter forgiveness
        // retargets to the press node when the release point is near its
        // rect; a far release clicks the ancestor itself.
        let released_onto_ancestor = !subtree_contains(&d.doc.inner(), down, up);
        let near_press = released_onto_ancestor
            && node_page_rect(&d.doc.inner(), down).is_some_and(|r| {
                let px = event.coords.page_x;
                let py = event.coords.page_y;
                px >= r[0] - RELEASE_JITTER_PX
                    && px <= r[0] + r[2] + RELEASE_JITTER_PX
                    && py >= r[1] - RELEASE_JITTER_PX
                    && py <= r[1] + r[3] + RELEASE_JITTER_PX
            });
        let target = if released_onto_ancestor && !near_press {
            up
        } else {
            down
        };
        if target == up {
            // Suppressed-by-drag clicks on the right target get re-fired;
            // emitted ones stand.
            if !emitted {
                dispatch_dom_event(d, DomEvent::new(up, DomEventData::Click(event.clone())));
            }
        } else {
            // Retarget: drop the emitted ancestor/release-node click, then
            // dispatch the click on the press node — its default action also
            // settles focus the way mousedown semantics dictate.
            if emitted {
                pop_queued_clicks(d, events_before);
            }
            dispatch_dom_event(d, DomEvent::new(down, DomEventData::Click(event.clone())));
        }
        // A far release onto an ancestor still cleared focus through the
        // kept ancestor click — restore it for drag-outs that began inside
        // the focused element.
        if released_onto_ancestor && !near_press && undo_focus {
            restore_focus(d, focus_before);
        }
    } else {
        // Unrelated subtrees or a release with no press at all: the emitted
        // click (and the dblclick it may have spawned) is void.
        if emitted {
            pop_queued_clicks(d, events_before);
        }
        if undo_focus {
            restore_focus(d, focus_before);
        }
    }
}

/// Wheel event at the last pointer position. Deltas are in pixels using
/// Blitz/winit semantics (+y = scroll up); the JS wrapper negates DOM
/// WheelEvent deltas before crossing the FFI.
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
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
        // set_hover_to hit-tests — resolve first so a pending mutation's
        // stale layout/paint child lists can't panic the descent.
        resolve_pending_damage(d);
        let coords = pointer_coords(d, x, y);
        // The driver resolves a wheel's scroll target from hover_node_id,
        // which only moves with pointer events — a parked mouse (or a hover
        // node that was retargeted after DOM edits) leaves the target stale,
        // and a fresh session has no hover at all; either way the wheel
        // strands on the root viewport and nothing visibly scrolls.
        // Re-hit-test at the event's own coords first, matching browsers.
        d.doc.inner_mut().set_hover_to(coords.page_x, coords.page_y);
        let event = BlitzWheelEvent {
            delta: BlitzWheelDelta::Pixels(delta_x, delta_y),
            coords,
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
///
/// # Safety
/// `handle` must be a live OsrDoc; the `key`/`code`/`text` pointer+len pairs
/// must point to readable UTF-8 bytes.
#[no_mangle]
pub unsafe extern "C" fn dd_osr_key(
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
        let Some(mut g) = doc_enter(handle) else {
            return -1;
        };
        let d = g.get();
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
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
        // element_from_point hit-tests — resolve first so a pending
        // mutation's stale layout/paint child lists can't panic the descent.
        resolve_pending_damage(d);
        let doc = d.doc.inner();
        let scale = doc.viewport().scale_f64();
        let lx = (x / scale) as f32;
        let ly = (y / scale) as f32;
        let mut id = doc.element_from_point(lx, ly);
        while let Some(node_id) = id {
            let Some(node) = doc.get_node(node_id) else {
                break;
            };
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
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
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
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
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
        let Some(mut g) = doc_enter(handle) else {
            return std::ptr::null();
        };
        let d = g.get();
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
        let Some(mut g) = doc_enter(handle) else {
            return 0;
        };
        let d = g.get();
        d.events_buf.len()
    })
}

/// Register a process-wide `ui://` resource (fonts, images, stylesheets)
/// served to every document's NetProvider. Copy semantics — safe to reuse
/// the caller's buffer after return.
///
/// # Safety
/// `url_ptr`/`bytes_ptr` must point to `url_len`/`bytes_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn dd_osr_register_resource(
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

/// # Safety
/// `handle` must be a live OsrDoc from dd_osr_init, and must not be used
/// after this call.
#[no_mangle]
pub unsafe extern "C" fn dd_osr_destroy(handle: *mut OsrDoc) -> c_int {
    ffi(-1, || {
        if handle.is_null() {
            return -1;
        }
        let key = handle as usize;
        let Some(reg_mutex) = docs() else { return -1 };
        let mut reg = match reg_mutex.lock() {
            Ok(r) => r,
            Err(_) => return -1,
        };
        if !reg.contains(&key) {
            return -1; // stale or double destroy — never touch the memory
        }
        // Claim the doc while still holding the registry lock: a thread that
        // passed doc_enter earlier is either holding busy (we spin for it —
        // FFI calls are µs-scale) or can no longer get in.
        let d = unsafe { &*handle };
        let mut spins = 0u32;
        while d.busy.swap(true, Ordering::Acquire) {
            spins += 1;
            if spins > 100_000 {
                // A caller is stuck inside the doc — refuse to free live
                // memory. -2 = "busy"; the host may retry.
                return -2;
            }
            std::hint::spin_loop();
        }
        reg.remove(&key);
        drop(reg);
        drop(unsafe { Box::from_raw(handle) });
        maybe_trim_malloc();
        0
    })
}
