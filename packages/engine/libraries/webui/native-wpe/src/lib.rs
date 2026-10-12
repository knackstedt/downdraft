//! libdowndraft_webui_wpe — WPE (embedded WebKit) backend behind the shared
//! `dd_webui_*` ABI (see packages/engine/libraries/webui/README.md and
//! native-common/src/lib.rs). Covers linux (dev/testing) and android.
//!
//! Rendering path: libwpebackend-fdo in SHM mode
//! (`wpe_fdo_initialize_shm` + `wpe_view_backend_exportable_fdo`). The
//! WebProcess composite buffers arrive through `export_shm_buffer` as a
//! `wl_shm_buffer`; pixels are copied into the shared `FrameBuf` and the
//! buffer is released + frame-completed back to WebKit. BGRA8, matching the
//! CEF backend's `pixel_format = 1`.
//!
//! Threading model mirrors CEF: no dedicated GMainLoop thread — every
//! mutating FFI call ends with `pump()` (bounded `g_main_context_iteration`
//! drain) and the host-side pull cadence keeps the context live. All WPE /
//! WebKit / GObject calls therefore happen on the FFI caller thread only.
//!
//! Bridge: `window.downdraft.postMessage` → `webkit.messageHandlers.downdraft`
//! → `script-message-received::downdraft` (JSCValue → JSON). Host→page rides
//! `evaluate_javascript("__ddDispatch(<json>)")`; the `__dd*` shims are
//! injected as a `WebKitUserScript` at document start.

#![allow(non_snake_case)]
#![allow(non_camel_case_types)]

use downdraft_webui_common as common;
use common::{ev_console, ev_eval, ev_message, Rect, Registry, ViewCore};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const BACKEND: &[u8] = b"wpe\0";

// ---------------------------------------------------------------------------
// Panic-safe FFI — mirrors the blitz-osr / native-cef ftry! pattern
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
// Tiny JSON-opt parser (same convention as native-cef — flat string keys)
// ---------------------------------------------------------------------------

fn opt_str(json: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let i = json.find(&pat)? + pat.len();
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::with_capacity(rest.len());
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                }
                e => out.push(e),
            },
            c => out.push(c),
        }
    }
    None
}

fn opt_bool(json: &str, key: &str) -> Option<bool> {
    let pat = format!("\"{key}\"");
    let i = json.find(&pat)? + pat.len();
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start();
    Some(rest.starts_with("true"))
}

fn opt_num(json: &str, key: &str) -> Option<i64> {
    let pat = format!("\"{key}\"");
    let i = json.find(&pat)? + pat.len();
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))
        .unwrap_or(rest.len());
    rest[..end].split('.').next()?.parse().ok()
}

// ---------------------------------------------------------------------------
// C API surface — libwpe, libwpebackend-fdo, libwayland-client, libWPEWebKit,
// JSCore, GLib/GObject. All types opaque; signatures transcribed from the
// vendored headers under vendor/wpe-linux-x64/include.
// ---------------------------------------------------------------------------

type gpointer = *mut c_void;

#[repr(C)]
struct WpeKeyboardEvent {
    time: u32,
    key_code: u32,
    hardware_key_code: u32,
    pressed: u8,
    modifiers: u32,
}

#[repr(C)]
struct WpePointerEvent {
    type_: c_int,
    time: u32,
    x: c_int,
    y: c_int,
    button: u32,
    state: u32,
    modifiers: u32,
}

#[repr(C)]
struct WpeAxisEvent {
    type_: c_int,
    time: u32,
    x: c_int,
    y: c_int,
    axis: u32,
    value: i32,
    modifiers: u32,
}

#[repr(C)]
struct WpeTouchPointRaw {
    type_: c_int,
    time: u32,
    id: c_int,
    x: i32,
    y: i32,
}

#[repr(C)]
struct WpeTouchEvent {
    touchpoints: *const WpeTouchPointRaw,
    touchpoints_length: u64,
    type_: c_int,
    id: i32,
    time: u32,
    modifiers: u32,
}

#[repr(C)]
struct WebKitColor {
    red: f64,
    green: f64,
    blue: f64,
    alpha: f64,
}

/// Must match `struct wpe_view_backend_exportable_fdo_client` exactly —
/// three callbacks then two reserved slots (usize keeps the static Sync).
#[repr(C)]
struct ExportableClient {
    export_buffer_resource: Option<extern "C" fn(gpointer, gpointer)>,
    export_dmabuf_resource: Option<extern "C" fn(gpointer, gpointer)>,
    export_shm_buffer: Option<extern "C" fn(gpointer, gpointer)>,
    _rsvd0: usize,
    _rsvd1: usize,
}

#[repr(C)]
struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

