//! libdowndraft_webui_cef — CEF/Chromium OSR backend behind the shared
//! `dd_webui_*` ABI (see packages/engine/libraries/webui/README.md and
//! native-common/src/lib.rs).
//!
//! Architecture: the host process is the CEF *browser* process
//! (execute_process → −1 → initialize), with windowless OSR producing
//! BGRA OnPaint buffers into the shared FrameBuf. Renderer/GPU
//! subprocesses re-exec `downdraft_cef_helper` (settings.
//! browser_subprocess_path) which carries the V8 bridge: eval
//! round-trips and postMessage both ride CefProcessMessage; the
//! page-facing `window.downdraft` shim is injected on context creation.
//!
//! Threading contract: all dd_webui_* calls must come from the thread
//! that ran global_init (the JS host's main thread in practice — the
//! host drives CefDoMessageLoopWork through pump_ms / the frame pulls).
//! CEF callbacks arrive on that same thread under external_message_pump.

#![allow(non_snake_case)]

#[path = "bridge.rs"]
pub mod bridge;

use cef::args::Args;
use cef::rc::Rc as _;
use cef::{
    api_hash, browser_host_create_browser_sync, do_message_loop_work, execute_process,
    initialize, process_message_create, shutdown, sys, wrap_app, wrap_client,
    wrap_display_handler, wrap_life_span_handler, wrap_load_handler, wrap_render_handler,
    wrap_request_handler, App, Browser, BrowserSettings, CefString, CefStringUserfree,
    Client, CommandLine, CursorInfo, CursorType, DisplayHandler, ImplApp, ImplBrowser,
    ImplBrowserHost, ImplClient, ImplCommandLine, ImplDisplayHandler, ImplFrame,
    ImplLifeSpanHandler, ImplListValue, ImplLoadHandler, ImplProcessMessage,
    ImplRenderHandler, ImplRequestHandler, KeyEvent, KeyEventType, LifeSpanHandler,
    LoadHandler, LogSeverity, MouseButtonType, MouseEvent, PaintElementType,
    PointerType, ProcessId, ProcessMessage, Rect as CefRect, RenderHandler,
    RequestHandler, ScreenInfo, Settings, TerminationStatus, TouchEvent, TouchEventType,
    WindowInfo, WrapApp, WrapClient, WrapDisplayHandler, WrapLifeSpanHandler,
    WrapLoadHandler, WrapRenderHandler, WrapRequestHandler,
};
use downdraft_webui_common as common;
use common::{
    ev_console, ev_cursor, ev_eval, ev_message, ev_status, json_escape, Registry, Rect,
    ViewCore, STATUS_RUNNING,
};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

const BACKEND: &[u8] = b"cef\0";

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

fn cef_str(s: &str) -> CefString {
    CefString::from(s)
}

fn userfree_to_string(s: CefStringUserfree) -> String {
    CefString::from(&s).to_string()
}

// ---------------------------------------------------------------------------
// Minimal JSON opt extraction — the ABI opts are flat {"k":v} objects; a
// full parser is overkill. String values DO need escape handling — "html"
// payloads are quote-dense by nature.
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
                e => out.push(e), // \" \\ \/ and anything else literal
            },
            c => out.push(c),
        }
    }
    None // unterminated
}

fn opt_i64(json: &str, key: &str) -> Option<i64> {
    let pat = format!("\"{key}\"");
    let i = json.find(&pat)? + pat.len();
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))?;
    rest[..end].split('.').next()?.parse().ok()
}

