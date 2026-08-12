//! Fast xorshift32 PRNG — replaces `Math.random()` to avoid the slow
//! JS↔WASM boundary call on every random draw.
//!
//! Each rayon worker gets its own thread-local state seeded differently
//! so parallel passes don't produce correlated sequences.

use std::cell::Cell;

thread_local! {
    static STATE: Cell<u32> = Cell::new(seed());
}

/// Generate a per-thread seed. We mix the thread id + a global counter
/// so each thread starts with a different state.
fn seed() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0x9e3779b9);
    let c = COUNTER.fetch_add(0x6c078965, Ordering::Relaxed);
    // Mix with thread id bits — std::thread::current() works on wasm threads
    let tid = std::thread::current().id();
    let tid_bits = format!("{:?}", tid);
    let mut h: u32 = 0x811c9dc5;
    for b in tid_bits.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h ^ c
}

/// Re-seed the current thread's PRNG (e.g. for deterministic test mode).
pub fn reseed(s: u32) {
    STATE.with(|st| st.set(if s == 0 { 1 } else { s }));
}

/// Draw a u32 from the xorshift32 sequence.
#[inline(always)]
pub fn next_u32() -> u32 {
    STATE.with(|st| {
        let mut x = st.get();
        if x == 0 { x = 0x12345678; }
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        st.set(x);
        x
    })
}

/// Draw a float in [0, 1) — drop-in replacement for `Math.random()`.
#[inline(always)]
pub fn random() -> f32 {
    // 24-bit mantissa for a clean [0,1) range
    (next_u32() >> 8) as f32 * (1.0 / 16777216.0)
}

/// Random shade index 0-3 — drop-in replacement for `randomShade()`.
#[inline(always)]
pub fn random_shade() -> u8 {
    (next_u32() & 3) as u8
}
