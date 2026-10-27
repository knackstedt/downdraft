//! libdowndraft_platform — unified native platform library.
//!
//! Single cdylib replacing the C shims (wgpu_shim / sdl_shim / image_shim /
//! font_shim). Every export keeps the exact symbol name + ABI consumed by the
//! TypeScript FFI specs under `packages/platform-native/src/` — the flat
//! argument lists, int-slot event buffer layout, SDL3-derived keycode values, and
//! webgpu.h (v29) enum numbering on the wire are all part of the contract.
//!
//! Porting order (each phase adds a module):
//!   image.rs    — image_shim_*  (image crate, replaces stb_image)
//!   text.rs     — ft_shim_*     (cosmic-text, replaces SDL2_ttf)
//!   window/     — dd_window_*    (winit, replaces SDL2)
//!   gpu/        — wgpu_shim_*   (wgpu crate, replaces wgpu-native)
//!   validate.rs — dd_wgsl_validate (naga, replaces the tint binary)
//!
//! Rules for every `extern "C"` export:
//!   - wrap the body in `std::panic::catch_unwind` (panics across FFI are UB);
//!   - pointers arriving from JS are handles minted by `Box::into_raw` and must
//!     only be released through the matching `*_release_*` export;
//!   - a null handle parameter is a no-op returning the error/zero value, same
//!     as the C shims.

/// ABI version — bump whenever the exported symbol surface changes in a
/// breaking way (symbol renames, signature changes, event wire-format
/// changes). The JS side asserts this at dlopen time
/// (packages/platform-native/src/ffi/abi.ts) so a stale .so fails loudly at
/// load instead of producing blank windows or corrupt calls.
/// v2: the Vulkan ICD filter defers llvmpipe (lvp) to a dedicated software-
/// tier instance — pre-v2 JS requests the fallback adapter on the primary
/// instance and silently fails when lvp isn't enumerated there.
pub const DD_ABI_VERSION: u32 = 2;

/// ABI handshake export — the only symbol whose name must never change.
#[no_mangle]
pub extern "C" fn dd_abi_version() -> u32 {
    DD_ABI_VERSION
}

#[macro_use]
mod ffi;
mod dialog;
mod gpu;
mod image;
mod menu;
#[cfg(not(target_os = "android"))]
mod pty;
pub mod text;
mod window;

/// Android entry point — the shell crate's `android_main` hands the
/// `AndroidApp` to this on the app thread; it runs winit's `run_app` and never
/// returns. See window/android.rs.
#[cfg(target_os = "android")]
pub use window::android::run_app as downdraft_platform_run_android_app;