fn opt_bool(json: &str, key: &str) -> Option<bool> {
    let pat = format!("\"{key}\"");
    let i = json.find(&pat)? + pat.len();
    let rest = json[i..].trim_start().strip_prefix(':')?.trim_start();
    Some(rest.starts_with("true"))
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

static INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Where libcef.so + resources live at runtime. Resolution order:
/// opts.cefDir → DD_CEF_RUNTIME_DIR (build-time vendored prefix) → the
/// directory containing this cdylib (packaged/staged layout).
fn resolve_cef_dir(opts: &str) -> PathBuf {
    if let Some(d) = opt_str(opts, "cefDir") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Ok(d) = std::env::var("DD_CEF_RUNTIME_DIR") {
        if !d.is_empty() && PathBuf::from(&d).exists() {
            return PathBuf::from(d);
        }
    }
    let built = env!("DD_CEF_RUNTIME_DIR");
    if !built.is_empty() && PathBuf::from(built).exists() {
        return PathBuf::from(built);
    }
    // Sibling of the loaded cdylib — find our own path via /proc/self/maps.
    self_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Directory containing this .so — the layout build-native.mjs and the
/// desktop packager produce (runtime files staged next to the lib).
fn self_dir() -> Option<PathBuf> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;
    maps.lines()
        .filter_map(|l| l.split_whitespace().last())
        .find(|p| p.contains("libdowndraft_webui_cef.so"))
        .and_then(|p| PathBuf::from(p).parent().map(|d| d.to_path_buf()))
}

fn helper_path(opts: &str, cef_dir: &std::path::Path) -> PathBuf {
    if let Some(p) = opt_str(opts, "helperPath") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let sibling = self_dir().unwrap_or_else(|| cef_dir.to_path_buf());
    let p = sibling.join("downdraft_cef_helper");
    if p.exists() {
        return p;
    }
    cef_dir.join("downdraft_cef_helper")
}

// ---------------------------------------------------------------------------
// Shared per-view state — Arc'd into every CEF handler
// ---------------------------------------------------------------------------

struct ViewShared {
    core: Mutex<ViewCore>,
    /// Logical (DIP) size for view_rect + raster scale for screen_info.
    w: AtomicU32,
    h: AtomicU32,
    scale_bits: AtomicU32,
}

impl ViewShared {
    fn lock(&self) -> std::sync::MutexGuard<'_, ViewCore> {
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// CEF handlers — browser process side
// ---------------------------------------------------------------------------

wrap_render_handler! {
    struct OsrRenderHandler {
        shared: Arc<ViewShared>,
    }

    impl RenderHandler {
        fn view_rect(&self, _browser: Option<&mut Browser>, rect: Option<&mut CefRect>) {
            if let Some(rect) = rect {
                rect.width = self.shared.w.load(Ordering::Relaxed) as i32;
                rect.height = self.shared.h.load(Ordering::Relaxed) as i32;
            }
        }

        fn screen_info(
            &self,
            _browser: Option<&mut Browser>,
            screen_info: Option<&mut ScreenInfo>,
        ) -> ::std::os::raw::c_int {
            if let Some(info) = screen_info {
                info.device_scale_factor =
                    f32::from_bits(self.shared.scale_bits.load(Ordering::Relaxed));
                return 1;
            }
            0
        }

        // BGRA OnPaint → shared frame buffer. buffer holds the FULL frame;
        // each dirty rect is a window into it.
        fn on_paint(
            &self,
            _browser: Option<&mut Browser>,
            type_: PaintElementType,
            dirty_rects: Option<&[CefRect]>,
            buffer: *const u8,
            width: ::std::os::raw::c_int,
            height: ::std::os::raw::c_int,
        ) {
            if type_ != PaintElementType::VIEW
                || buffer.is_null()
                || width <= 0
                || height <= 0
            {
                return;
            }
            let (w, h) = (width as u32, height as u32);
            let stride = w as usize * 4;
            let full = unsafe { std::slice::from_raw_parts(buffer, stride * h as usize) };
            let mut core = self.shared.lock();
            if core.frame.w != w || core.frame.h != h {
                core.frame.resize(w, h);
            }
            let empty: &[CefRect] = &[];
            for r in dirty_rects.unwrap_or(empty) {
                if r.width <= 0 || r.height <= 0 {
                    continue;
                }
                let (x, y) = (r.x.max(0) as u32, r.y.max(0) as u32);
                let off = r.y.max(0) as usize * stride + r.x.max(0) as usize * 4;
                core.frame.write_rows(
                    Rect::new(x, y, r.width as u32, r.height as u32),
                    &full[off.min(full.len())..],
                    stride,
                );
            }
        }
    }
}

fn cursor_css(t: CursorType) -> &'static str {
    if t == CursorType::POINTER { "default" }
    else if t == CursorType::HAND { "pointer" }
    else if t == CursorType::IBEAM { "text" }
    else if t == CursorType::CROSS { "crosshair" }
    else if t == CursorType::WAIT { "wait" }
    else if t == CursorType::HELP { "help" }
    else if t == CursorType::EASTRESIZE { "e-resize" }
    else if t == CursorType::NORTHRESIZE { "n-resize" }
    else if t == CursorType::NORTHEASTRESIZE { "ne-resize" }
    else if t == CursorType::NORTHWESTRESIZE { "nw-resize" }
    else if t == CursorType::SOUTHRESIZE { "s-resize" }
    else if t == CursorType::SOUTHEASTRESIZE { "se-resize" }
    else if t == CursorType::SOUTHWESTRESIZE { "sw-resize" }
    else if t == CursorType::WESTRESIZE { "w-resize" }
    else if t == CursorType::NORTHSOUTHRESIZE { "ns-resize" }
    else if t == CursorType::EASTWESTRESIZE { "ew-resize" }
    else if t == CursorType::NORTHEASTSOUTHWESTRESIZE { "nesw-resize" }
    else if t == CursorType::NORTHWESTSOUTHEASTRESIZE { "nwse-resize" }
    else if t == CursorType::COLUMNRESIZE { "col-resize" }
    else if t == CursorType::ROWRESIZE { "row-resize" }
    else if t == CursorType::MOVE { "move" }
    else if t == CursorType::VERTICALTEXT { "vertical-text" }
    else if t == CursorType::CELL { "cell" }
    else if t == CursorType::CONTEXTMENU { "context-menu" }
    else if t == CursorType::ALIAS { "alias" }
    else if t == CursorType::PROGRESS { "progress" }
    else if t == CursorType::NODROP { "no-drop" }
    else if t == CursorType::COPY { "copy" }
    else if t == CursorType::NONE { "none" }
    else if t == CursorType::NOTALLOWED { "not-allowed" }
    else if t == CursorType::ZOOMIN { "zoom-in" }
    else { "default" }
}

wrap_display_handler! {
    struct ViewDisplay {
        shared: Arc<ViewShared>,
    }

    impl DisplayHandler {
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            source: Option<&CefString>,
            line: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            let lvl = if level == LogSeverity::WARNING { 1 }
                else if level == LogSeverity::ERROR || level == LogSeverity::FATAL { 2 }
                else if level == LogSeverity::VERBOSE { 3 }
                else { 0 };
            let msg = message.map(|m| m.to_string()).unwrap_or_default();
            let src = source.map(|s| s.to_string()).unwrap_or_default();
            self.shared.lock().events.push(ev_console(
                lvl,
                &format!("{src}:{line}: {msg}"),
            ));
            1 // handled — keep CEF's own console spew off stderr
        }

        fn on_cursor_change(
            &self,
            _browser: Option<&mut Browser>,
            _cursor: ::std::os::raw::c_ulong,
            type_: CursorType,
            _custom_cursor_info: Option<&CursorInfo>,
        ) -> ::std::os::raw::c_int {
            self.shared
                .lock()
                .events
                .push(ev_cursor(cursor_css(type_)));
            1
        }
    }
}

