//! libdowndraft_webui_wpe — WPE (embedded WebKit) backend behind the shared
//! `dd_webui_*` ABI (see packages/engine/libraries/webui/README.md and
//! native-common/src/lib.rs). Covers linux (dev/testing) and android.
//!
//! Phase-0 scaffold: the ABI surface is complete and the View skeleton is
//! wired through the shared registry; `dd_webui_create` returns null until
//! the WPE runtime lands (Phase 2 — see scripts/build-wpe.sh).

#![allow(non_snake_case)]

use downdraft_webui_common as common;
use common::{EventQueue, FrameBuf, Rect, Registry, ViewCore};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const BACKEND: &[u8] = b"wpe\0";

// ---------------------------------------------------------------------------
// Panic-safe FFI — mirrors the blitz-osr ftry! pattern
// ---------------------------------------------------------------------------

macro_rules! ftry {
    ($fail:expr, $body:block) => {
        match catch_unwind(AssertUnwindSafe(|| $body)) {
            Ok(v) => v,
            Err(_) => $fail,
        }
    };
}

unsafe fn cstr<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

// ---------------------------------------------------------------------------
// Global state — global_init creates the WPEDisplay + GMainLoop thread
// ---------------------------------------------------------------------------

static INITIALIZED: AtomicBool = AtomicBool::new(false);
// Parsed global-init options (wpePrefix, cachePath, headless, …) stashed
// here once a real option parser exists (Phase 2).
#[allow(dead_code)]
static INIT_OPTS: Mutex<String> = Mutex::new(String::new());

// ---------------------------------------------------------------------------
// View — backend state + the shared core (frame buf, events, busy claim)
// ---------------------------------------------------------------------------

struct View {
    core: ViewCore,
    // WPEView/WPEToplevel + the buffer-rendered callback land here in
    // Phase 2 — buffer pixels import into core.frame.write_rows.
    _engine: (),
}

fn busy_of(v: &View) -> &AtomicBool {
    &v.core.busy
}

/// Claim the view for an FFI call: `Some(View)` → body → release → result.
/// `$fail` is the "handle not live/busy" return value.
macro_rules! with_view {
    ($h:expr, $fail:expr, |$v:ident| $body:expr) => {{
        let h = $h as *mut View;
        if !Registry::claim(h, busy_of) {
            return $fail;
        }
        let $v = unsafe { &mut *h };
        let r = $body;
        Registry::release(h, busy_of);
        r
    }};
}

// ---------------------------------------------------------------------------
// ABI — lifecycle
// ---------------------------------------------------------------------------

/// opts_json: {"wpePrefix": "...", "cachePath": "...", "userAgent": "...",
/// "headless": bool, "remoteDebugPort": n, "platformModule": "..."}
#[no_mangle]
pub extern "C" fn dd_webui_global_init(opts_json: *const c_char) -> c_int {
    ftry!(-1, {
        if INITIALIZED.swap(true, Ordering::AcqRel) {
            return 0; // already up
        }
        let _opts = unsafe { cstr(opts_json) }.unwrap_or("{}");
        if let Ok(mut o) = INIT_OPTS.lock() {
            *o = _opts.to_string();
        }
        // Phase 2: wpe_display_headless_new() + g_main_loop on a worker
        // thread; on android, WPEProcessManager::bindService wiring.
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_global_shutdown() {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if INITIALIZED.swap(false, Ordering::AcqRel) {
            // Phase 2: quit the GMainLoop, join the thread, disconnect the
            // WPEDisplay — all views must be destroyed first.
        }
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_backend() -> *const c_char {
    BACKEND.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn dd_webui_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "-stub\0").as_ptr().cast()
}

/// opts_json: {"url","html","transparent","interactive","userAgent","frameRate"}
/// Returns null while the WPE runtime is unstaged.
#[no_mangle]
pub extern "C" fn dd_webui_create(
    _opts_json: *const c_char,
    _width: c_int,
    _height: c_int,
    _scale: f32,
) -> *mut c_void {
    ftry!(ptr::null_mut(), {
        if !INITIALIZED.load(Ordering::Acquire) {
            return ptr::null_mut();
        }
        // Phase 2: WebKitWebView(display=WPEDisplayHeadless) +
        // WPEView sized w*scale × h*scale; buffer-rendered →
        // wpe_buffer_import_to_pixels → core.frame.write_rows;
        // wpe_view_buffer_released is mandatory or frames stop.
        ptr::null_mut()
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_destroy(h: *mut c_void) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let v = h as *mut View;
        if v.is_null() {
            return;
        }
        Registry::wait_free(v, busy_of);
        drop(unsafe { Box::from_raw(v) });
    }));
}

// ---------------------------------------------------------------------------
// ABI — navigation / content
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn dd_webui_load_url(h: *mut c_void, url: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let _ = (v, unsafe { cstr(url) });
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_content(h: *mut c_void, html: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let _ = (v, unsafe { cstr(html) });
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_resize(h: *mut c_void, w: c_int, hgt: c_int, scale: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let _ = (v, w, hgt, scale);
        });
    }));
}

