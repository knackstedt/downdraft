---
title: Native Modules (Rust)
description: Shipping game-owned Rust compute crates — C-ABI cdylibs via the FFI adapter and napi-rs .node addons — for desktop and Android
---

Games can ship their own Rust crates for hot compute paths — physics-style batch kernels, procedural generation, delta-shedding workers. Two mechanisms are supported, and a game can pick per-runtime rather than supporting all three hosts.

## The two paths

| | C-ABI cdylib (FFI) | napi-rs `.node` addon |
|---|---|---|
| Interface | `#[no_mangle] extern "C"` functions | `#[napi]` exports |
| Loader | `dlopen()` from `@downdraft/platform-native/ffi/ffi-adapter` | `createRequire()(path)` → `process.dlopen` |
| Data flow | Pull: JS calls in, typed arrays via `ptr()` | Pull (same) **and push** (ThreadsafeFunction) |
| bun dev | `bun:ffi` | Bun's napi impl |
| node dev / Android | `koffi` | Full Node-API |
| deno dev | `Deno.dlopen` | Deno's node-api layer |
| `bun build --compile` | `bun:ffi` | Bun's napi impl |

**Choose FFI** when you want maximum runtime coverage and batch calls are enough — one `dlopen` + wide calls over `Float32Array`/`Int32Array` scratch buffers (the physics library's pattern, see `packages/engine/libraries/physics-rapier/src/ffi-lib.ts`).

**Choose napi-rs** when you need push-style delta delivery: `ThreadsafeFunction` is the only safe way to call into JS from a Rust-owned thread (FFI callbacks from foreign threads are unsafe or unsupported in all three hosts), or when you want typed JS objects at the boundary instead of raw pointers.

Using napi doesn't lock you out of the other runtimes — Bun and Deno both load `.node` addons — but it does mean the addon can't run in hosts with no node-api table. Pin the game to the runtimes you verified.

## Layout convention

The packagers stage game-native artifacts from a fixed location:

```
<game>/native/
  Cargo.toml            # standalone [workspace] — detaches from the engine's
  bench-ffi/            # cdylib, C-ABI exports
  bench-napi/           # cdylib, ships as *.node
  build.mjs             # cargo build + stage into dist/
  dist/
    linux-x64/libbench_ffi.so      # → packaged <outdir>/native/
    linux-x64/bench_napi.node      # → packaged <outdir>/native/
    android-arm64/libbench_ffi.so  # → APK lib/arm64-v8a/ (jniLibs, soname)
    android-arm64/bench_napi.node  # → APK bundle/native/android-arm64/
```

The workspace `Cargo.toml` must have its own `[workspace]` table — that detaches the crates from the engine's root workspace.

## The crates

### C-ABI cdylib

```toml
# native/bench-ffi/Cargo.toml
[lib]
crate-type = ["cdylib"]
```

```rust
#[no_mangle]
pub extern "C" fn bf_fill_field(out: *mut f32, w: u32, h: u32, t: f32) -> u32 {
    if out.is_null() || w == 0 || h == 0 { return 0; }
    let s = unsafe { std::slice::from_raw_parts_mut(out, (w * h) as usize) };
    // ...compute into s...
    w * h
}
```

No napi symbols — the artifact must `dlopen` cleanly under every host.

### napi-rs addon

```toml
# native/bench-napi/Cargo.toml
[lib]
crate-type = ["cdylib"]

[dependencies]
# default-features=false is REQUIRED for Android — see pitfalls below.
napi = { version = "3", default-features = false, features = ["napi6"] }
napi-derive = "3"
```

The crate ships with a `.node` suffix so `require()`/`process.dlopen` picks it up. Push-style deltas via `ThreadsafeFunction`:

```rust
#[napi]
pub fn start_deltas(cb: Function<(Error, Delta), ()>) -> Result<()> {
    let tsfn = cb.build_threadsafe_function::<Delta>()
        .callee_handled::<true>()
        .max_queue_size::<0>()
        .build_callback(|ctx| Ok(ctx.value))?;
    std::thread::spawn(move || loop {
        tsfn.call(Ok(next_delta()), ThreadsafeFunctionCallMode::NonBlocking);
    });
    Ok(())
}
```

Make `start_*` functions **idempotent** — the addon's statics outlive the JS module graph, so a session restart (HMR, test switch) re-inits without `dispose` ever running.

## Building

A small `build.mjs` wraps `cargo build --target=<triple>` and copies artifacts into `native/dist/<platform>-<arch>/` (the `.node` rename happens there). For `aarch64-linux-android` set the NDK clang wrappers:

```js
env: {
  ...process.env,
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: `${ndkBin}/aarch64-linux-android30-clang`,
  CC_aarch64_linux_android: `${ndkBin}/aarch64-linux-android30-clang`,
  CXX_aarch64_linux_android: `${ndkBin}/aarch64-linux-android30-clang++`,
}
```

`build-native.mjs` discovers the newest NDK under `$ANDROID_HOME/ndk/` when `ANDROID_NDK_HOME` is unset; a game-local build script should do the same.

## Loading at runtime

Search order used by the gpu-bench example (`src/tests/native/native-bridge-lib.ts`):

1. Env override (`BENCH_FFI_LIB` / `BENCH_NAPI_LIB`)
2. Dev tree: `<game>/native/dist/<platform>-<arch>/`
3. Packaged desktop: `dirname(process.execPath)/native/`
4. Android: `$DOWNDRAFT_BUNDLE_DIR/native/<platform>-<arch>/` (`.node`), or bare soname for `lib*.so` (jniLibs → the OS installs them into the app's native lib dir)

For the FFI side, pass your candidates to `resolveNativeLibrary(name, { dirs })` — its Android branch already resolves by soname. For `.node`, `createRequire(import.meta.url)` with a **computed** specifier — a static string gets rewritten/bundled; the addon must load from a real filesystem path at runtime.

## Packaging

`package-native.mjs` (desktop) and `package-mobile.mjs` (Android) both stage from `<game>/native/dist/`:

- **Desktop**: `*.so/.dll/.dylib` + `*.node` for the current platform copied flat into `<outdir>/native/` beside the engine crates.
- **Android**: `lib*.so` files → `lib/<abi>/` (installed by the OS, resolved by soname — same mechanism `lib-paths.ts` uses for engine crates). `*.node` files → `assets/bundle/native/android-<arch>/`, staged **before** `manifest.txt` is generated so the shell's extractor lists them; they land as real files under `DOWNDRAFT_BUNDLE_DIR` where `require()` can `dlopen` them.

`.node` files are *not* jniLibs — the OS only installs `lib*.so`. Don't try to force them through `lib/<abi>/`.

## Pitfalls found during validation

These cost real debugging time — check them first if an addon misbehaves.

- **`napi-sys` `dyn-symbols` breaks on Android/bionic.** napi-sys 3.x defaults to a `dlsym`-resolved function table populated by `setup()` via `Library::this()` (`dlopen(NULL)`). That covers the glibc global group, so it works on desktop — but bionic's `dlsym` on that handle doesn't cover the `RTLD_GLOBAL` group where libnode's symbols live, so every `napi_*` call silently no-ops (`Node-API symbol X has not been loaded`) and module registration produces empty exports. Fix: `default-features = false` so the addon uses direct externs — the Android shell loads `libnode.so` `RTLD_GLOBAL` specifically so they resolve.
- **`isCompiledBinary` for test discovery.** Inside `bun build --compile`, `Bun.main` is `/$bunfs/...` — use `isCompiledBinary` from `@downdraft/engine/platform/runtime` to gate Vite-glob vs filesystem discovery. Plain `isBun` is wrong for this.
- **Eager `createGlob` calls at module-init** can run before the glob-polyfill's own consts initialize when a module is bundled into the same chunk — the packagers emit a lazy binding for exactly this reason.
- **Idempotent native init.** `.node` addon statics survive JS-side session restarts; `start_*` should drain a prior stream instead of failing "already running".

## Reference implementation

`games/downdraft-gpu-bench` contains a working end-to-end example:

- `native/bench-ffi/` + `native/bench-napi/` — matching plasma kernels, so FFI and napi outputs can be checksummed against each other
- `native/build.mjs` — host + Android cross-build with NDK discovery
- `src/tests/native/native-bridge-lib.ts` — resolution/loading for both artifacts across dev/packaged/Android
- `src/tests/native/native-bridge.test.ts` — split-screen visual test: FFI fills the left half, napi fills the right, green/red status cells, live TSFN + pull-delta counters

Run it with `DD_BENCH_TEST=native-bridge draft dev --runtime bun|node|deno`, or package it via `draft release --target=android` — verified `ffi=ok`/`napi=ok`/`match=true` on all four.