wrap_life_span_handler! {
    struct ViewLifeSpan {
        shared: Arc<ViewShared>,
    }

    impl LifeSpanHandler {
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            // Browser teardown → mark the view crashed so the host sees a
            // terminal state rather than a silent hang.
            let mut core = self.shared.lock();
            if core.status == STATUS_RUNNING {
                core.status = common::STATUS_CRASHED;
                core.events.push(ev_status("crashed"));
            }
        }
    }
}

wrap_load_handler! {
    struct ViewLoad {
        shared: Arc<ViewShared>,
    }

    impl LoadHandler {
        fn on_loading_state_change(
            &self,
            browser: Option<&mut Browser>,
            is_loading: ::std::os::raw::c_int,
            can_go_back: ::std::os::raw::c_int,
            can_go_forward: ::std::os::raw::c_int,
        ) {
            let url = browser
                .and_then(|b| b.main_frame())
                .map(|f| userfree_to_string(f.url()))
                .unwrap_or_default();
            let mut core = self.shared.lock();
            core.events.push(format!(
                "{{\"t\":\"nav\",\"url\":\"{}\",\"canBack\":{},\"canFwd\":{},\"loading\":{}}}",
                json_escape(&url),
                can_go_back != 0,
                can_go_forward != 0,
                is_loading != 0,
            ));
            if is_loading == 0 && !url.is_empty() {
                core.events.push(format!(
                    "{{\"t\":\"load\",\"url\":\"{}\"}}",
                    json_escape(&url)
                ));
            }
        }
    }
}

wrap_request_handler! {
    struct ViewRequest {
        shared: Arc<ViewShared>,
    }

    impl RequestHandler {
        fn on_render_process_terminated(
            &self,
            _browser: Option<&mut Browser>,
            _status: TerminationStatus,
            _error_code: ::std::os::raw::c_int,
            _error_string: Option<&CefString>,
        ) {
            self.shared.lock().record_crash();
        }
    }
}

