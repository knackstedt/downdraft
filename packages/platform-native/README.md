# `@downdraft/platform-native`

Native platform bindings — the Rust `downdraft_platform` cdylib (winit + wgpu + cosmic-text + image + naga) and the native device layer Downdraft runs on. Prebuilt binaries install automatically via platform packages or `bun run fetch:native`; build locally with `bun run build:native`.

## Install

```sh
bun add @downdraft/platform-native
```

## Key exports

- `NativeCanvas2D`
- `NativeCanvasContext`
- `NativeImageBitmap`
- `NativeSurface`
- `NativeWindow`
- `VirtualCanvas`
- `VirtualCanvasContext`
- `WgpuAdapter`
- `WgpuBindGroup`
- `WgpuBindGroupLayout`
- …and 31 more

See the [Downdraft engine repository](https://github.com/knackstedt/downdraft) for architecture docs and examples.