extern "C" {
    // -- libwpebackend-fdo (wpe-fdo-1.0)
    fn wpe_fdo_initialize_shm() -> c_int;
    fn wpe_view_backend_exportable_fdo_create(
        client: *const ExportableClient,
        data: gpointer,
        width: u32,
        height: u32,
    ) -> gpointer;
    fn wpe_view_backend_exportable_fdo_destroy(exportable: gpointer);
    fn wpe_view_backend_exportable_fdo_get_view_backend(exportable: gpointer) -> gpointer;
    fn wpe_view_backend_exportable_fdo_dispatch_frame_complete(exportable: gpointer);
    fn wpe_view_backend_exportable_fdo_dispatch_release_buffer(
        exportable: gpointer,
        buffer_resource: gpointer,
    );
    fn wpe_view_backend_exportable_fdo_dispatch_release_shm_exported_buffer(
        exportable: gpointer,
        exported_buffer: gpointer,
    );
    fn wpe_fdo_shm_exported_buffer_get_shm_buffer(exported_buffer: gpointer) -> gpointer;

    // -- libwpe (wpe-1.0)
    fn wpe_view_backend_dispatch_set_size(backend: gpointer, width: u32, height: u32);
    fn wpe_view_backend_dispatch_set_device_scale_factor(backend: gpointer, scale: f32);
    fn wpe_view_backend_dispatch_pointer_event(backend: gpointer, event: *const WpePointerEvent);
    fn wpe_view_backend_dispatch_keyboard_event(backend: gpointer, event: *const WpeKeyboardEvent);
    fn wpe_view_backend_dispatch_axis_event(backend: gpointer, event: *const WpeAxisEvent);
    fn wpe_view_backend_dispatch_touch_event(backend: gpointer, event: *const WpeTouchEvent);

    // -- libwayland-client (wl_shm_buffer introspection for shm readback)
    fn wl_shm_buffer_get_data(buffer: gpointer) -> *const c_void;
    fn wl_shm_buffer_get_stride(buffer: gpointer) -> c_int;
    fn wl_shm_buffer_get_format(buffer: gpointer) -> u32;
    fn wl_shm_buffer_get_width(buffer: gpointer) -> c_int;
    fn wl_shm_buffer_get_height(buffer: gpointer) -> c_int;

    // -- libWPEWebKit-2.0
    fn webkit_web_view_backend_new(
        backend: gpointer,
        destroy_notify: Option<extern "C" fn(gpointer)>,
        destroy_data: gpointer,
    ) -> gpointer;
    fn webkit_web_view_new(backend: gpointer) -> gpointer;
    fn webkit_web_view_load_uri(view: gpointer, uri: *const c_char);
    fn webkit_web_view_load_html(view: gpointer, content: *const c_char, base_uri: *const c_char);
    fn webkit_web_view_evaluate_javascript(
        view: gpointer,
        script: *const c_char,
        length: isize,
        world_name: *const c_char,
        source_uri: *const c_char,
        cancellable: gpointer,
        callback: Option<extern "C" fn(gpointer, gpointer, gpointer)>,
        user_data: gpointer,
    );
    fn webkit_web_view_evaluate_javascript_finish(
        view: gpointer,
        result: gpointer,
        error: *mut *mut GError,
    ) -> gpointer;
    fn webkit_web_view_get_uri(view: gpointer) -> *const c_char;
    fn webkit_web_view_go_back(view: gpointer);
    fn webkit_web_view_go_forward(view: gpointer);
    fn webkit_web_view_can_go_back(view: gpointer) -> c_int;
    fn webkit_web_view_can_go_forward(view: gpointer) -> c_int;
    fn webkit_web_view_reload(view: gpointer);
    fn webkit_web_view_stop_loading(view: gpointer);
    fn webkit_web_view_set_zoom_level(view: gpointer, zoom_level: f64);
    fn webkit_web_view_set_background_color(view: gpointer, color: *const WebKitColor);
    fn webkit_web_view_set_settings(view: gpointer, settings: gpointer);
    fn webkit_web_view_get_user_content_manager(view: gpointer) -> gpointer;
    fn webkit_settings_new() -> gpointer;
    // NOTE: WebKitWebView::console-message-sent was removed upstream —
    // console capture rides the shim's __ddConsole-tagged script messages.
    #[allow(dead_code)]
    fn webkit_console_message_get_text(msg: gpointer) -> *const c_char;
    fn webkit_user_content_manager_register_script_message_handler(
        mgr: gpointer,
        name: *const c_char,
        world_name: *const c_char,
    ) -> c_int;
    fn webkit_user_content_manager_add_script(mgr: gpointer, script: gpointer);
    fn webkit_user_script_new(
        source: *const c_char,
        injected_frames: c_int,
        injection_time: c_int,
        allow_list: *const *const c_char,
        block_list: *const *const c_char,
    ) -> gpointer;
    fn webkit_user_script_unref(script: gpointer);

    // -- JSCore
    fn jsc_value_to_json(value: gpointer, indent: c_int) -> *mut c_char;
    fn jsc_value_to_string(value: gpointer) -> *mut c_char;

    // -- GLib / GObject
    fn g_object_unref(obj: gpointer);
    fn g_free(ptr: gpointer);
    fn g_error_free(err: *mut GError);
    fn g_main_context_default() -> gpointer;
    fn g_main_context_iteration(ctx: gpointer, may_block: c_int) -> c_int;
    fn g_signal_connect_data(
        instance: gpointer,
        detailed_signal: *const c_char,
        c_handler: gpointer,
        data: gpointer,
        destroy_data: gpointer,
        connect_flags: c_int,
    ) -> usize;
}

// ---------------------------------------------------------------------------
// Page shim — WPE flavor. `downdraft.postMessage` rides the registered
// "downdraft" script-message channel; `__ddDispatch` is eval'd by the host.
// Injected via WebKitUserScript at document start so it exists before any
// page script runs.
// ---------------------------------------------------------------------------

const SHIM_JS: &str = r#"
(function () {
  if (window.__ddShim) return;
  window.__ddShim = true;
  var listeners = [];
  window.__ddSend = function (v) {
    try { window.webkit.messageHandlers.downdraft.postMessage(v); } catch (e) {}
  };
  window.__ddDispatch = function (v) {
    listeners.slice().forEach(function (fn) { try { fn(v); } catch (e) {} });
  };
  window.downdraft = {
    postMessage: function (v) { window.__ddSend(v); },
    onMessage: function (fn) { if (typeof fn === "function") listeners.push(fn); },
  };
  // WPE dropped WebKitWebView::console-message-sent — console events ride
  // the same message channel as tagged payloads the host unwraps.
  ["log", "debug", "info", "warn", "error"].forEach(function (name, lvl) {
    var orig = console[name];
    console[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      var text = args.map(function (a) {
        try { return typeof a === "string" ? a : JSON.stringify(a); }
        catch (e) { return String(a); }
      }).join(" ");
      try { window.webkit.messageHandlers.downdraft.postMessage({ __ddConsole: lvl, v: text }); } catch (e) {}
      if (orig) orig.apply(console, args);
    };
  });
})();
"#;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static INITIALIZED: AtomicBool = AtomicBool::new(false);
static T0: Mutex<Option<Instant>> = Mutex::new(None);

fn now_ms() -> u32 {
    let t = T0.lock().unwrap_or_else(|e| e.into_inner());
    t.map(|i| i.elapsed().as_millis() as u32).unwrap_or(0)
}

