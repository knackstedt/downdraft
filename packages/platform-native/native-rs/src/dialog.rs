// ============================================================================
// dialog.rs — native file dialogs, message boxes, and OS notifications
//
// File dialogs are detached blocking rfd calls (rfd::FileDialog is modal and
// blocks its thread — a dedicated thread per request keeps the JS main
// thread and event loop running). The completion arrives on the shared
// event queue as DD_EVENT_DIALOG_RESULT with kind 0=cancel, 1=ok, 2=error;
// the selected path set is NUL-joined and parked in RESULTS — a pull via
// dd_dialog_result_paths (snprintf semantics) consumes it, so a second pull
// returns 0 bytes.
//
// dd_message_box is synchronous: it runs the modal rfd::MessageDialog on the
// calling thread and returns the pressed-button index directly.
//
// DD_DIALOGS_MOCK=1 short-circuits every dialog/notification so headless CI
// never blocks on UI that cannot appear: file dialogs resolve immediately
// with DD_DIALOGS_MOCK_PATH (default /var/tmp/dd-dialog-mock), message boxes
// return 0, and notifications succeed without posting.
//
// On Android every export is a stub (-1); the FFI surface stays complete so
// lazy probing reports the same symbols on every platform.
// ============================================================================

use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::collections::HashMap;

use crate::window::events::{self, Ev};

/// Result kinds carried in DD_EVENT_DIALOG_RESULT slot 1.
pub const DIALOG_RESULT_CANCEL: i32 = 0;
pub const DIALOG_RESULT_OK: i32 = 1;
pub const DIALOG_RESULT_ERROR: i32 = 2;

#[cfg_attr(target_os = "android", allow(dead_code))]
static NEXT_REQ_ID: AtomicI32 = AtomicI32::new(1);
static RESULTS: Mutex<Option<HashMap<i32, String>>> = Mutex::new(None);

fn results() -> std::sync::MutexGuard<'static, Option<HashMap<i32, String>>> {
    let mut g = RESULTS.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn store_result(req_id: i32, paths: String) {
    if let Some(m) = results().as_mut() {
        m.insert(req_id, paths);
    }
}

fn peek_result(req_id: i32) -> Option<String> {
    results().as_ref().and_then(|m| m.get(&req_id).cloned())
}

