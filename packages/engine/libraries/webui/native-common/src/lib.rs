//! downdraft-webui-common — shared machinery for the webui cdylibs.
//!
//! Both backends (CEF on desktop, WPE on linux/android) expose the same
//! `dd_webui_*` C ABI. Everything that doesn't depend on the browser engine
//! lives here:
//!
//! - `FrameBuf` — 4-byte-per-pixel frame storage with a dirty-rect union,
//!   plus the SAB-bound zero-copy channel (the same 64-byte seqlock header
//!   contract blitz-osr's `dd_osr_bind_frame_buf` uses, so host-side readers
//!   stay interchangeable).
//! - `EventQueue` — JSON event batches drained by `dd_webui_poll_events`.
//! - `Registry` — live-handle table + busy claim: FFI entry points hold
//!   exclusive access so a host can't alias `&mut` across threads (the
//!   `OsrDoc` DOCS-registry semantics from blitz-osr).
//! - `Rect` — pixel-space rect + the packed-u64 ABI encoding
//!   (x<<48|y<<32|w<<16|h — same packing `dd_osr_frame_rect` uses).

use std::collections::HashSet;
use std::os::raw::c_int;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Rect
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default, Debug)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    pub fn union(self, o: Rect) -> Rect {
        if self.is_empty() {
            return o;
        }
        if o.is_empty() {
            return self;
        }
        let x0 = self.x.min(o.x);
        let y0 = self.y.min(o.y);
        let x1 = (self.x + self.w).max(o.x + o.w);
        let y1 = (self.y + self.h).max(o.y + o.h);
        Rect::new(x0, y0, x1 - x0, y1 - y0)
    }

    /// Intersect with the frame bounds — clamps out-of-range source rects.
    pub fn clipped(&self, w: u32, h: u32) -> Option<Rect> {
        let x0 = self.x.min(w);
        let y0 = self.y.min(h);
        let x1 = (self.x + self.w).min(w);
        let y1 = (self.y + self.h).min(h);
        (x1 > x0 && y1 > y0).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0))
    }

    /// Packed u64 for the `dd_webui_frame_rect` ABI:
    /// x<<48 | y<<32 | w<<16 | h (same encoding `dd_osr_frame_rect` uses).
    pub fn packed_u64(&self) -> u64 {
        ((self.x as u64) << 48)
            | ((self.y as u64) << 32)
            | ((self.w as u64) << 16)
            | (self.h as u64)
    }
}

// ---------------------------------------------------------------------------
// FrameBuf
// ---------------------------------------------------------------------------

pub const FRAME_HEADER: usize = 64;

fn align256(n: usize) -> usize {
    (n + 255) & !255
}

/// Host-shared frame buffer bound via `dd_webui_bind_frame_buf`. The host
/// owns the underlying SharedArrayBuffer; we only hold a raw pointer.
/// Layout (u32 fields): [seq][x][y][w][h][pw][ph][flags][stride][reserved..]
/// then pixel rows at `stride` bytes each, starting at byte 64. `seq` is a
/// seqlock: odd while a write is in flight, even when stable — identical to
/// the blitz-osr bound-buffer contract.
struct BoundBuf {
    ptr: *mut u8,
    len: usize,
    seq: u32,
}
unsafe impl Send for BoundBuf {}
unsafe impl Sync for BoundBuf {}

/// 4-byte-per-pixel frame storage produced by the browser engine.
///
/// Sources (`OnPaint` rows, `WPEBuffer` pixel imports) write via
/// `write_rows` and mark `dirty`; the host pulls the full buffer + union
/// rect (`take`) or the dirty region into a bound SAB (`frame_into`).
/// Pixel order (RGBA vs BGRA) is the backend's problem — this type is
/// format-agnostic and `pixel_format` only advertises what it holds.
pub struct FrameBuf {
    pixels: Vec<u8>,
    pub w: u32,
    pub h: u32,
    /// Union of writes since the last take/frame_into. `None` = clean.
    dirty: Option<Rect>,
    /// Rect of the last frame `take`/`frame_into` produced — what
    /// `dd_webui_frame_rect` reports (peek would always see `None` right
    /// after a pull consumed the union).
    last: Option<Rect>,
    /// 0 = RGBA, 1 = BGRA (both CEF and WPE produce BGRA natively).
    pub pixel_format: u8,
    bound: Option<BoundBuf>,
    /// Ever painted at least once — pending() reports false until the
    /// first frame lands so hosts don't see "clean" before any paint.
    painted: bool,
}

impl FrameBuf {
    pub fn new(w: u32, h: u32, pixel_format: u8) -> Self {
        Self {
            pixels: vec![0u8; w as usize * h as usize * 4],
            w,
            h,
            dirty: None,
            last: None,
            pixel_format,
            bound: None,
            painted: false,
        }
    }