/// Drain pending GMainContext work — bounded so a busy source can't spin us.
fn pump() {
    unsafe {
        let ctx = g_main_context_default();
        for _ in 0..32 {
            if g_main_context_iteration(ctx, 0) == 0 {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// View — FFI-owned object + callback-shared state
// ---------------------------------------------------------------------------

struct ViewShared {
    core: Mutex<ViewCore>,
    /// exportable + backend pointers the shm callback needs to release
    /// buffers against. Written at create, cleared at destroy.
    exportable: AtomicPtr<c_void>,
    backend: AtomicPtr<c_void>,
    /// DIP→physical scale (f32 bits) — input coords arrive in DIP, WPE
    /// dispatches in physical pixels.
    scale_bits: AtomicU32,
}

impl ViewShared {
    fn lock(&self) -> std::sync::MutexGuard<'_, ViewCore> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct View {
    /// Registry busy flag (FFI claims).
    busy: AtomicBool,
    shared: Arc<ViewShared>,
    /// WebKitWebView GObject — owned, unref'd in destroy.
    webview: AtomicPtr<c_void>,
    /// Recreate params for recover().
    url: Mutex<String>,
    transparent: bool,
}

fn busy_of(v: &View) -> &AtomicBool {
    &v.busy
}

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
// Exportable-FDO client — shm buffer import
// ---------------------------------------------------------------------------

extern "C" fn export_buffer_resource(data: gpointer, resource: gpointer) {
    // GPU-backed wl_resource — we only consume shm, but must release every
    // exported resource or the WebProcess stalls waiting on pool space.
    let shared = unsafe { &*(data as *const ViewShared) };
    let exp = shared.exportable.load(Ordering::Acquire);
    if !exp.is_null() {
        unsafe { wpe_view_backend_exportable_fdo_dispatch_release_buffer(exp, resource) };
    }
}

/// wpe_view_backend_exportable_fdo_dmabuf_resource — fds are owned by the
/// client once exported; we consume nothing but must close them + release
/// the wrapped buffer_resource back.
#[repr(C)]
struct DmabufResource {
    buffer_resource: gpointer,
    width: u32,
    height: u32,
    format: u32,
    n_planes: u8,
    fds: [c_int; 4],
    strides: [u32; 4],
    offsets: [u32; 4],
    modifiers: [u64; 4],
}

extern "C" fn close(fd: c_int) -> c_int {
    unsafe { libc_close(fd) }
}

extern "C" {
    #[link_name = "close"]
    fn libc_close(fd: c_int) -> c_int;
}

extern "C" fn export_dmabuf_resource(data: gpointer, resource: gpointer) {
    let shared = unsafe { &*(data as *const ViewShared) };
    let exp = shared.exportable.load(Ordering::Acquire);
    if exp.is_null() || resource.is_null() {
        return;
    }
    unsafe {
        let dmabuf = &*(resource as *const DmabufResource);
        for i in 0..(dmabuf.n_planes as usize).min(4) {
            if dmabuf.fds[i] >= 0 {
                close(dmabuf.fds[i]);
            }
        }
        if !dmabuf.buffer_resource.is_null() {
            wpe_view_backend_exportable_fdo_dispatch_release_buffer(
                exp,
                dmabuf.buffer_resource,
            );
        }
        wpe_view_backend_exportable_fdo_dispatch_frame_complete(exp);
    }
}

extern "C" fn export_shm_buffer(data: gpointer, exported: gpointer) {
    let shared = unsafe { &*(data as *const ViewShared) };
    let exp = shared.exportable.load(Ordering::Acquire);
    if exp.is_null() {
        return;
    }
    unsafe {
        let shm = wpe_fdo_shm_exported_buffer_get_shm_buffer(exported);
        if !shm.is_null() {
            let pixels = wl_shm_buffer_get_data(shm);
            let stride = wl_shm_buffer_get_stride(shm);
            let fmt = wl_shm_buffer_get_format(shm);
            // WL_SHM_FORMAT_ARGB8888 = 0, XRGB8888 = 1 — both little-endian
            // 32bpp, memory order B,G,R,A → our BGRA frame format.
            if !pixels.is_null() && stride > 0 && fmt <= 1 {
                let bw = wl_shm_buffer_get_width(shm).max(0) as u32;
                let bh = wl_shm_buffer_get_height(shm).max(0) as u32;
                let mut core = shared.lock();
                let (w, h) = (core.frame.w.min(bw), core.frame.h.min(bh));
                let src = std::slice::from_raw_parts(
                    pixels as *const u8,
                    stride as usize * bh as usize,
                );
                if w > 0 && h > 0 {
                    core.frame.write_rows(Rect::new(0, 0, w, h), src, stride as usize);
                }
            }
        }
        wpe_view_backend_exportable_fdo_dispatch_release_shm_exported_buffer(exp, exported);
        wpe_view_backend_exportable_fdo_dispatch_frame_complete(exp);
    }
}

extern "C" fn exportable_destroy_notify(exportable: gpointer) {
    if !exportable.is_null() {
        unsafe { wpe_view_backend_exportable_fdo_destroy(exportable) };
    }
}

// ---------------------------------------------------------------------------
// GObject signal callbacks — data is `Arc<ViewShared>` as a raw pointer
// (kept alive for the view's lifetime; reclaimed in dd_webui_destroy).
// ---------------------------------------------------------------------------

/// load-changed: 0=started 1=redirected 2=committed 3=finished.
extern "C" fn on_load_changed(view: gpointer, event: c_int, data: gpointer) {
    let shared = unsafe { &*(data as *const ViewShared) };
    let mut core = shared.lock();
    if event == 2 || event == 3 {
        let url = unsafe {
            let u = webkit_web_view_get_uri(view);
            if u.is_null() {
                String::new()
            } else {
                CStr::from_ptr(u).to_string_lossy().into_owned()
            }
        };
        let (b, f) = unsafe {
            (
                webkit_web_view_can_go_back(view),
                webkit_web_view_can_go_forward(view),
            )
        };
        core.events.push(format!(
            "{{\"t\":\"nav\",\"url\":\"{}\",\"back\":{},\"fwd\":{}}}",
            common::json_escape(&url),
            if b != 0 { "true" } else { "false" },
            if f != 0 { "true" } else { "false" }
        ));
        if event == 3 {
            core.events.push("{\"t\":\"load\"}".to_string());
        }
    }
}


/// script-message-received::downdraft — page→host messages. The JSCValue is
/// serialized to JSON so structured payloads round-trip intact. The shim's
/// console-forwarding payloads ({"__ddConsole":level,"v":text}) are unwrapped
/// into console events here.
extern "C" fn on_script_message(_mgr: gpointer, value: gpointer, data: gpointer) {
    let shared = unsafe { &*(data as *const ViewShared) };
    let json = unsafe {
        let p = jsc_value_to_json(value, 0);
        if p.is_null() {
            String::from("null")
        } else {
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            g_free(p as gpointer);
            s
        }
    };
    let mut core = shared.lock();
    if json.contains("__ddConsole") {
        let level = opt_num(&json, "__ddConsole").unwrap_or(0) as i32;
        let text = opt_str(&json, "v").unwrap_or_default();
        core.events.push(ev_console(level, &text));
    } else {
        core.events.push(ev_message(&json));
    }
}

/// web-process-terminated: reason 0=crashed 1=memory-limit 2=by-api.
extern "C" fn on_web_process_terminated(_view: gpointer, _reason: c_int, data: gpointer) {
    let shared = unsafe { &*(data as *const ViewShared) };
    shared.lock().record_crash();
}

fn connect(view_obj: gpointer, signal: &str, cb: gpointer, data: gpointer) {
    let sig = CString::new(signal).unwrap();
    unsafe {
        g_signal_connect_data(view_obj, sig.as_ptr(), cb, data, ptr::null_mut(), 0);
    }
}

// ---------------------------------------------------------------------------
// Async eval — user_data is a boxed (shared, req) pair; a strong Arc keeps
// the queue alive even if the view is destroyed mid-flight.
// ---------------------------------------------------------------------------

struct EvalCtx {
    shared: Arc<ViewShared>,
    req: u64,
}

extern "C" fn eval_ready(source: gpointer, result: gpointer, data: gpointer) {
    let ctx = unsafe { Box::from_raw(data as *mut EvalCtx) };
    let mut err: *mut GError = ptr::null_mut();
    let value = unsafe { webkit_web_view_evaluate_javascript_finish(source, result, &mut err) };
    let (ok, v) = if value.is_null() {
        let msg = unsafe {
            if err.is_null() {
                "eval failed".to_string()
            } else {
                let m = CStr::from_ptr((*err).message).to_string_lossy().into_owned();
                g_error_free(err);
                m
            }
        };
        (false, format!("\"{}\"", common::json_escape(&msg)))
    } else {
        let json = unsafe {
            let p = jsc_value_to_json(value, 0);
            if p.is_null() {
                // undefined/null → serialize via string fallback
                let s = jsc_value_to_string(value);
                if s.is_null() {
                    "null".to_string()
                } else {
                    let st = CStr::from_ptr(s).to_string_lossy().into_owned();
                    g_free(s as gpointer);
                    format!("\"{}\"", common::json_escape(&st))
                }
            } else {
                let st = CStr::from_ptr(p).to_string_lossy().into_owned();
                g_free(p as gpointer);
                st
            }
        };
        unsafe { g_object_unref(value) };
        (true, json)
    };
    ctx.shared.lock().events.push(ev_eval(ctx.req, ok, &v));
}

// ---------------------------------------------------------------------------
// Key mapping — DOM key/code → XKB keysym + evdev hardware code (subset:
// printable ASCII + the common editing keys; enough for DOM keydown +
// text input).
// ---------------------------------------------------------------------------

fn keysym_of(key: &str, code: &str, text: Option<&str>) -> u32 {
    if let Some(t) = text {
        if t.len() == 1 {
            if let Some(c) = t.chars().next() {
                if (c as u32) < 0x110000 && !c.is_control() {
                    return c as u32;
                }
            }
        }
    }
    match key {
        "Backspace" => 0xff08,
        "Tab" => 0xff09,
        "Enter" | "Return" => 0xff0d,
        "Escape" => 0xff1b,
        "Delete" => 0xffff,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        " " => 0x20,
        "Shift" => 0xffe1,
        "Control" => 0xffe3,
        "Alt" => 0xffe9,
        "Meta" => 0xffe7,
        _ => {
            // Single printable char → its codepoint is the keysym.
            let mut it = key.chars();
            match (it.next(), it.next()) {
                (Some(c), None) => {
                    let k = c.to_ascii_lowercase() as u32;
                    if k < 0x110000 {
                        k
                    } else {
                        0
                    }
                }
                _ => code.chars().last().map(|c| c.to_ascii_lowercase() as u32).unwrap_or(0),
            }
        }
    }
}

/// evdev key codes for the common layout keys (Linux input-event-codes).
fn hwcode_of(code: &str) -> u32 {
    match code {
        "Backspace" => 14,
        "Tab" => 15,
        "Enter" => 28,
        "Escape" => 1,
        "Space" => 57,
        "ArrowLeft" => 105,
        "ArrowUp" => 103,
        "ArrowRight" => 106,
        "ArrowDown" => 108,
        "Delete" => 111,
        "Home" => 102,
        "End" => 107,
        "PageUp" => 104,
        "PageDown" => 109,
        "ShiftLeft" | "ShiftRight" => 42,
        "ControlLeft" | "ControlRight" => 29,
        "AltLeft" | "AltRight" => 56,
        _ => {
            // KeyA..KeyZ → 30..48 (not contiguous past P — use table).
            const KEY: &[(&str, u32)] = &[
                ("KeyQ", 16), ("KeyW", 17), ("KeyE", 18), ("KeyR", 19), ("KeyT", 20),
                ("KeyY", 21), ("KeyU", 22), ("KeyI", 23), ("KeyO", 24), ("KeyP", 25),
                ("KeyA", 30), ("KeyS", 31), ("KeyD", 32), ("KeyF", 33), ("KeyG", 34),
                ("KeyH", 35), ("KeyJ", 36), ("KeyK", 37), ("KeyL", 38),
                ("KeyZ", 44), ("KeyX", 45), ("KeyC", 46), ("KeyV", 47), ("KeyB", 48),
                ("KeyN", 49), ("KeyM", 50),
                ("Digit1", 2), ("Digit2", 3), ("Digit3", 4), ("Digit4", 5),
                ("Digit5", 6), ("Digit6", 7), ("Digit7", 8), ("Digit8", 9),
                ("Digit9", 10), ("Digit0", 11),
            ];
            KEY.iter().find(|(c, _)| *c == code).map(|(_, n)| *n).unwrap_or(0)
        }
    }
}

// ---------------------------------------------------------------------------
// ABI — lifecycle
// ---------------------------------------------------------------------------

/// opts_json: {"wpePrefix","cachePath","userAgent","headless","remoteDebugPort"}
#[no_mangle]
pub extern "C" fn dd_webui_global_init(opts_json: *const c_char) -> c_int {
    ftry!(-1, {
        if INITIALIZED.swap(true, Ordering::AcqRel) {
            return 0; // already up
        }
        let opts = unsafe { cstr(opts_json) }.unwrap_or("{}");

        // The Debian build hardcodes its libexec dir
        // (/usr/lib/x86_64-linux-gnu/wpe-webkit-2.0) — dev runs present the
        // vendored one there via a user-ns bind mount (see README), so no
        // runtime patching is needed here.
        if let Some(p) = opt_str(opts, "wpePrefix") {
            if !p.is_empty() {
                // Point the subprocess chain at the vendored lib set via
                // env — child processes inherit these. WPE_BACKEND_LIBRARY
                // names the fdo impl the wpe loader dlopens (it defaults to
                // libWPEBackend-default.so, which doesn't exist).
                std::env::set_var(
                    "LD_LIBRARY_PATH",
                    format!("{p}/lib:{}", std::env::var("LD_LIBRARY_PATH").unwrap_or_default()),
                );
                std::env::set_var(
                    "WPE_BACKEND_LIBRARY",
                    format!("{p}/lib/libWPEBackend-fdo-1.0.so"),
                );
            }
        }
        if std::env::var_os("WPE_BACKEND_LIBRARY").is_none() {
            std::env::set_var("WPE_BACKEND_LIBRARY", "libWPEBackend-fdo-1.0.so");
        }
        if opt_bool(opts, "noSandbox").unwrap_or(true) {
            // The vendored tree ships no setuid sandbox helper.
            std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
        }

        *T0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());

        unsafe {
            if wpe_fdo_initialize_shm() == 0 {
                INITIALIZED.store(false, Ordering::Release);
                return -1;
            }
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_global_shutdown() {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if INITIALIZED.swap(false, Ordering::AcqRel) {
            // Views must already be destroyed (host contract). Drain any
            // straggler main-context work so teardown is orderly.
            pump();
        }
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_backend() -> *const c_char {
    BACKEND.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn dd_webui_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "-wpe\0").as_ptr().cast()
}

/// opts_json: {"url","html","transparent","interactive","userAgent","frameRate"}
#[no_mangle]
pub extern "C" fn dd_webui_create(
    opts_json: *const c_char,
    width: c_int,
    height: c_int,
    scale: f32,
) -> *mut c_void {
    ftry!(ptr::null_mut(), {
        if !INITIALIZED.load(Ordering::Acquire) {
            return ptr::null_mut();
        }
        let opts = unsafe { cstr(opts_json) }.unwrap_or("{}");
        let url = opt_str(opts, "url").unwrap_or_default();
        let html = opt_str(opts, "html").unwrap_or_default();
        let transparent = opt_bool(opts, "transparent").unwrap_or(false);
        let (w, h) = (width.max(1) as u32, height.max(1) as u32);
        let (pw, ph) = (
            (w as f32 * scale.max(0.01)).round().max(1.0) as u32,
            (h as f32 * scale.max(0.01)).round().max(1.0) as u32,
        );

        let shared = Arc::new(ViewShared {
            core: Mutex::new(ViewCore::new(pw, ph, 1)), // BGRA
            exportable: AtomicPtr::new(ptr::null_mut()),
            backend: AtomicPtr::new(ptr::null_mut()),
            scale_bits: AtomicU32::new(scale.max(0.01).to_bits()),
        });

        unsafe {
            // wpe exportable → wl_shm frame delivery
            static CLIENT: ExportableClient = ExportableClient {
                export_buffer_resource: Some(export_buffer_resource),
                export_dmabuf_resource: Some(export_dmabuf_resource),
                export_shm_buffer: Some(export_shm_buffer),
                _rsvd0: 0,
                _rsvd1: 0,
            };
            // The Arc clone below is the client/signal data pointer —
            // reclaimed in dd_webui_destroy after the objects die.
            let data = Arc::into_raw(shared.clone()) as gpointer;
            let exportable =
                wpe_view_backend_exportable_fdo_create(&CLIENT, data, pw, ph);
            if exportable.is_null() {
                drop(Arc::from_raw(data as *const ViewShared));
                return ptr::null_mut();
            }
            let wpe_backend = wpe_view_backend_exportable_fdo_get_view_backend(exportable);
            // WebKitWebViewBackend takes ownership of the wpe backend; its
            // destroy notify tears down the exportable when the view dies.
            let webkit_backend = webkit_web_view_backend_new(
                wpe_backend,
                Some(exportable_destroy_notify),
                exportable,
            );
            if webkit_backend.is_null() {
                wpe_view_backend_exportable_fdo_destroy(exportable);
                drop(Arc::from_raw(data as *const ViewShared));
                return ptr::null_mut();
            }
            let view = webkit_web_view_new(webkit_backend);
            if view.is_null() {
                g_object_unref(webkit_backend); // notify → exportable_destroy
                drop(Arc::from_raw(data as *const ViewShared));
                return ptr::null_mut();
            }

            shared.exportable.store(exportable, Ordering::Release);
            shared.backend.store(wpe_backend, Ordering::Release);

            // View defaults: opaque bg unless transparent; default settings.
            if transparent {
                webkit_web_view_set_background_color(
                    view,
                    &WebKitColor { red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0 },
                );
            }
            let settings = webkit_settings_new();
            if !settings.is_null() {
                webkit_web_view_set_settings(view, settings);
                g_object_unref(settings);
            }

            // Bridge: register the "downdraft" message channel FIRST (the
            // signal must be connected before registration per the docs —
            // we connect first anyway), then inject the page shim.
            let ucm = webkit_web_view_get_user_content_manager(view);
            if !ucm.is_null() {
                connect(
                    ucm,
                    "script-message-received::downdraft",
                    on_script_message as gpointer,
                    data,
                );
                let name = CString::new("downdraft").unwrap();
                webkit_user_content_manager_register_script_message_handler(
                    ucm,
                    name.as_ptr(),
                    ptr::null(),
                );
                let shim_src = CString::new(SHIM_JS).unwrap();
                let script = webkit_user_script_new(
                    shim_src.as_ptr(),
                    1, // WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES
                    0, // WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START
                    ptr::null(),
                    ptr::null(),
                );
                if !script.is_null() {
                    webkit_user_content_manager_add_script(ucm, script);
                    webkit_user_script_unref(script);
                }
            }

            connect(view, "load-changed", on_load_changed as gpointer, data);
            connect(view, "web-process-terminated", on_web_process_terminated as gpointer, data);

            // Size + scale.
            wpe_view_backend_dispatch_set_size(wpe_backend, pw, ph);
            wpe_view_backend_dispatch_set_device_scale_factor(wpe_backend, scale.max(0.01));

            let v = Box::new(View {
                busy: AtomicBool::new(false),
                shared,
                webview: AtomicPtr::new(view),
                url: Mutex::new(String::new()),
                transparent,
            });
            if let Some(ia) = opt_bool(opts, "interactive") {
                v.shared.lock().interactive = ia;
            }
            *v.url.lock().unwrap_or_else(|e| e.into_inner()) =
                if html.is_empty() { url.clone() } else { String::new() };
            let handle = Box::into_raw(v) as *mut c_void;
            Registry::register(handle as usize);

            // Initial content.
            if !html.is_empty() {
                let c = CString::new(html).unwrap();
                webkit_web_view_load_html(view, c.as_ptr(), ptr::null());
            } else if !url.is_empty() {
                let c = CString::new(url).unwrap();
                webkit_web_view_load_uri(view, c.as_ptr());
            }

            pump();
            handle
        }
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
        Registry::unregister(h as usize);
        let view = unsafe { Box::from_raw(v) };
        let webview = view.webview.swap(ptr::null_mut(), Ordering::AcqRel);
        view.shared.exportable.store(ptr::null_mut(), Ordering::Release);
        view.shared.backend.store(ptr::null_mut(), Ordering::Release);
        if !webview.is_null() {
            unsafe { g_object_unref(webview) }; // → backend notify → exportable destroy
        }
        pump();
        // Reclaim the client-data Arc clone once all GObject objects that
        // could fire callbacks into it are gone.
        unsafe {
            let _ = Arc::from_raw(
                // client data = same Arc we cloned at create
                Arc::as_ptr(&view.shared),
            );
        }
    }));
}

// ---------------------------------------------------------------------------
// ABI — navigation / content
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn dd_webui_load_url(h: *mut c_void, url: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if let Some(u) = unsafe { cstr(url) } {
                let webview = v.webview.load(Ordering::Acquire);
                if !webview.is_null() {
                    *v.url.lock().unwrap_or_else(|e| e.into_inner()) = u.to_string();
                    let c = CString::new(u).unwrap();
                    unsafe { webkit_web_view_load_uri(webview, c.as_ptr()) };
                }
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_content(h: *mut c_void, html: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if let Some(s) = unsafe { cstr(html) } {
                let webview = v.webview.load(Ordering::Acquire);
                if !webview.is_null() {
                    v.url.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    let c = CString::new(s).unwrap();
                    unsafe { webkit_web_view_load_html(webview, c.as_ptr(), ptr::null()) };
                }
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_resize(h: *mut c_void, w: c_int, hgt: c_int, scale: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let (pw, ph) = (
                (w.max(1) as f32 * scale.max(0.01)).round().max(1.0) as u32,
                (hgt.max(1) as f32 * scale.max(0.01)).round().max(1.0) as u32,
            );
            let backend = v.shared.backend.load(Ordering::Acquire);
            if !backend.is_null() {
                unsafe {
                    wpe_view_backend_dispatch_set_size(backend, pw, ph);
                    wpe_view_backend_dispatch_set_device_scale_factor(backend, scale.max(0.01));
                }
            }
            v.shared
                .scale_bits
                .store(scale.max(0.01).to_bits(), Ordering::Release);
            v.shared.lock().frame.resize(pw, ph);
            pump();
        });
    }));
}

/// op: 0=back 1=forward 2=reload 3=stop
#[no_mangle]
pub extern "C" fn dd_webui_navigate(h: *mut c_void, op: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let view = v.webview.load(Ordering::Acquire);
            if !view.is_null() {
                unsafe {
                    match op {
                        0 => webkit_web_view_go_back(view),
                        1 => webkit_web_view_go_forward(view),
                        2 => webkit_web_view_reload(view),
                        3 => webkit_web_view_stop_loading(view),
                        _ => {}
                    }
                }
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_zoom(h: *mut c_void, factor: f64) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let view = v.webview.load(Ordering::Acquire);
            if !view.is_null() {
                unsafe { webkit_web_view_set_zoom_level(view, factor) };
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_focus(h: *mut c_void, _focused: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |_v| {
            // WPE has no focus event dispatch — focus follows `interactive`
            // for input gating only. Kept for ABI parity.
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_interactive(h: *mut c_void, on: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            v.shared.lock().interactive = on != 0;
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
            let view = v.webview.load(Ordering::Acquire);
            if view.is_null() {
                return;
            }
            if let Some(code) = unsafe { cstr(js) } {
                let c = CString::new(code).unwrap();
                let ctx = Box::into_raw(Box::new(EvalCtx {
                    shared: v.shared.clone(),
                    req,
                })) as gpointer;
                unsafe {
                    webkit_web_view_evaluate_javascript(
                        view,
                        c.as_ptr(),
                        code.len() as isize,
                        ptr::null(),
                        ptr::null(),
                        ptr::null_mut(),
                        Some(eval_ready),
                        ctx,
                    );
                }
            }
            pump();
        });
    }));
}

/// Deliver a JSON message to the page's `window.downdraft` bridge —
/// eval'd as `__ddDispatch(<json literal>)` in the default world.
#[no_mangle]
pub extern "C" fn dd_webui_post_message(h: *mut c_void, json: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let view = v.webview.load(Ordering::Acquire);
            if view.is_null() {
                return;
            }
            if let Some(m) = unsafe { cstr(json) } {
                // The payload is already JSON — embed it literally so the
                // page receives the original structured value.
                let code = format!(
                    "window.__ddDispatch && window.__ddDispatch({m})"
                );
                let c = CString::new(code).unwrap();
                let ctx = Box::into_raw(Box::new(EvalCtx {
                    shared: v.shared.clone(),
                    req: 0, // fire-and-forget; ok flag is ignored downstream
                })) as gpointer;
                unsafe {
                    webkit_web_view_evaluate_javascript(
                        view,
                        c.as_ptr(),
                        c.as_bytes().len() as isize,
                        ptr::null(),
                        ptr::null(),
                        ptr::null_mut(),
                        Some(eval_ready),
                        ctx,
                    );
                }
            }
            pump();
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
        pump();
        with_view!(h, 0, |v| {
            pump();
            if let Some(buf) = v.shared.lock().events.take() {
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
pub extern "C" fn dd_webui_input_pointer(h: *mut c_void, t: c_int, x: f32, y: f32, btn: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let backend = v.shared.backend.load(Ordering::Acquire);
            if backend.is_null() {
                return;
            }
            // x,y arrive in DIP — WPE dispatches in physical pixels.
            let s = f32::from_bits(v.shared.scale_bits.load(Ordering::Acquire));
            unsafe {
                let (px, py) = ((x * s).round() as c_int, (y * s).round() as c_int);
                if t == 0 || t == 3 {
                    let ev = WpePointerEvent {
                        type_: 1, // motion
                        time: now_ms(),
                        x: px,
                        y: py,
                        button: 0,
                        state: 0,
                        modifiers: 0,
                    };
                    wpe_view_backend_dispatch_pointer_event(backend, &ev);
                } else if t == 1 || t == 2 {
                    let ev = WpePointerEvent {
                        type_: 2, // button
                        time: now_ms(),
                        x: px,
                        y: py,
                        button: btn as u32,
                        state: if t == 1 { 1 } else { 0 },
                        modifiers: 0,
                    };
                    wpe_view_backend_dispatch_pointer_event(backend, &ev);
                }
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_input_wheel(h: *mut c_void, x: f32, y: f32, dx: f32, dy: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let backend = v.shared.backend.load(Ordering::Acquire);
            if backend.is_null() {
                return;
            }
            let s = f32::from_bits(v.shared.scale_bits.load(Ordering::Acquire));
            let (px, py) = ((x * s).round() as c_int, (y * s).round() as c_int);
            unsafe {
                if dx != 0.0 {
                    let ev = WpeAxisEvent {
                        type_: 1, // motion
                        time: now_ms(),
                        x: px,
                        y: py,
                        axis: 1, // horizontal
                        value: (-dx * 120.0) as i32,
                        modifiers: 0,
                    };
                    wpe_view_backend_dispatch_axis_event(backend, &ev);
                }
                if dy != 0.0 {
                    let ev = WpeAxisEvent {
                        type_: 1,
                        time: now_ms(),
                        x: px,
                        y: py,
                        axis: 0, // vertical
                        value: (-dy * 120.0) as i32,
                        modifiers: 0,
                    };
                    wpe_view_backend_dispatch_axis_event(backend, &ev);
                }
            }
            pump();
        });
    }));
}

/// t: 0=down 1=up. mods bitmask: 1=shift 2=ctrl 4=alt 8=meta.
#[no_mangle]
pub extern "C" fn dd_webui_input_key(
    h: *mut c_void,
    t: c_int,
    key: *const c_char,
    code: *const c_char,
    text: *const c_char,
    mods: c_int,
    _repeat: c_int,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let backend = v.shared.backend.load(Ordering::Acquire);
            if backend.is_null() {
                return;
            }
            let key_s = unsafe { cstr(key) }.unwrap_or("");
            let code_s = unsafe { cstr(code) }.unwrap_or("");
            let text_s = unsafe { cstr(text) };
            // Our mods (1=shift 2=ctrl 4=alt 8=meta) → wpe_input_modifier
            // (ctrl=1 shift=2 alt=4 meta=8).
            let wm = (((mods & 2) >> 1)
                | ((mods & 1) << 1)
                | (mods & 4)
                | (mods & 8)) as u32;
            let ev = WpeKeyboardEvent {
                time: now_ms(),
                key_code: keysym_of(key_s, code_s, text_s),
                hardware_key_code: hwcode_of(code_s),
                pressed: if t == 0 { 1 } else { 0 },
                modifiers: wm,
            };
            unsafe { wpe_view_backend_dispatch_keyboard_event(backend, &ev) };
            pump();
        });
    }));
}

/// t: 0=down 1=move 2=up 3=cancel.
#[no_mangle]
pub extern "C" fn dd_webui_input_touch(h: *mut c_void, t: c_int, id: c_int, x: f32, y: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let backend = v.shared.backend.load(Ordering::Acquire);
            if backend.is_null() {
                return;
            }
            let tp = match t {
                0 => 1, // down
                1 => 2, // motion
                2 => 3, // up
                _ => 0, // cancel → null-ish
            };
            let s = f32::from_bits(v.shared.scale_bits.load(Ordering::Acquire));
            let pts = [WpeTouchPointRaw {
                type_: tp,
                time: now_ms(),
                id,
                x: (x * s).round() as i32,
                y: (y * s).round() as i32,
            }];
            let ev = WpeTouchEvent {
                touchpoints: pts.as_ptr(),
                touchpoints_length: 1,
                type_: tp,
                id,
                time: now_ms(),
                modifiers: 0,
            };
            unsafe { wpe_view_backend_dispatch_touch_event(backend, &ev) };
            pump();
        });
    }));
}

