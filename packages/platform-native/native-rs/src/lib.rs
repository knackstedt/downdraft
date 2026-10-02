//! libdowndraft_platform — unified native platform library.
//!
//! Single cdylib replacing the C shims (wgpu_shim / sdl_shim / image_shim /
//! font_shim). Every export keeps the exact symbol name + ABI consumed by the
//! TypeScript FFI specs under `packages/platform-native/src/` — the flat
//! argument lists, int-slot event buffer layout, SDL3 keycode values, and
//! webgpu.h (v29) enum numbering on the wire are all part of the contract.
//!
//! Porting order (each phase adds a module):
//!   image.rs    — image_shim_*  (image crate, replaces stb_image)
//!   text.rs     — ft_shim_*     (cosmic-text, replaces SDL2_ttf)
//!   window/     — sdl_shim_*    (winit, replaces SDL2)
//!   gpu/        — wgpu_shim_*   (wgpu crate, replaces wgpu-native)
//!   validate.rs — dd_wgsl_validate (naga, replaces the tint binary)
//!
//! Rules for every `extern "C"` export:
//!   - wrap the body in `std::panic::catch_unwind` (panics across FFI are UB);
//!   - pointers arriving from JS are handles minted by `Box::into_raw` and must
//!     only be released through the matching `*_release_*` export;
//!   - a null handle parameter is a no-op returning the error/zero value, same
//!     as the C shims.

#[macro_use]
mod ffi;
mod gpu;
mod image;
pub mod text;
mod window;

/// Android entry point — the shell crate's `android_main` hands the
/// `AndroidApp` to this on the app thread; it runs winit's `run_app` and never
/// returns. See window/android.rs.
#[cfg(target_os = "android")]
pub use window::android::run_app as downdraft_platform_run_android_app;