/// op: 0=back 1=forward 2=reload 3=stop
#[no_mangle]
pub extern "C" fn dd_webui_navigate(h: *mut c_void, _op: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_zoom(h: *mut c_void, _factor: f64) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_focus(h: *mut c_void, _focused: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_interactive(h: *mut c_void, on: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            v.core.interactive = on != 0;
        });
    }));
}

// ---------------------------------------------------------------------------
// ABI — JS bridge
// ---------------------------------------------------------------------------

/// Fire-and-forget eval; the result arrives as {"t":"eval","id":req,"ok","v"}.
#[no_mangle]
pub extern "C" fn dd_webui_eval(h: *mut c_void, req: u64, js: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let _ = (v, req, unsafe { cstr(js) });
            // Phase 2: webkit_web_view_evaluate_javascript → GAsyncResult
            // → common::ev_eval with the JSON-serialized JSCValue.
        });
    }));
}

/// Deliver a JSON message to the page's `window.downdraft` bridge.
#[no_mangle]
pub extern "C" fn dd_webui_post_message(h: *mut c_void, json: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let _ = (v, unsafe { cstr(json) });
        });
    }));
}

/// Drain queued events as one JSON array. (ptr,len) stay valid until the
/// next call on this view. Returns 1 when a batch was written.
#[no_mangle]
pub extern "C" fn dd_webui_poll_events(
    h: *mut c_void,
    out_ptr: *mut *const u8,
    out_len: *mut usize,
) -> c_int {
    ftry!(0, {
        unsafe {
            if !out_ptr.is_null() {
                *out_ptr = ptr::null();
            }
            if !out_len.is_null() {
                *out_len = 0;
            }
        }
        with_view!(h, 0, |v| {
            if let Some(buf) = v.core.events.take() {
                unsafe {
                    *out_ptr = buf.as_ptr();
                    *out_len = buf.len();
                }
                1
            } else {
                0
            }
        })
    })
}

// ---------------------------------------------------------------------------
// ABI — input
// ---------------------------------------------------------------------------

/// t: 0=move 1=down 2=up 3=leave. btn: 0=none 1=left 2=middle 3=right.
#[no_mangle]
pub extern "C" fn dd_webui_input_pointer(h: *mut c_void, _t: c_int, _x: f32, _y: f32, _btn: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_input_wheel(h: *mut c_void, _x: f32, _y: f32, _dx: f32, _dy: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

/// t: 0=down 1=up. mods bitmask: 1=shift 2=ctrl 4=alt 8=meta.
#[no_mangle]
pub extern "C" fn dd_webui_input_key(
    h: *mut c_void,
    _t: c_int,
    _key: *const c_char,
    _code: *const c_char,
    _text: *const c_char,
    _mods: c_int,
    _repeat: c_int,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

/// t: 0=down 1=move 2=up 3=cancel.
#[no_mangle]
pub extern "C" fn dd_webui_input_touch(h: *mut c_void, _t: c_int, _id: c_int, _x: f32, _y: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

/// t: 0=preedit 1=commit 2=cancel. IME plumbing lands in Phase 6.
#[no_mangle]
pub extern "C" fn dd_webui_input_ime(h: *mut c_void, _t: c_int, _s: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {});
    }));
}

// ---------------------------------------------------------------------------
// ABI — frames
// ---------------------------------------------------------------------------

/// Dirty union as packed u64 (x<<48|y<<32|w<<16|h) — clears the pending
/// flag. 0 = no new frame.
#[no_mangle]
pub extern "C" fn dd_webui_take_frame(h: *mut c_void) -> u64 {
    ftry!(0, {
        with_view!(h, 0, |v| {
            v.core
                .frame
                .take()
                .map(|(_, r)| r.packed_u64())
                .unwrap_or(0)
        })
    })
}