wrap_client! {
    struct ViewClient {
        render: RenderHandler,
        shared: Arc<ViewShared>,
    }

    impl Client {
        fn render_handler(&self) -> Option<RenderHandler> {
            Some(self.render.clone())
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(ViewDisplay::new(self.shared.clone()))
        }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(ViewLifeSpan::new(self.shared.clone()))
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(ViewLoad::new(self.shared.clone()))
        }
        fn request_handler(&self) -> Option<RequestHandler> {
            Some(ViewRequest::new(self.shared.clone()))
        }

        // Renderer → browser messages: eval results and page postMessage.
        fn on_process_message_received(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut cef::Frame>,
            _source_process: ProcessId,
            message: Option<&mut ProcessMessage>,
        ) -> ::std::os::raw::c_int {
            let Some(msg) = message else { return 0 };
            let name = userfree_to_string(msg.name());
            let Some(args) = msg.argument_list() else { return 0 };
            let arg = |i: usize| userfree_to_string(args.string(i));
            match name.as_str() {
                bridge::MSG_EVAL_RES => {
                    let req: u64 = arg(0).parse().unwrap_or(0);
                    let ok = arg(1) == "1";
                    self.shared
                        .lock()
                        .events
                        .push(ev_eval(req, ok, &arg(2)));
                    1
                }
                bridge::MSG_MSG => {
                    self.shared.lock().events.push(ev_message(&arg(0)));
                    1
                }
                _ => 0,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// App — browser-process role: command-line hygiene for software OSR.
// ---------------------------------------------------------------------------

wrap_app! {
    struct BrowserApp {}

    impl App {
        fn on_before_command_line_processing(
            &self,
            _process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            // Software OSR — no GPU process, CPU OnPaint buffers. These
            // apply to browser + subprocess launches alike.
            let Some(cmd) = command_line else { return };
            for sw in [
                "disable-gpu",
                "disable-gpu-compositing",
                "mute-audio",
                "disable-features=AudioServiceOutOfProcess",
            ] {
                cmd.append_switch(Some(&cef_str(sw)));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// View — backend state + shared core
// ---------------------------------------------------------------------------

struct View {
    /// Registry busy flag (FFI claims).
    busy: AtomicBool,
    shared: Arc<ViewShared>,
    browser: Mutex<Option<Browser>>,
    /// Recreate params for recover().
    url: Mutex<String>,
    frame_rate: c_int,
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
        // Release must survive both `return` inside a body (closure call)
        // and a panic unwind (RAII guard) — a leaked busy flag wedges
        // every later claim.
        struct BusyRelease(*mut View);
        impl Drop for BusyRelease {
            fn drop(&mut self) {
                Registry::release(self.0, busy_of);
            }
        }
        let _guard = BusyRelease(h);
        (|$v: &mut View| $body)(unsafe { &mut *h })
    }};
}

fn data_url(html: &str) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b = html.as_bytes();
    let mut out = String::with_capacity(28 + b.len() * 4 / 3);
    out.push_str("data:text/html;base64,");
    for c in b.chunks(3) {
        let n = c.iter().fold(0u32, |a, &x| (a << 8) | x as u32) << (8 * (3 - c.len()));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn spawn_browser(v: &View, url: &str) -> bool {
    let render = OsrRenderHandler::new(v.shared.clone());
    let mut client = ViewClient::new(render, v.shared.clone());
    let window_info = WindowInfo {
        windowless_rendering_enabled: 1,
        ..Default::default()
    };
    let browser_settings = BrowserSettings {
        windowless_frame_rate: v.frame_rate,
        background_color: if v.transparent { 0 } else { 0xFF00_0000 },
        ..Default::default()
    };
    let url = cef_str(url);
    let browser = browser_host_create_browser_sync(
        Some(&window_info),
        Some(&mut client),
        Some(&url),
        Some(&browser_settings),
        None,
        None,
    );
    let ok = browser.is_some();
    *v.browser.lock().unwrap_or_else(|e| e.into_inner()) = browser;
    ok
}

fn browser_of(v: &View) -> Option<Browser> {
    v.browser.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Send a process message to the view's renderer.
fn send_to_render(v: &View, name: &str, args: &[String]) {
    let Some(browser) = browser_of(v) else { return };
    let Some(frame) = browser.main_frame() else { return };
    let mut msg = match process_message_create(Some(&cef_str(name))) {
        Some(m) => m,
        None => return,
    };
    if let Some(list) = msg.argument_list() {
        list.set_size(args.len());
        for (i, a) in args.iter().enumerate() {
            list.set_string(i, Some(&cef_str(a)));
        }
    }
    frame.send_process_message(ProcessId::RENDERER, Some(&mut msg));
}

fn pump() {
    if INITIALIZED.load(Ordering::Acquire) {
        do_message_loop_work();
    }
}

// ---------------------------------------------------------------------------
// ABI — lifecycle
// ---------------------------------------------------------------------------

/// opts_json: {"cefDir","cachePath","helperPath","userAgent","externalMessagePump","remoteDebugPort","logLevel"}
#[no_mangle]
pub extern "C" fn dd_webui_global_init(opts_json: *const c_char) -> c_int {
    ftry!(-1, {
        if INITIALIZED.swap(true, Ordering::AcqRel) {
            return 0; // already up
        }
        let opts = unsafe { cstr(opts_json) }.unwrap_or("{}").to_string();

        let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
        let args = Args::new();
        let cmd = args.as_cmd_line();
        let is_browser = cmd
            .map(|c| c.has_switch(Some(&cef_str("type"))) != 1)
            .unwrap_or(true);
        let mut app = BrowserApp::new();
        let ret = execute_process(
            Some(args.as_main_args()),
            Some(&mut app),
            ptr::null_mut(),
        );
        if !is_browser || ret != -1 {
            // We're a subprocess re-exec or CEF already ran the process —
            // bail; the helper bin owns subprocess flow.
            INITIALIZED.store(false, Ordering::Release);
            return -2;
        }

        let cef_dir = resolve_cef_dir(&opts);
        let helper = helper_path(&opts, &cef_dir);
        let cache = opt_str(&opts, "cachePath")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("downdraft-webui-cef"));
        let _ = std::fs::create_dir_all(&cache);
        let locales = cef_dir.join("locales");

        let settings = Settings {
            windowless_rendering_enabled: 1,
            external_message_pump: 1,
            no_sandbox: 1,
            browser_subprocess_path: cef_str(&helper.to_string_lossy()),
            resources_dir_path: cef_str(&cef_dir.to_string_lossy()),
            locales_dir_path: cef_str(&locales.to_string_lossy()),
            root_cache_path: cef_str(&cache.to_string_lossy()),
            log_severity: match opt_i64(&opts, "logLevel") {
                Some(0) => LogSeverity::VERBOSE,
                Some(1) => LogSeverity::INFO,
                Some(3) => LogSeverity::ERROR,
                Some(4) => LogSeverity::FATAL,
                _ => LogSeverity::WARNING,
            },
            remote_debugging_port: opt_i64(&opts, "remoteDebugPort")
                .unwrap_or(0) as c_int,
            ..Default::default()
        };

        let mut app = BrowserApp::new();
        if initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(&mut app),
            ptr::null_mut(),
        ) != 1
        {
            INITIALIZED.store(false, Ordering::Release);
            return -3;
        }
        0
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_global_shutdown() {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if INITIALIZED.swap(false, Ordering::AcqRel) {
            shutdown();
        }
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_backend() -> *const c_char {
    BACKEND.as_ptr().cast()
}

#[no_mangle]
pub extern "C" fn dd_webui_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "-cef154\0")
        .as_ptr()
        .cast()
}

/// opts_json: {"url","html","transparent","interactive","frameRate",
/// "userAgent","maxCrashRetries"}. width/height are logical (CSS) px —
/// the raster is w*scale × h*scale physical px.
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
        let (lw, lh) = (width.max(1) as u32, height.max(1) as u32);
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let (rw, rh) = (
            (lw as f32 * scale).round().max(1.0) as u32,
            (lh as f32 * scale).round().max(1.0) as u32,
        );
        let transparent = opt_bool(opts, "transparent").unwrap_or(true);
        let url = opt_str(opts, "url")
            .or_else(|| opt_str(opts, "html").map(|h| data_url(&h)))
            .unwrap_or_else(|| "about:blank".to_string());
        let frame_rate = opt_i64(opts, "frameRate").unwrap_or(60).clamp(1, 240) as c_int;

        let shared = Arc::new(ViewShared {
            core: Mutex::new(ViewCore::new(rw, rh, 1)), // BGRA
            w: AtomicU32::new(lw),
            h: AtomicU32::new(lh),
            scale_bits: AtomicU32::new(scale.to_bits()),
        });
        if let Some(b) = opt_bool(opts, "interactive") {
            shared.lock().interactive = b;
        }
        if let Some(n) = opt_i64(opts, "maxCrashRetries") {
            shared.lock().max_crash_retries = n as i32;
        }

        let view = Box::new(View {
            busy: AtomicBool::new(false),
            shared,
            browser: Mutex::new(None),
            url: Mutex::new(url.clone()),
            frame_rate,
            transparent,
        });
        if !spawn_browser(&view, &url) {
            return ptr::null_mut();
        }
        let h = Box::into_raw(view);
        Registry::register(h as usize);
        do_message_loop_work();
        h.cast()
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
        let view = unsafe { Box::from_raw(v) };
        if let Some(b) = browser_of(&view) {
            if let Some(host) = b.host() {
                host.close_browser(1);
            }
        }
        drop(view);
        pump();
    }));
}

// ---------------------------------------------------------------------------
// ABI — navigation / content
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn dd_webui_load_url(h: *mut c_void, url: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(url) = (unsafe { cstr(url) }) else { return };
            *v.url.lock().unwrap_or_else(|e| e.into_inner()) = url.to_string();
            if let Some(f) = browser_of(v).and_then(|b| b.main_frame()) {
                f.load_url(Some(&cef_str(url)));
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_content(h: *mut c_void, html: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(html) = (unsafe { cstr(html) }) else { return };
            let url = data_url(html);
            *v.url.lock().unwrap_or_else(|e| e.into_inner()) = url.clone();
            if let Some(f) = browser_of(v).and_then(|b| b.main_frame()) {
                f.load_url(Some(&cef_str(&url)));
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_resize(h: *mut c_void, w: c_int, hgt: c_int, scale: f32) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let (lw, lh) = (w.max(1) as u32, hgt.max(1) as u32);
            let scale = if scale > 0.0 { scale } else { 1.0 };
            v.shared.w.store(lw, Ordering::Relaxed);
            v.shared.h.store(lh, Ordering::Relaxed);
            v.shared
                .scale_bits
                .store(scale.to_bits(), Ordering::Relaxed);
            let (rw, rh) = (
                (lw as f32 * scale).round().max(1.0) as u32,
                (lh as f32 * scale).round().max(1.0) as u32,
            );
            v.shared.lock().frame.resize(rw, rh);
            if let Some(host) = browser_of(v).and_then(|b| b.host()) {
                host.was_resized();
            }
            pump();
        });
    }));
}

/// op: 0=back 1=forward 2=reload 3=stop
#[no_mangle]
pub extern "C" fn dd_webui_navigate(h: *mut c_void, op: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(b) = browser_of(v) else { return };
            match op {
                0 => b.go_back(),
                1 => b.go_forward(),
                2 => b.reload(),
                _ => b.stop_load(),
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_zoom(h: *mut c_void, factor: f64) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if factor <= 0.0 {
                return;
            }
            // CEF zoom levels are step counts (each step = ×1.2).
            if let Some(host) = browser_of(v).and_then(|b| b.host()) {
                host.set_zoom_level(factor.ln() / 1.2f64.ln());
            }
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_set_focus(h: *mut c_void, focused: c_int) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if let Some(host) = browser_of(v).and_then(|b| b.host()) {
                host.set_focus(focused);
            }
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

/// Fire-and-forget eval; the result arrives as {"t":"eval","id":req,...}.
/// req rides to the renderer as a string arg (CefListValue has no u64).
#[no_mangle]
pub extern "C" fn dd_webui_eval(h: *mut c_void, req: u64, js: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(code) = (unsafe { cstr(js) }) else { return };
            send_to_render(v, bridge::MSG_EVAL, &[req.to_string(), code.to_string()]);
            pump();
        });
    }));
}

