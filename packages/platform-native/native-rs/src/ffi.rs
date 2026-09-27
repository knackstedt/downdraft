//! FFI helpers — the panic boundary every export must respect.

/// Wrap an `extern "C"` body: catch unwinds, return `err` on panic.
/// The default panic hook still prints the panic message + location to
/// stderr, so `err` only needs to be the ABI-level failure value.
///
/// Usage: `ffi!(ERR_CODE, { ...body... })` — the body may use `return`
/// normally (it returns from the enclosing extern fn either way).
#[macro_export]
macro_rules! ffi {
    ($err:expr, $body:expr) => {
        match ::std::panic::catch_unwind(::std::panic::AssertUnwindSafe(|| $body)) {
            Ok(v) => v,
            Err(_) => $err,
        }
    };
}