fn take_result(req_id: i32) {
    if let Some(m) = results().as_mut() {
        m.remove(&req_id);
    }
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn mock_enabled() -> bool {
    std::env::var("DD_DIALOGS_MOCK").map(|v| v == "1").unwrap_or(false)
}

#[cfg_attr(target_os = "android", allow(dead_code))]
fn mock_path() -> String {
    std::env::var("DD_DIALOGS_MOCK_PATH")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/var/tmp/dd-dialog-mock".to_string())
}

/// Read a required C string as JSON; null/invalid → empty object.
#[cfg(not(target_os = "android"))]
fn parse_opts(opts_json: *const c_char) -> serde_json::Value {
    if opts_json.is_null() {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    let s = unsafe { std::ffi::CStr::from_ptr(opts_json) }
        .to_string_lossy()
        .into_owned();
    serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
}

#[cfg(not(target_os = "android"))]
fn opt_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "android"))]
fn opt_bool(v: &serde_json::Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

#[cfg(not(target_os = "android"))]
fn opt_i32(v: &serde_json::Value, key: &str) -> Option<i32> {
    v.get(key).and_then(|x| x.as_i64()).map(|n| n as i32)
}

// ---------------------------------------------------------------------------
// File dialogs (detached — result via DD_EVENT_DIALOG_RESULT)
// ---------------------------------------------------------------------------

/// Which picker the detached thread runs. `multi` comes from opts.
#[derive(Clone, Copy)]
#[cfg_attr(target_os = "android", allow(dead_code))]
enum Picker {
    Open,
    Save,
    Folder,
}

#[cfg(not(target_os = "android"))]
fn spawn_picker(picker: Picker, opts: serde_json::Value) -> c_int {
    let req_id = NEXT_REQ_ID.fetch_add(1, Ordering::Relaxed);

    if mock_enabled() {
        store_result(req_id, mock_path());
        events::push(0, Ev::DialogResult { req_id, kind: DIALOG_RESULT_OK });
        return req_id;
    }

    {
        let window_handle = opt_i32(&opts, "window").unwrap_or(0);
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut dlg = rfd::FileDialog::new();
            if let Some(t) = opt_str(&opts, "title") {
                dlg = dlg.set_title(t);
            }
            if let Some(d) = opt_str(&opts, "directory") {
                dlg = dlg.set_directory(d);
            }
            if let Some(n) = opt_str(&opts, "defaultName") {
                dlg = dlg.set_file_name(n);
            }
            if let Some(filters) = opts.get("filters").and_then(|f| f.as_array()) {
                for f in filters {
                    let name = opt_str(f, "name").unwrap_or("Files");
                    let exts: Vec<String> = f
                        .get("extensions")
                        .and_then(|e| e.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    dlg = dlg.add_filter(name, &exts);
                }
            }

            // Parent the dialog to a live window when one resolves — keeps it
            // modal-ish/raised on platforms that honor a transient parent.
            // window_by_handle locks CTX itself (calling it under with_ctx
            // would deadlock the non-reentrant Mutex).
            let parent = crate::window::window_by_handle(window_handle as u32);
            if let Some(w) = parent.as_deref() {
                dlg = dlg.set_parent(w);
            }

            let multi = opt_bool(&opts, "multi");
            let paths: Option<Vec<std::path::PathBuf>> = match picker {
                Picker::Open => {
                    if multi {
                        dlg.pick_files()
                    } else {
                        dlg.pick_file().map(|p| vec![p])
                    }
                }
                Picker::Save => dlg.save_file().map(|p| vec![p]),
                Picker::Folder => {
                    if multi {
                        dlg.pick_folders()
                    } else {
                        dlg.pick_folder().map(|p| vec![p])
                    }
                }
            };

            match paths {
                Some(ps) => {
                    let joined = ps
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("\0");
                    store_result(req_id, joined);
                    DIALOG_RESULT_OK
                }
                None => DIALOG_RESULT_CANCEL,
            }
            }));
            // A panic inside rfd must still resolve the JS promise — kind 2
            // carries "error" so the awaiting call rejects/returns null
            // instead of hanging on an event that never comes.
            let kind = result.unwrap_or(DIALOG_RESULT_ERROR);
            events::push(0, Ev::DialogResult { req_id, kind });
        });
        req_id
    }
}

/// dd_dialog_open(opts_json) → req_id (>0) or -1. opts: { title, directory,
/// filters:[{name,extensions[]}], multi, window } — completion arrives as
/// DD_EVENT_DIALOG_RESULT; pull paths with dd_dialog_result_paths.
#[no_mangle]
pub extern "C" fn dd_dialog_open(opts_json: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    {
        spawn_picker(Picker::Open, parse_opts(opts_json))
    }
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        -1
    }
}

/// dd_dialog_save(opts_json) → req_id or -1. opts additionally accepts
/// `defaultName` for the suggested filename.
#[no_mangle]
pub extern "C" fn dd_dialog_save(opts_json: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    {
        spawn_picker(Picker::Save, parse_opts(opts_json))
    }
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        -1
    }
}

/// dd_dialog_pick_folder(opts_json) → req_id or -1.
#[no_mangle]
pub extern "C" fn dd_dialog_pick_folder(opts_json: *const c_char) -> c_int {
    #[cfg(not(target_os = "android"))]
    {
        spawn_picker(Picker::Folder, parse_opts(opts_json))
    }
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        -1
    }
}