/// Deliver a JSON payload to the page's window.downdraft dispatch.
#[no_mangle]
pub extern "C" fn dd_webui_post_message(h: *mut c_void, json: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(json) = (unsafe { cstr(json) }) else { return };
            send_to_render(v, bridge::MSG_POST, &[json.to_string()]);
            pump();
        });
    }));
}

/// Drain queued events as one JSON array. (ptr,len) stay valid until the
/// next call on this view. Returns event-batch presence (0 = empty).
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
        pump(); // event-producing work runs on this thread — tick first
        with_view!(h, 0, |v| {
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

fn cef_mods(mods: c_int) -> u32 {
    // our mask: 1=shift 2=ctrl 4=alt 8=meta → CEF event flags
    let mut m = 0u32;
    if mods & 1 != 0 {
        m |= sys::cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0;
    }
    if mods & 2 != 0 {
        m |= sys::cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0;
    }
    if mods & 4 != 0 {
        m |= sys::cef_event_flags_t::EVENTFLAG_ALT_DOWN.0;
    }
    if mods & 8 != 0 {
        m |= sys::cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0;
    }
    m
}

fn mouse_button(btn: c_int) -> MouseButtonType {
    match btn {
        2 => MouseButtonType::MIDDLE,
        3 => MouseButtonType::RIGHT,
        _ => MouseButtonType::LEFT,
    }
}

/// t: 0=move 1=down 2=up 3=leave. btn: 0=none 1=left 2=middle 3=right.
#[no_mangle]
pub extern "C" fn dd_webui_input_pointer(
    h: *mut c_void,
    t: c_int,
    x: f32,
    y: f32,
    btn: c_int,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(host) = browser_of(v).and_then(|b| b.host()) else {
                return;
            };
            let mut modifiers = 0u32;
            match btn {
                1 => modifiers |= sys::cef_event_flags_t::EVENTFLAG_LEFT_MOUSE_BUTTON.0,
                2 => modifiers |= sys::cef_event_flags_t::EVENTFLAG_MIDDLE_MOUSE_BUTTON.0,
                3 => modifiers |= sys::cef_event_flags_t::EVENTFLAG_RIGHT_MOUSE_BUTTON.0,
                _ => {}
            }
            let me = MouseEvent {
                x: x as i32,
                y: y as i32,
                modifiers,
            };
            match t {
                1 => host.send_mouse_click_event(Some(&me), mouse_button(btn), 0, 1),
                2 => host.send_mouse_click_event(Some(&me), mouse_button(btn), 1, 1),
                _ => host.send_mouse_move_event(Some(&me), (t == 3) as c_int),
            }
            pump();
        });
    }));
}

