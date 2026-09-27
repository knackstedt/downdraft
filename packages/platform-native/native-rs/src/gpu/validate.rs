//! Build-time WGSL validation via naga — replaces the external `tint` binary.
//!
//! Runs the same frontend (`naga::front::wgsl`) and validator
//! (`naga::valid::Validator`) that `wgpu` applies when a shader module is
//! created, so build-time diagnostics match runtime behavior exactly.

use std::ffi::c_char;
use wgpu::naga;

/// Validate WGSL source.
///
/// Returns 0 when the source is valid. Otherwise returns the byte length of
/// the UTF-8 diagnostic message; when `out`/`out_cap` are provided, the
/// message is written into `out` truncated to `out_cap` bytes (callers can
/// probe the length first with a null/0 buffer, then fetch it).
#[no_mangle]
pub extern "C" fn dd_wgsl_validate(
    src: *const c_char,
    src_len: u32,
    out: *mut u8,
    out_cap: u32,
) -> u32 {
    ffi!(0u32, {
        let msg = validate_message(src, src_len);
        match msg {
            None => 0,
            Some(m) => {
                if !out.is_null() && out_cap > 0 {
                    let n = (m.len() as u32).min(out_cap) as usize;
                    unsafe { std::ptr::copy_nonoverlapping(m.as_ptr(), out, n) };
                }
                m.len() as u32
            }
        }
    })
}

/// Returns `None` when valid, `Some(diagnostic)` on error.
fn validate_message(src: *const c_char, src_len: u32) -> Option<String> {
    if src.is_null() {
        return Some("null source pointer".to_string());
    }
    let bytes = unsafe { std::slice::from_raw_parts(src as *const u8, src_len as usize) };
    let source = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => return Some(format!("invalid UTF-8: {e}")),
    };

    let module = match naga::front::wgsl::parse_str(source) {
        Ok(m) => m,
        Err(e) => return Some(e.emit_to_string_with_path(source, "shader.wgsl")),
    };

    // Same validation wgpu runs at create_shader_module time.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    match validator.validate(&module) {
        Ok(_) => None,
        Err(e) => Some(e.emit_to_string_with_path(source, "shader.wgsl")),
    }
}