/// Pull the NUL-joined path list for a completed dialog request. snprintf
/// semantics: returns the full byte count the buffer needs (including the
/// NUL terminator); the standard two-call pattern is size with out=null
/// (does NOT consume), then pull with a buffer — the copying call consumes
/// the result, so a second buffered pull returns 0.
#[no_mangle]
pub extern "C" fn dd_dialog_result_paths(req_id: c_int, out: *mut c_char, max_len: usize) -> c_int {
    let joined = match peek_result(req_id) {
        Some(s) => s,
        None => {
            if !out.is_null() && max_len > 0 {
                unsafe { *out = 0 };
            }
            return 0;
        }
    };
    let bytes = CString::new(joined).unwrap_or_else(|_| CString::new("").unwrap());
    let bytes = bytes.as_bytes_with_nul();
    if out.is_null() || max_len == 0 {
        return bytes.len() as c_int;
    }
    let n = bytes.len().min(max_len);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr() as *const c_void, out as *mut c_void, n);
        *out.add(max_len - 1) = 0;
    }
    // Consumed by the successful copy — no stale data on repeat pulls.
    take_result(req_id);
    bytes.len() as c_int
}

// ---------------------------------------------------------------------------
// Message box (synchronous on the calling thread — returns button index)
// ---------------------------------------------------------------------------

/// dd_message_box(opts_json) → pressed button index (0=Ok/Yes, 1=No or
/// Cancel for ok-cancel, 2=Cancel for yes-no-cancel), or -1 on error.
/// opts: { title, message, level: "info"|"warning"|"error",
///         buttons: "ok"|"okcancel"|"yesno"|"yesnocancel", window }
#[no_mangle]
pub extern "C" fn dd_message_box(opts_json: *const c_char) -> c_int {
    if mock_enabled() {
        return 0;
    }
    #[cfg(not(target_os = "android"))]
    {
        let opts = parse_opts(opts_json);
        let title = opt_str(&opts, "title").unwrap_or("");
        let message = opt_str(&opts, "message").or_else(|| opt_str(&opts, "description")).unwrap_or("");
        let level = match opt_str(&opts, "level") {
            Some("warning") | Some("warn") => rfd::MessageLevel::Warning,
            Some("error") => rfd::MessageLevel::Error,
            _ => rfd::MessageLevel::Info,
        };
        let buttons = match opt_str(&opts, "buttons") {
            Some("okcancel") => rfd::MessageButtons::OkCancel,
            Some("yesno") => rfd::MessageButtons::YesNo,
            Some("yesnocancel") => rfd::MessageButtons::YesNoCancel,
            _ => rfd::MessageButtons::Ok,
        };
        let window_handle = opt_i32(&opts, "window").unwrap_or(0);

        let mut dlg = rfd::MessageDialog::new()
            .set_title(title)
            .set_description(message)
            .set_level(level)
            .set_buttons(buttons.clone());
        let parent = crate::window::window_by_handle(window_handle as u32);
        if let Some(w) = parent.as_deref() {
            dlg = dlg.set_parent(w);
        }
        let result = dlg.show();
        match result {
            rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Yes => 0,
            rfd::MessageDialogResult::No => 1,
            rfd::MessageDialogResult::Cancel => {
                match buttons {
                    rfd::MessageButtons::YesNoCancel | rfd::MessageButtons::YesNoCancelCustom(..) => 2,
                    _ => 1,
                }
            }
            rfd::MessageDialogResult::Custom(_) => 0,
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        -1
    }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/// dd_notify(opts_json) → 0 on success, -1 on failure. opts: { title (or
/// summary), body, icon, appName, timeoutMs }. Fire-and-forget — no event.
#[no_mangle]
pub extern "C" fn dd_notify(opts_json: *const c_char) -> c_int {
    if mock_enabled() {
        return 0;
    }
    #[cfg(not(target_os = "android"))]
    {
        let opts = parse_opts(opts_json);
        let mut n = notify_rust::Notification::new();
        if let Some(t) = opt_str(&opts, "title").or_else(|| opt_str(&opts, "summary")) {
            n.summary(t);
        }
        if let Some(b) = opt_str(&opts, "body") {
            n.body(b);
        }
        if let Some(i) = opt_str(&opts, "icon") {
            n.icon(i);
        }
        if let Some(a) = opt_str(&opts, "appName") {
            n.appname(a);
        }
        if let Some(ms) = opt_i32(&opts, "timeoutMs") {
            n.timeout(notify_rust::Timeout::Milliseconds(ms as u32));
        }
        match n.show() {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("[dd] notify failed: {e}");
                -1
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        let _ = opts_json;
        -1
    }
}