/// t: 0=preedit 1=commit 2=cancel. Basic text input lands via key events;
/// IME plumbing lands in Phase 6.
#[no_mangle]
pub extern "C" fn dd_webui_input_ime(h: *mut c_void, t: c_int, s: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if t == 1 {
                if let Some(txt) = unsafe { cstr(s) } {
                    for ch in txt.chars() {
                        let ev = WpeKeyboardEvent {
                            time: now_ms(),
                            key_code: ch as u32,
                            hardware_key_code: 0,
                            pressed: 1,
                            modifiers: 0,
                        };
                        let backend = v.shared.backend.load(Ordering::Acquire);
                        if !backend.is_null() {
                            unsafe { wpe_view_backend_dispatch_keyboard_event(backend, &ev) };
                        }
                    }
                }
            }
            pump();
        });
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
        pump();
        with_view!(h, 0, |v| {
            v.shared
                .lock()
                .frame
                .take()
                .map(|(_, r)| r.packed_u64())
                .unwrap_or(0)
        })
    })
}

/// Rect of the last produced frame (does not clear pending) — matches the
/// HostOsrAPI frameRect contract.
#[no_mangle]
pub extern "C" fn dd_webui_frame_rect(h: *mut c_void) -> u64 {
    ftry!(0, {
        with_view!(h, 0, |v| {
            v.shared
                .lock()
                .frame
                .last_rect()
                .map(|r| r.packed_u64())
                .unwrap_or(0)
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_frame_pending(h: *mut c_void) -> c_int {
    ftry!(0, {
        pump();
        with_view!(h, 0, |v| v.shared.lock().frame.pending() as c_int)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_pixels(h: *mut c_void) -> *const u8 {
    ftry!(ptr::null(), {
        with_view!(h, ptr::null(), |v| {
            v.shared.lock().frame.pixels().as_ptr()
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_pixels_len(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.shared.lock().frame.pixels().len())
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_dimensions(h: *mut c_void, w: *mut u32, hgt: *mut u32) -> c_int {
    ftry!(0, {
        with_view!(h, 0, |v| {
            let core = v.shared.lock();
            unsafe {
                if !w.is_null() {
                    *w = core.frame.w;
                }
                if !hgt.is_null() {
                    *hgt = core.frame.h;
                }
            }
            1
        })
    })
}

/// Pixel-format tag — 0=RGBA8, 1=BGRA8 (wl_shm argb/xrgb → BGRA memory).
#[no_mangle]
pub extern "C" fn dd_webui_pixel_format(h: *mut c_void) -> u8 {
    ftry!(1, {
        with_view!(h, 1, |v| v.shared.lock().frame.pixel_format)
    })
}

// ---------------------------------------------------------------------------
// ABI — shared-memory frame channel (same header contract as dd_osr_*)
// ---------------------------------------------------------------------------

/// Buffer size needed for dd_webui_bind_frame_buf at the current size.
#[no_mangle]
pub extern "C" fn dd_webui_buf_needed(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.shared.lock().frame.buf_needed())
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_bind_frame_buf(h: *mut c_void, ptr: *mut u8, len: usize) -> c_int {
    ftry!(-1, {
        if ptr.is_null() {
            return 0;
        }
        with_view!(h, 0, |v| v.shared.lock().frame.bind(ptr, len) as c_int)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_frame_into(h: *mut c_void) -> c_int {
    ftry!(-1, {
        pump();
        with_view!(h, -1, |v| v.shared.lock().frame.frame_into(false))
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_refresh_into(h: *mut c_void) -> c_int {
    ftry!(-1, {
        pump();
        with_view!(h, -1, |v| v.shared.lock().frame.frame_into(true))
    })
}

// ---------------------------------------------------------------------------
// ABI — hit test / status / crash policy
// ---------------------------------------------------------------------------

/// 1 when (x,y) hits an opaque pixel inside the view rect; opaque views
/// use bounds (post-resize pixel buffer may be unwritten), transparent
/// views use pixel alpha.
#[no_mangle]
pub extern "C" fn dd_webui_hit_test(h: *mut c_void, x: f32, y: f32) -> c_int {
    ftry!(0, {
        with_view!(h, 0, |v| {
            let core = v.shared.lock();
            if !core.interactive || x < 0.0 || y < 0.0 {
                return 0;
            }
            let (fx, fy) = (x.floor() as u32, y.floor() as u32);
            if fx >= core.frame.w || fy >= core.frame.h {
                return 0;
            }
            if !v.transparent {
                return 1;
            }
            let px = &core.frame.pixels()
                [(fy as usize * core.frame.w as usize + fx as usize) * 4..];
            (px.len() >= 4 && px[3] > 8) as c_int
        })
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_status(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| v.shared.lock().status)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_crash_count(h: *mut c_void) -> usize {
    ftry!(0, {
        with_view!(h, 0, |v| v.shared.lock().crash_count)
    })
}

/// Ask the backend to respawn a crashed/failed view — reloads the last
/// URL (or the blank page) on the surviving WebKitWebView.
#[no_mangle]
pub extern "C" fn dd_webui_recover(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| {
            let view = v.webview.load(Ordering::Acquire);
            if view.is_null() {
                return -1;
            }
            let url = v.url.lock().unwrap_or_else(|e| e.into_inner()).clone();
            unsafe {
                if !url.is_empty() {
                    let c = CString::new(url).unwrap();
                    webkit_web_view_load_uri(view, c.as_ptr());
                } else {
                    webkit_web_view_load_html(
                        view,
                        b"<html></html>\0".as_ptr() as *const c_char,
                        ptr::null::<c_char>(),
                    );
                }
            }
            v.shared.lock().status = common::STATUS_RUNNING;
            pump();
            0
        })
    })
}

/// -1 = retry forever; N = fail after N crashes.
#[no_mangle]
pub extern "C" fn dd_webui_set_crash_policy(h: *mut c_void, max_retries: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            v.shared.lock().max_crash_retries = max_retries;
        });
    }));
}

/// Explicit main-context drain for hosts that want to drive the loop
/// without touching a view (all mutating calls also pump internally).
#[no_mangle]
pub extern "C" fn dd_webui_pump_ms(_t_ms: u64) {
    pump();
}