    /// Reallocate for a new size. Marks the whole frame dirty.
    pub fn resize(&mut self, w: u32, h: u32) {
        if self.w == w && self.h == h {
            return;
        }
        self.w = w;
        self.h = h;
        self.pixels = vec![0u8; w as usize * h as usize * 4];
        self.painted = false;
        self.last = None;
        self.dirty = Some(Rect::new(0, 0, w, h));
    }

    /// Copy `src` rows for `rect` into the buffer (source may have a
    /// different stride). Accumulates the dirty union.
    pub fn write_rows(&mut self, rect: Rect, src: &[u8], src_stride: usize) {
        let Some(rect) = rect.clipped(self.w, self.h) else {
            return;
        };
        let dst_stride = self.w as usize * 4;
        let need = src_stride.saturating_mul((rect.h as usize).saturating_sub(1))
            + rect.w as usize * 4;
        if src.len() < need {
            return;
        }
        for r in 0..rect.h as usize {
            let dst_off = (rect.y as usize + r) * dst_stride + rect.x as usize * 4;
            let src_off = r * src_stride;
            let len = rect.w as usize * 4;
            self.pixels[dst_off..dst_off + len].copy_from_slice(&src[src_off..src_off + len]);
        }
        self.painted = true;
        self.dirty = Some(match self.dirty {
            Some(d) => d.union(rect),
            None => rect,
        });
    }

    /// Mark the whole frame dirty (first paint, resize, full invalidate).
    pub fn mark_all_dirty(&mut self) {
        if self.w > 0 && self.h > 0 {
            self.dirty = Some(Rect::new(0, 0, self.w, self.h));
        }
    }

    /// True when a write happened since the last take (or the first paint
    /// is still pending).
    pub fn pending(&self) -> bool {
        self.dirty.is_some()
    }

    /// At least one frame has been written into the buffer.
    pub fn painted(&self) -> bool {
        self.painted
    }

    /// Pull the frame: returns (pixels, dirty-union) once and clears the
    /// flag. `None` when nothing changed — and also while `painted` is
    /// false: resize() marks the fresh buffer all-dirty, but those pixels
    /// are zeros, so handing them out flashes black between the resize and
    /// the browser's first real repaint. Hosts keep the last real frame
    /// (stretched into the new rect) until a write lands instead.
    pub fn take(&mut self) -> Option<(&[u8], Rect)> {
        if !self.painted {
            return None;
        }
        let dirty = self.dirty.take()?;
        self.last = Some(dirty);
        Some((&self.pixels, dirty))
    }

    /// Peek without clearing — used by `dd_webui_pixels_len` and the
    /// refresh path.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Rect of the frame the last `take`/`frame_into` produced —
    /// `dd_webui_frame_rect` reports this (mirroring the "rect of the
    /// frame pullFrame just produced" contract).
    pub fn last_rect(&self) -> Option<Rect> {
        self.last
    }

    // ── SAB-bound zero-copy channel ──

    /// Bytes the bound buffer must hold at the current size:
    /// 64-byte header + 256-aligned pixel rows for a full frame.
    pub fn buf_needed(&self) -> usize {
        FRAME_HEADER + align256(self.w as usize * 4) * self.h as usize
    }

    /// Bind a host-owned buffer as the frame staging target.
    pub fn bind(&mut self, ptr: *mut u8, len: usize) -> bool {
        if len < self.buf_needed() {
            self.bound = None;
            return false;
        }
        self.bound = Some(BoundBuf { ptr, len, seq: 0 });
        true
    }

    /// Current bound-buffer pointer (for diagnostics).
    pub fn bound(&self) -> bool {
        self.bound.is_some()
    }

    /// Copy the dirty union into the bound buffer. Returns:
    ///   1 = frame written, 0 = nothing new, -2 = buffer too small,
    ///  -3 = unbound, -4 = nothing painted yet.
    /// `refresh = true` re-emits the whole frame regardless of dirty state.
    pub fn frame_into(&mut self, refresh: bool) -> c_int {
        if self.bound.is_none() {
            return -3;
        }
        if self.buf_needed() > self.bound.as_ref().unwrap().len {
            return -2;
        }
        if !self.painted {
            return -4;
        }
        let dirty = if refresh {
            Rect::new(0, 0, self.w, self.h)
        } else {
            match self.dirty.take() {
                Some(d) => d,
                None => return 0,
            }
        };
        self.last = Some(dirty);
        self.write_bound(dirty, refresh);
        1
    }