#[no_mangle]
pub extern "C" fn dd_webui_input_wheel(
    h: *mut c_void,
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(host) = browser_of(v).and_then(|b| b.host()) else {
                return;
            };
            let me = MouseEvent {
                x: x as i32,
                y: y as i32,
                modifiers: 0,
            };
            host.send_mouse_wheel_event(Some(&me), dx as i32, dy as i32);
            pump();
        });
    }));
}

/// Minimal W3C key→VKEY table — enough for navigation/editing keys;
/// printable chars ride the CHAR event regardless.
fn vkey_of(key: &str, code: &str) -> i32 {
    let named = match key {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "Shift" => 0x10,
        "Control" => 0x11,
        "Alt" => 0x12,
        "Escape" => 0x1B,
        " " | "Spacebar" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "Meta" | "OS" => 0x5B,
        "ContextMenu" => 0x5D,
        _ => 0,
    };
    if named != 0 {
        return named;
    }
    if let Some(f) = key.strip_prefix('F') {
        if let Ok(n) = f.parse::<i32>() {
            if (1..=12).contains(&n) {
                return 0x6F + n; // VK_F1 = 0x70
            }
        }
    }
    // Single printable chars — Windows VK is the uppercase ASCII code.
    let c = key.chars().next().unwrap_or('\0');
    if c.is_ascii_alphanumeric() {
        return c.to_ascii_uppercase() as i32;
    }
    if let Some(n) = code.strip_prefix("Numpad").and_then(|s| s.parse::<i32>().ok()) {
        return 0x60 + n;
    }
    0
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
            let Some(host) = browser_of(v).and_then(|b| b.host()) else {
                return;
            };
            let key = unsafe { cstr(key) }.unwrap_or("");
            let code = unsafe { cstr(code) }.unwrap_or("");
            let text = unsafe { cstr(text) }.unwrap_or("");
            let vk = vkey_of(key, code);
            let m = cef_mods(mods);
            let ch = text.chars().next().map(|c| c as u16).unwrap_or(0);
            if t == 0 {
                host.send_key_event(Some(&KeyEvent {
                    type_: KeyEventType::RAWKEYDOWN,
                    modifiers: m,
                    windows_key_code: vk,
                    native_key_code: vk,
                    is_system_key: 0,
                    character: ch,
                    unmodified_character: ch,
                    focus_on_editable_field: 0,
                    ..Default::default()
                }));
                if ch != 0 {
                    host.send_key_event(Some(&KeyEvent {
                        type_: KeyEventType::CHAR,
                        modifiers: m,
                        windows_key_code: vk,
                        native_key_code: 0,
                        is_system_key: 0,
                        character: ch,
                        unmodified_character: ch,
                        focus_on_editable_field: 0,
                        ..Default::default()
                    }));
                }
            } else {
                host.send_key_event(Some(&KeyEvent {
                    type_: KeyEventType::KEYUP,
                    modifiers: m,
                    windows_key_code: vk,
                    native_key_code: vk,
                    is_system_key: 0,
                    character: ch,
                    unmodified_character: ch,
                    focus_on_editable_field: 0,
                    ..Default::default()
                }));
            }
            pump();
        });
    }));
}

