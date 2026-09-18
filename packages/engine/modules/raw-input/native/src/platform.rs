// ============================================================================
// Platform dispatch — selects the appropriate raw input backend
// ============================================================================

use napi::bindgen_prelude::Result;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod linux;

#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(not(target_os = "linux"))]
#[path = "stub.rs"]
mod stub;
#[cfg(not(target_os = "linux"))]
use stub as backend;

/// Detected platform for raw input.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    X11,
    Wayland,
    Win32,
    Macos,
    Unsupported,
}

impl Platform {
    pub fn detect() -> Self {
        #[cfg(target_os = "linux")]
        {
            return linux::detect_platform();
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Platform::Unsupported;
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Platform::X11 => "x11",
            Platform::Wayland => "wayland",
            Platform::Win32 => "win32",
            Platform::Macos => "macos",
            Platform::Unsupported => "unsupported",
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub struct CaptureStatus {
    pub platform: Platform,
    pub capturing: bool,
    pub detail: String,
}

/// The active capture backend (X11, Wayland, etc.).
pub struct CaptureBackend {
    inner: backend::Backend,
}

impl CaptureBackend {
    pub fn new() -> Self {
        Self {
            inner: backend::Backend::new(),
        }
    }

    pub fn start(
        &mut self,
        window_handle: &[u8],
        callback: ThreadsafeFunction<(f64, f64), ErrorStrategy::CalleeHandled>,
    ) -> Result<()> {
        self.inner.start(window_handle, callback)
    }

    pub fn stop(&mut self) -> Result<()> {
        self.inner.stop()
    }

    pub fn set_cursor_visible(&mut self, visible: bool) -> Result<()> {
        self.inner.set_cursor_visible(visible)
    }

    pub fn status(&self) -> CaptureStatus {
        self.inner.status()
    }
}

// Re-export types for backend modules
pub use napi::bindgen_prelude::{Error as NapiError, Result as NapiResult};