    /// Header (u32): [seq][x][y][w][h][pw][ph][flags][stride][reserved..64].
    /// flags bit0 = full-frame refresh.
    fn write_bound(&mut self, dirty: Rect, refresh: bool) {
        let (pw, ph) = (self.w, self.h);
        let stride = align256(pw as usize * 4);
        let bound = self.bound.as_mut().unwrap();
        bound.seq = bound.seq.wrapping_add(1); // odd — write in flight
        unsafe {
            let base = bound.ptr;
            std::ptr::write_volatile(base as *mut u32, bound.seq);
            (base.add(4) as *mut u32).write_volatile(dirty.x);
            (base.add(8) as *mut u32).write_volatile(dirty.y);
            (base.add(12) as *mut u32).write_volatile(dirty.w);
            (base.add(16) as *mut u32).write_volatile(dirty.h);
            (base.add(20) as *mut u32).write_volatile(pw);
            (base.add(24) as *mut u32).write_volatile(ph);
            (base.add(28) as *mut u32).write_volatile(if refresh { 1 } else { 0 });
            (base.add(32) as *mut u32).write_volatile(stride as u32);
            let dst_stride = self.w as usize * 4;
            for r in 0..dirty.h as usize {
                let src_off = (dirty.y as usize + r) * dst_stride + dirty.x as usize * 4;
                let dst_off = FRAME_HEADER + (dirty.y as usize + r) * stride + dirty.x as usize * 4;
                let len = dirty.w as usize * 4;
                std::ptr::copy_nonoverlapping(
                    self.pixels[src_off..src_off + len].as_ptr(),
                    base.add(dst_off),
                    len,
                );
            }
            std::sync::atomic::fence(Ordering::Release);
            bound.seq = bound.seq.wrapping_add(1); // even — stable
            std::ptr::write_volatile(base as *mut u32, bound.seq);
        }
    }
}

// ---------------------------------------------------------------------------
// EventQueue
// ---------------------------------------------------------------------------

/// JSON event batch drained by `dd_webui_poll_events`. Producers push
/// complete JSON object literals (`{"t":"message","v":...}`); take()
/// serializes the batch into a single JSON array held in `out` so the FFI
/// layer can hand back (ptr, len) into an owned buffer.
#[derive(Default)]
pub struct EventQueue {
    events: Vec<String>,
    out: Vec<u8>,
}

impl EventQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a complete JSON object literal. Callers must build valid JSON —
    /// use `json_escape` for strings.
    pub fn push(&mut self, json: String) {
        self.events.push(json);
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Drain into the owned output buffer; returns None when empty.
    /// The returned slice stays valid until the next take().
    pub fn take(&mut self) -> Option<&[u8]> {
        if self.events.is_empty() {
            return None;
        }
        let mut s = String::with_capacity(2 + self.events.iter().map(|e| e.len() + 1).sum::<usize>());
        s.push('[');
        for (i, e) in self.events.drain(..).enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&e);
        }
        s.push(']');
        self.out = s.into_bytes();
        Some(&self.out)
    }
}

/// Escape a string for inclusion in a JSON string literal (no quotes).
pub fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
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
    out
}

/// Convenience: `{"t":"message","v":<json literal>}` — `v` is pre-serialized.
pub fn ev_message(v_json: &str) -> String {
    format!("{{\"t\":\"message\",\"v\":{v_json}}}")
}

/// Convenience: `{"t":"eval","id":N,"ok":0|1,"v":"..."}`.
pub fn ev_eval(id: u64, ok: bool, v: &str) -> String {
    format!(
        "{{\"t\":\"eval\",\"id\":{id},\"ok\":{},\"v\":\"{}\"}}",
        if ok { 1 } else { 0 },
        json_escape(v)
    )
}

/// Convenience: `{"t":"console","lvl":N,"v":"..."}`.
pub fn ev_console(level: i32, v: &str) -> String {
    format!("{{\"t\":\"console\",\"lvl\":{level},\"v\":\"{}\"}}", json_escape(v))
}

/// Convenience: `{"t":"cursor","v":"..."}` (CSS cursor name).
pub fn ev_cursor(v: &str) -> String {
    format!("{{\"t\":\"cursor\",\"v\":\"{}\"}}", json_escape(v))
}

/// Convenience: `{"t":"status","v":"..."}` (running/crashed/recovering/failed).
pub fn ev_status(v: &str) -> String {
    format!("{{\"t\":\"status\",\"v\":\"{}\"}}", json_escape(v))
}

// ---------------------------------------------------------------------------
// ViewCore — the backend-independent half of a view
// ---------------------------------------------------------------------------

/// Status codes reported by `dd_webui_status` (mirrors OSRStatus).
pub const STATUS_RUNNING: i32 = 0;
pub const STATUS_CRASHED: i32 = 1;
pub const STATUS_RECOVERING: i32 = 2;
pub const STATUS_FAILED: i32 = 3;