/// t: 0=down 1=move 2=up 3=cancel.
#[no_mangle]
pub extern "C" fn dd_webui_input_touch(
    h: *mut c_void,
    t: c_int,
    id: c_int,
    x: f32,
    y: f32,
) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            let Some(host) = browser_of(v).and_then(|b| b.host()) else {
                return;
            };
            host.send_touch_event(Some(&TouchEvent {
                id,
                x,
                y,
                radius_x: 5.0,
                radius_y: 5.0,
                rotation_angle: 0.0,
                pressure: 1.0,
                type_: match t {
                    0 => TouchEventType::PRESSED,
                    1 => TouchEventType::MOVED,
                    3 => TouchEventType::CANCELLED,
                    _ => TouchEventType::RELEASED,
                },
                modifiers: 0,
                pointer_type: PointerType::TOUCH,
            }));
            pump();
        });
    }));
}

/// t: 0=preedit 1=commit 2=cancel. IME plumbing lands in Phase 6 —
/// commits route as CHAR events so basic text entry works.
#[no_mangle]
pub extern "C" fn dd_webui_input_ime(h: *mut c_void, t: c_int, s: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        with_view!(h, (), |v| {
            if t != 1 {
                return;
            }
            let Some(host) = browser_of(v).and_then(|b| b.host()) else {
                return;
            };
            let Some(text) = (unsafe { cstr(s) }) else { return };
            for c in text.chars() {
                let ch = c as u16;
                host.send_key_event(Some(&KeyEvent {
                    type_: KeyEventType::CHAR,
                    modifiers: 0,
                    windows_key_code: 0,
                    native_key_code: 0,
                    is_system_key: 0,
                    character: ch,
                    unmodified_character: ch,
                    focus_on_editable_field: 0,
                    ..Default::default()
                }));
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
        pump(); // OnPaint lands on this thread — tick before reading
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

/// Rect of the frame `take_frame` last produced (the dirty union is
/// consumed by the pull, so this reports the remembered last rect).
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
        with_view!(h, 0, |v| v.shared.lock().frame.pending() as c_int)
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_pixels(h: *mut c_void) -> *const u8 {
    ftry!(ptr::null(), {
        with_view!(h, ptr::null(), |v| {
            let core = v.shared.lock();
            let p = core.frame.pixels().as_ptr();
            // The pointer escapes the lock — the frame buffer's Vec is
            // allocation-stable across locks (resize is the only realloc
            // and callers re-pull pixels() after dimension changes), but
            // a concurrent write could still race the read. The host pulls
            // synchronously between take_frame calls, so this is the same
            // aliasing contract blitz-osr's SAB path already has.
            p
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

/// Pixel-format tag — 0=RGBA8, 1=BGRA8 (CEF paints BGRA natively).
#[no_mangle]
pub extern "C" fn dd_webui_pixel_format(h: *mut c_void) -> u8 {
    ftry!(1, {
        with_view!(h, 1, |v| v.shared.lock().frame.pixel_format)
    })
}

// ---------------------------------------------------------------------------
// ABI — shared-memory frame channel (same header contract as dd_osr_*)
// ---------------------------------------------------------------------------

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
        with_view!(h, -1, |v| v.shared.lock().frame.frame_into(false))
    })
}

#[no_mangle]
pub extern "C" fn dd_webui_refresh_into(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| v.shared.lock().frame.frame_into(true))
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
            let core = v.shared.lock();
            if !core.interactive || x < 0.0 || y < 0.0 {
                return 0;
            }
            let (fx, fy) = (x.floor() as u32, y.floor() as u32);
            if fx >= core.frame.w || fy >= core.frame.h {
                return 0;
            }
            // Opaque views present as solid — hit is a pure bounds check.
            // Alpha-aware testing only applies to transparent views (and
            // only where a frame has actually been painted).
            if !v.transparent {
                return 1;
            }
            if !core.frame.painted() {
                return 0;
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

/// Respawn a crashed/failed browser under the same view. -1 = refused.
#[no_mangle]
pub extern "C" fn dd_webui_recover(h: *mut c_void) -> c_int {
    ftry!(-1, {
        with_view!(h, -1, |v| {
            let status = v.shared.lock().status;
            if status == STATUS_RUNNING {
                return 1; // nothing to recover
            }
            if let Some(b) = browser_of(v) {
                if let Some(host) = b.host() {
                    host.close_browser(1);
                }
            }
            *v.browser.lock().unwrap_or_else(|e| e.into_inner()) = None;
            let url = v.url.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if !spawn_browser(v, &url) {
                return -1;
            }
            v.shared.lock().status = STATUS_RUNNING;
            v.shared.lock().events.push(ev_status("running"));
            pump();
            1
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

/// External-pump tick — CefDoMessageLoopWork. The host calls this from
/// its drain timer; frame pulls also pump implicitly.
#[no_mangle]
pub extern "C" fn dd_webui_pump_ms(_t_ms: u64) {
    let _ = catch_unwind(AssertUnwindSafe(|| pump()));
}
