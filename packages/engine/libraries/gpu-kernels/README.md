# gpu-kernels

gpu.js-inspired GPGPU kernels for downdraft games — write a restricted-JS
function, it transpiles to a WGSL compute shader and runs on the **shared
GPUDevice** you pass in. No second device, no hidden context.

```ts
import { createKernel } from "@downdraft/engine/libraries/gpu-kernels";

const k = createKernel({
  device,                       // the game's GPUDevice — required
  output: [512, 512],
  constants: { DT: 0.016 },
  fn: function (pos, vel) {
    const i = this.thread.x + this.thread.y * this.output.x;
    return vel[i] * this.constants.DT + pos[i];
  },
});

const out = await k.read(pos, vel);            // dispatch + Float32Array
await k.readInto(sabView, pos, vel);           // dispatch + write into a SAB view
k.dispatch(pos, vel);                          // fire-and-forget per frame
k.dispatchInto(vertexBuf, pos, vel);           // zero-copy into a caller buffer
const res = await k.readResult();              // fetch last dispatch — no re-run
k.encodeDispatch(enc, null, pos, vel);         // batch into YOUR encoder
k.resultBuffer                                 // GPUBuffer — bind it in your own passes
```

## Why not gpu.js

- **Shared device / zero-copy**: gpu.js creates its own `GPUDevice`; its
  buffers can never interop with the renderer's. Here the kernel runs on your
  device — `resultBuffer` is a normal `GPUBuffer` you can bind into a render
  pass (give it `VERTEX` usage via `outputUsage` or pass `outputBuffer`), and
  `GPUBuffer` args bind directly for kernel→kernel chaining without readback.
- **SAB handoff**: `readInto(view)` / `readResultInto(view)` target any
  ArrayLike — including a `Float32Array` over `SharedArrayBuffer`. (The GPU
  can't bind SAB memory; this is an explicit staging-buffer copy, not a
  zero-copy map.) Inputs can be SAB-backed too.
- **CPU fallback is free**: `k.cpu(...)` / `k.cpuInto(view, ...)` just run the
  original function per element — deterministic, and what `bun test` uses.

## The dialect (deliberately small)

- Params: plain identifiers. TypedArray arg → `array<f32>` storage (read) —
  non-`Float32Array` views are converted **by value** (Uint32→f32 etc.;
  `DataView` is rejected). `number` arg → packed f32 scalar (>2²⁴ loses int
  precision — bake seeds into `constants.RAND_SEED` instead). `GPUBuffer`
  arg → bound directly (zero-copy in; its `arrayLength` is the whole buffer).
- `this.thread.x/y/z` (u32), `this.output.x/y/z`, `this.constants.NAME`,
  `arg[i]`, `arg.length` (the bound size — always the current call's array
  length, even as arg sizes vary across calls).
- `var/let/const`, `if/else`, `for`, `while`, `do..while`, `break`, `continue`,
  `return`, ternary, `**`, `**=`, bitwise ops (as i32), `Math.*` with checked
  arity (see `MATH_DIRECT`/`MATH_HELPERS` in transpile.ts; `Math.random()` is a
  per-invocation PCG seeded by `constants.RAND_SEED`).
- `/` is **always float division** (JS semantics — `this.thread.x / 2` is
  1.5 at x=3, not 1). `%`, `&|^`, `<<`, `>>`, `>>>` are int ops (as i32/u32).
- `&&`/`||` return operand **values** like JS (`a[i] || 0.5` works); `??` is
  rejected — write an explicit check.
- `return expr` writes one f32 per element (a `bool` return stores 0.0/1.0).
  With `outputStride: 2|3|4`, `return [a, b, ...]` writes a flat
  `result[i*stride+c]` layout — the same bytes a `vecN<f32>` buffer has.
  Ternaries on same-length arrays work too (`cond ? [a,b] : [c,d]` → `select`).
- In-place writes: `access: ["read_write"]` (per param index) makes `a[i] = x`
  legal, including compounds (`a[i] += x`, `a[i] &= 3` — the index evaluates
  once). **Caveat:** for TypedArray args the caller's array is re-uploaded
  every dispatch, so mutations don't persist between dispatches — use
  `GPUBuffer` args for state that lives on the device.
- Everything is f32 except integer literals, `this.thread.*`, and `.length`
  (i32/u32 — keeps indexing and loop counters exact). Mixed int math unifies
  to i32 (never u32 — `for (let i = a.length-1; i >= 0; i--)` terminates).
  A var initialized from an integer widens to f32 if a float is assigned
  later — JS number semantics. (Bun's `fn.toString()` normalizes `0.0` → `0`;
  the widening pass exists precisely because the literal form can't be
  relied on.)

Not supported (all throw `KernelSyntaxError` at transpile time): closures,
helper-function calls, objects/structs, strings, switch, try/catch,
destructuring, for..of, labels, `??`/`??=`/`&&=`/`||=`, `++/--` as expression
values, non-statement for-init/update, multi-declarator `for` inits, arrays
in locals (return them directly), locals shadowing array/buffer params,
duplicate params, non-number constants, async/generator kernels, textures,
atomics.

## Behavior notes

- `read()`/`readInto()` **re-dispatch** the kernel; `readResult()`/
  `readResultInto()` only copy the last `resultBuffer`. Readbacks are
  serialized internally on one staging buffer. On native, `mapAsync` blocks
  the calling thread until the GPU work completes — `await k.read()` on the
  render thread stalls a frame; prefer `dispatch` + `readResult` a tick later.
- Submits run inside a validation error scope: `read*` throws on failure;
  fire-and-forget `dispatch`/`dispatchInto` can't throw retroactively, so the
  error lands on `kernel.lastError`.
- `cpu()`/`cpuInto()` are the deterministic f64 reference. They reject arrow
  functions (`this` can't be rebound) and GPUBuffer args, and validate arity,
  stride shape, and view size like the GPU path. `Math.random()` on CPU is the
  host PRNG — it does **not** match the GPU's seeded PCG sequence.
- Divergences from JS worth knowing (GPU has no NaN/undefined): out-of-bounds
  `arg[i]` reads are robustness-clamped, not `undefined`; int `x | 0` on
  floats ≥2³¹ or NaN is indeterminate; int div-by-zero is indeterminate.
- A `GPUBuffer` from a **different device** isn't checked — it fails
  validation at bind time (see `lastError`). Same-buffer arg+output aliasing
  is rejected up front; for in-place iteration use `read_write` args or
  ping-pong two buffers via `dispatchInto`.

## Determinism note

GPU f32 math is not bit-reproducible across drivers — keep kernel results out
of replay-critical sim state, or use the `cpu()` path (f64) for the
deterministic reference.