/// Everything a `dd_webui_*` view needs that isn't browser-specific. Each
/// backend's view struct embeds this (as `core`) — the FFI layer claims it
/// through `Registry` using `core.busy`, and frame/event plumbing routes
/// through `core.frame` / `core.events` regardless of engine.
pub struct ViewCore {
    pub frame: FrameBuf,
    pub events: EventQueue,
    /// Registry busy flag — see `Registry::claim`.
    pub busy: AtomicBool,
    /// STATUS_* — backends set this on renderer-process crash etc.
    pub status: i32,
    /// Pointer/keyboard input gate (host-side focus + interactivity switch).
    pub interactive: bool,
    /// View opacity — 1.0 default; composited panels premultiply.
    pub opacity: f32,
    pub crash_count: usize,
    /// -1 = keep retrying forever; N = give up → STATUS_FAILED after N.
    pub max_crash_retries: i32,
}

impl ViewCore {
    pub fn new(w: u32, h: u32, pixel_format: u8) -> Self {
        Self {
            frame: FrameBuf::new(w, h, pixel_format),
            events: EventQueue::new(),
            busy: AtomicBool::new(false),
            status: STATUS_RUNNING,
            interactive: true,
            opacity: 1.0,
            crash_count: 0,
            max_crash_retries: -1,
        }
    }

    /// Record a renderer crash; returns the new status. `max_crash_retries`
    /// reached → FAILED; otherwise RECOVERING (backends then respawn).
    pub fn record_crash(&mut self) -> i32 {
        self.crash_count += 1;
        self.status = if self.max_crash_retries >= 0
            && self.crash_count > self.max_crash_retries as usize
        {
            STATUS_FAILED
        } else {
            STATUS_RECOVERING
        };
        self.events.push(ev_status(match self.status {
            STATUS_FAILED => "failed",
            _ => "recovering",
        }));
        self.status
    }
}

// ---------------------------------------------------------------------------
// Registry — live handles + busy claims
// ---------------------------------------------------------------------------

/// A live-handle table for one backend's views. Mirrors the blitz-osr DOCS
/// registry: handles are registered on create and removed *before* the view
/// is freed, so FFI entry points can distinguish a live handle from a stale
/// pointer without dereferencing it. The busy flag is claimed under the
/// registry lock so contains→claim is atomic against destroy.
pub struct Registry {
    live: Mutex<HashSet<usize>>,
}

pub struct Registration {
    pub busy: AtomicBool,
}

impl Registry {
    fn global() -> &'static Registry {
        static REG: OnceLock<Registry> = OnceLock::new();
        REG.get_or_init(|| Registry {
            live: Mutex::new(HashSet::new()),
        })
    }

    pub fn register(handle: usize) {
        if let Ok(mut live) = Self::global().live.lock() {
            live.insert(handle);
        }
    }

    pub fn unregister(handle: usize) {
        if let Ok(mut live) = Self::global().live.lock() {
            live.remove(&handle);
        }
    }

    /// Contains-check + busy-claim, atomic under the registry lock.
    /// Returns the view's Registration when live-and-free.
    ///
    /// # Safety
    /// `handle` must be null or a live, registered view pointer. A live
    /// handle's view can't be freed while the registry lock is held, so
    /// the deref is sound once the contains-check passes.
    pub unsafe fn claim<T>(handle: *mut T, busy_of: impl Fn(&T) -> &AtomicBool) -> bool {
        if handle.is_null() {
            return false;
        }
        let Ok(live) = Self::global().live.lock() else {
            return false;
        };
        if !live.contains(&(handle as usize)) {
            return false;
        }
        // Safe under the lock: a live handle's view can't be freed here —
        // destroy unregisters first, then waits for busy to clear.
        let busy = busy_of(&*handle);
        !busy.swap(true, Ordering::Acquire)
    }

    /// # Safety
    /// `handle` must be null or a live, registered view pointer.
    pub unsafe fn release<T>(handle: *mut T, busy_of: impl Fn(&T) -> &AtomicBool) {
        if handle.is_null() {
            return;
        }
        busy_of(&*handle).store(false, Ordering::Release);
    }

    /// Destroy-side wait: after unregister, spin until in-flight calls exit.
    ///
    /// # Safety
    /// `handle` must be a view pointer whose memory stays live for the
    /// duration of the spin — call it before freeing the view.
    pub unsafe fn wait_free<T>(handle: *mut T, busy_of: impl Fn(&T) -> &AtomicBool) {
        Self::unregister(handle as usize);
        // Bounded spin — a wedged FFI call shouldn't hang shutdown forever.
        for _ in 0..10_000 {
            if !busy_of(&*handle).load(Ordering::Acquire) {
                return;
            }
            std::hint::spin_loop();
        }
    }
}
