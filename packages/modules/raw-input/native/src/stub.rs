// ============================================================================
// Stub backend — used on platforms without a native implementation yet
// ============================================================================

use super::{CaptureStatus, Platform, NapiError, NapiResult};
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};

pub struct Backend {
    capturing: bool,
}

impl Backend {
    pub fn new() -> Self {
        Self { capturing: false }
    }

    pub fn start(
        &mut self,
        _window_handle: &[u8],
        _callback: ThreadsafeFunction<(f64, f64), ErrorStrategy::CalleeHandled>,
    ) -> NapiResult<()> {
        Err(NapiError::from_reason(
            "Raw input not implemented on this platform",
        ))
    }

    pub fn stop(&mut self) -> NapiResult<()> {
        self.capturing = false;
        Ok(())
    }

    pub fn set_cursor_visible(&mut self, _visible: bool) -> NapiResult<()> {
        Ok(())
    }

    pub fn status(&self) -> CaptureStatus {
        CaptureStatus {
            platform: Platform::Unsupported,
            capturing: self.capturing,
            detail: "No native backend on this platform".to_string(),
        }
    }
}