/// Same packing as take_frame but does NOT clear — peek for the rect pull.
#[no_mangle]
pub extern "C" fn dd_webui_frame_rect(h: *mut c_void) -> u64 {
    ftry!(0, {
        with_view!(h, 0, |v| {
            let d = v.core.frame.peek_dirty();
            d.map(|r| r.packed_u64()).unwrap_or(0)
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_frame_pending(h: *mut c_void) -> c_int {
    ftry!(0, {
        with_view!(h, 0, |v| v.core.frame.pending() as c_int)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_pixels(h: *mut c_void) -> *const u8 {
    ftry!(ptr::null(), {
        with_view!(h, ptr::null(), |v| v.core.frame.pixels().as_ptr())
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_pixels_len(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.core.frame.pixels().len())
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_dimensions(h: *mut c_void, w: *mut u32, hgt: *mut u32) -> c_int {
    ftry!(0, {
        with_view!(h, 0, |v| unsafe {
            if !w.is_null() {
                *w = v.core.frame.w;
            }
            if !hgt.is_null() {
                *hgt = v.core.frame.h;
            }
            1
        })
    })
}

/// Pixel-format tag — 0=RGBA8, 1=BGRA8 (wpe_buffer_import_to_pixels is BGRA).
#[no_mangle]
pub extern "C" fn dd_webui_pixel_format(h: *mut c_void) -> u8 {
    ftry!(1, {
        with_view!(h, 1, |v| v.core.frame.pixel_format)
    })
}

// ---------------------------------------------------------------------------
// ABI — shared-memory frame channel (same header contract as dd_osr_*)
// ---------------------------------------------------------------------------

/// Buffer size needed for dd_webui_bind_frame_buf at the current size.
#[no_mangle]
pub extern "C" fn dd_webui_buf_needed(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.core.frame.buf_needed())
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_bind_frame_buf(h: *mut c_void, ptr: *mut u8, len: usize) -> c_int {
    ftry!(-1, {
        if ptr.is_null() {
            return 0;
        }
        with_view!(h, 0, |v| v.core.frame.bind(ptr, len) as c_int)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_frame_into(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| v.core.frame.frame_into(false))
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_refresh_into(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| v.core.frame.frame_into(true))
    })
}

// ---------------------------------------------------------------------------
// ABI — hit test / status / crash policy
// ---------------------------------------------------------------------------

/// 1 when (x,y) hits an opaque pixel inside the view rect.
#[no_mangle]
pub extern "C" fn dd_webui_hit_test(h: *mut c_void, x: f32, y: f32) -> c_int {
    ftry!(0, {
        with_view!(h, 0, |v| {
            if !v.core.interactive || x < 0.0 || y < 0.0 {
                return 0;
            }
            let (fx, fy) = (x.floor() as u32, y.floor() as u32);
            if fx >= v.core.frame.w || fy >= v.core.frame.h {
                return 0;
            }
            let px = &v.core.frame.pixels()
                [(fy as usize * v.core.frame.w as usize + fx as usize) * 4..];
            // Alpha byte is +3 in both RGBA and BGRA.
            (px.len() >= 4 && px[3] > 8) as c_int
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_status(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| v.core.status)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_crash_count(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.core.crash_count)
    })
}

/// Ask the backend to respawn a crashed/failed view. -1 = refused.
#[no_mangle]
pub extern "C" fn dd_webui_recover(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |_v| {
            // Phase 2: webkit_web_view reload after WebProcess-terminated.
            0
        })
    })
}

/// -1 = retry forever; N = fail after N crashes.
#[no_mangle]
pub extern "C" fn dd_webui_set_crash_policy(h: *mut c_void, max_retries: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            v.core.max_crash_retries = max_retries;
        });
    }));
}

/// WPE doesn't need a host-driven pump — the GMainLoop runs on its own
/// thread. Symbol kept for a uniform FFI surface across backends.
#[no_mangle]
pub extern "C" fn dd_webui_pump_ms(_t_ms: u64) {}

// Silence unused-import warnings for items the stub doesn't consume yet —
// Phase 2's browser wiring uses all of them.
#[allow(unused_imports)]
use common::{ev_console, ev_cursor, ev_eval, ev_message, ev_status};
#[allow(dead_code)]
fn _stub_unused(_: &mut FrameBuf, _: &mut EventQueue, _: Rect, _: &ViewCore) {}
