// ============================================================================
// downdraft-raw-input — Native raw mouse capture (napi-rs)
// ============================================================================

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;

mod platform;

use platform::CaptureBackend;

static mut BACKEND: Option<CaptureBackend> = None;

fn with_backend<F, R>(f: F) -> R
where
    F: FnOnce(&mut CaptureBackend) -> R,
{
    // SAFETY: The backend is only accessed from the main thread (Electron's
    // main process is single-threaded for IPC handlers). The native capture
    // thread communicates via the napi ThreadsafeFunction callback, not via
    // direct backend access.
    unsafe {
        if BACKEND.is_none() {
            BACKEND = Some(CaptureBackend::new());
        }
        f(BACKEND.as_mut().unwrap())
    }
}

#[napi]
pub fn detect_platform() -> String {
    platform::Platform::detect().as_str().to_string()
}

/// Begin raw mouse capture for the given window handle.
/// `window_handle` is the Buffer from BrowserWindow.getNativeWindowHandle().
/// `callback` is called with (dx, dy) raw mouse deltas.
#[napi]
pub fn start_capture(
    window_handle: Buffer,
    callback: ThreadsafeFunction<(f64, f64), ErrorStrategy::CalleeHandled>,
) -> Result<()> {
    let handle_slice = window_handle.to_vec();
    with_backend(|b| b.start(&handle_slice, callback))
}

/// Stop raw mouse capture and restore the cursor.
#[napi]
pub fn stop_capture() -> Result<()> {
    with_backend(|b| b.stop())
}

/// Set the OS cursor visibility.
#[napi]
pub fn set_cursor_visible(visible: bool) -> Result<()> {
    with_backend(|b| b.set_cursor_visible(visible))
}

/// Get the current capture status.
#[napi(object)]
pub struct CaptureStatus {
    pub platform: String,
    pub capturing: bool,
    pub detail: String,
}

#[napi]
pub fn get_status() -> CaptureStatus {
    with_backend(|b| {
        let status = b.status();
        CaptureStatus {
            platform: status.platform.to_string(),
            capturing: status.capturing,
            detail: status.detail,
        }
    })
}
