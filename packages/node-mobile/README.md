# node-mobile — embedded Node for Android

An overlay recipe that turns a **pristine upstream Node source tarball** into
`libnode.so` for Android (`arm64-v8a`, `x86_64`), for embedding in the
Downdraft native shell. This is *not* a Node fork — it is a pinned version, a
sha256, a set of verbatim overlay files, and a `git apply` patch series.

Derived from the `gmaclennan/nodejs-mobile` recipe patch set (itself the
continuation of Janea's nodejs-mobile), ported forward to **Node v26.10.0**.
Android only for now; iOS-aware hunks are kept where they're harmless but no
iOS build is wired up.

## Layout

| File | Purpose |
|---|---|
| `node-version.txt` | upstream Node pin (`26.10.0`) |
| `tarball-sha256.txt` | sha256 of `node-v<ver>.tar.gz` |
| `series` | ordered patch list |
| `files.map` | patch → upstream files it touches (drives `bump` drift report) |
| `patches/` | the patch series (`git apply` format, strict) |
| `overlay/` | files copied verbatim into the extracted tree |
| `scripts/` | fetch / prepare / build-android / smoke / bump |

## Requirements

- Android NDK **r30** (`sdkmanager "ndk;30.0.16248370"`) — required: V8 14.6's
  consteval regexp dispatch needs clang ≥20 on the target side (r28 ships
  clang 19 → ~160 errors). r30's libc++ also restored `std::atomic_ref`; the
  `atomic-ref-shim.h` polyfill is a no-op there but keeps ≤r28 viable for the
  atomic side alone.
- `gcc`/`g++` host toolset — V8 14.6 uses C++20 alias-template CTAD that
  distro clang ≤19 rejects. `CC_host`/`CXX_host` env override.
- `bash`, `git` (patch apply), `make`, ~20 GB disk, `node` for the scripts.

## Usage

```sh
cd packages/node-mobile

node scripts/prepare.mjs                    # fetch + extract + overlay + patch
                                            #   → build/node-v26.10.0/

ANDROID_NDK_HOME=$ANDROID_HOME/ndk/<ver> \
  node scripts/build-android.mjs            # → build/dist/android/{arm64-v8a,x86_64}/libnode.so
                                            #   + build/dist/android/include/node/

node scripts/smoke.mjs                      # structural checks on tree + artifacts

node scripts/bump.mjs 26.11.0               # move the pin; reports which patches
                                            #   reject on the new upstream source
```

`build-android.mjs` auto-runs `prepare` if the tree isn't materialized.
Env knobs: `NODEJS_MOBILE_FLAVOR=full|lite` (lite drops intl/amaro/inspector/
sqlite), `NODEJS_MOBILE_SCCACHE=1`, `NODEJS_MOBILE_JOBS`, `--sdk=<api>`
(default 30, Android 11), `--arch=arm64|x86_64|all`.

## Patch port notes (v24.18.0 reference → v26.10.0)

Four reference patches needed rework; the rest applied clean:

- `node.gyp` — dropped the polywasm builtin entry (iOS-only) and the
  `NODE_ENABLE_LARGE_CODE_PAGES` hunk (removed upstream); the shared-lib test
  skip now covers `embedtest` too.
- `v8.gyp` — upstream added an `is_android` block and an arm64
  push_registers entry, so the PR-57748 host/target asm hunks were dropped
  (only mattered for arm32; revisit if `armeabi-v7a` is ever added). Kept:
  mksnapshot real-compiler-sources fix, `-latomic` for android,
  `platform-linux.h`, macOS-aware host toolset, `ndk_cpufeatures` targets.
- `node_metadata.{cc,h}` — re-anchored (`HAVE_LIEF` block added upstream).
- `trap-handler.h` — same unconditional disable, rewritten for v26's layout.
  `handler-outside.cc`/`push_registers_asm.cc` hunks dropped (upstream guards
  them correctly now). Upstream's ad-hoc `android-patches/` patch file is
  deleted and `android_configure.py` no longer mutates the tree mid-build.
- **New on v26** — `deps-v8-atomic-ref-shim-includes-for-android.patch` +
  `deps/v8/include/atomic-ref-shim.h`. V8 14.6 uses `std::atomic_ref`, which
  Android's libc++ strips even in NDK r28c (upstream never sees this — Chrome
  builds V8 with its bundled libc++). The shim maps the handful of used ops
  onto `__c11_atomic_*` builtins and defines `__cpp_lib_atomic_ref` so
  simdutf's atomic base64 APIs (`SIMDUTF_ATOMIC_REF`) enable — the patch also
  adds a relative include of the shim at the top of
  `deps/v8/third_party/simdutf/simdutf.h`.
- **Host toolset** — `android_configure.py` picks `CC_host`/`CXX_host` from
  env, then `gcc`/`g++`, then clang. g++ is the default because V8 14.6 uses
  C++20 alias-template CTAD (`wasm-shuffle-reducer.cc`) that distro clang ≤19
  rejects. Override via `CC_host`/`CXX_host` env if a newer clang is wanted.
- `--v8-disable-temporal-support` is passed on Android — the vendored
  Temporal Rust dep (temporal_capi) has no Android target wiring.

## Distribution

CI (`.github/workflows/node-mobile.yml`) builds per ABI and publishes
`downdraft-node-mobile-android-<arch>.tar.gz`; `stage-node-packages.mjs`
unpacks them into `@downdraft/native-mobile-android-arm64` /
`@downdraft/native-mobile-android-x64` npm packages. APK packaging
(`packages/cli/scripts/package-mobile.mjs`) probes the local build tree
first, then the npm packages — fetched explicitly since npm `os` filtering
doesn't apply (no host runs `platform === 'android'`).
