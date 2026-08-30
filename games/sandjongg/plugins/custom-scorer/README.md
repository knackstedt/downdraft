# sandjongg-custom-scorer

Sample user-authored plugin for **Sandjongg** (Downdraft Engine).

- **Format:** `wasm` (WebAssembly module)
- **Tier:** `native` (full ABI v2 access)
- **Thread:** `own-worker` (always — WASM plugins run in a dedicated worker for stability)

## What it does

Implements a **Fibonacci streak scorer** — each consecutive tile match increases the score multiplier following the Fibonacci sequence (1x, 2x, 3x, 5x, 8x, 13x, ...). The streak resets on dispose.

## Demonstrates

- WASM plugin ABI v2: `alloc`, `register`, `tick`, `dispose`, `on_event` exports.
- Host `env` import module: `log_*`, `state_*`, `event_*` functions.
- Linear memory string/data passing via `(ptr, len)` pairs.
- Bump allocator in WASM for host-allocated strings.
- WASM plugin always runs in its own dedicated worker (stability isolation).

## Files

- `plugin.json` — manifest declaring format `wasm`, tier `native`, thread `own-worker`.
- `custom_scorer.wasm` — compiled WASM binary (276 bytes).
- `src/custom_scorer.wat` — WebAssembly Text Format source.
