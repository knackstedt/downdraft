//! sand-native — WASM+SIMD+threads falling-sand simulation backend.
//!
//! This crate is compiled to WASM via `wasm-pack` and loaded by the
//! falling-sand game's web workers as an alternative to the TypeScript
//! `SandWorld` implementation.

#![allow(clippy::all)]

mod materials;
mod player;
mod rng;
mod world;

pub use player::PlayerState;
pub use world::SandWorld;

use wasm_bindgen::prelude::*;

/// Initialize the wasm-bindgen-rayon thread pool.
///
/// Must be called once before creating any SandWorld if the `threads`
/// feature is enabled. Returns a Promise that resolves when the thread
/// pool is ready.
#[cfg(feature = "threads")]
#[wasm_bindgen]
pub fn init_thread_pool(num_threads: usize) -> js_sys::Promise {
    wasm_bindgen_rayon::init_thread_pool(num_threads)
}

/// No-op when threads feature is disabled.
#[cfg(not(feature = "threads"))]
#[wasm_bindgen]
pub fn init_thread_pool(_num_threads: usize) -> js_sys::Promise {
    js_sys::Promise::resolve(&JsValue::TRUE)
}

/// Re-seed the PRNG (for deterministic test mode).
#[wasm_bindgen]
pub fn reseed_rng(seed: u32) {
    rng::reseed(seed);
}
