# `@downdraft/engine`

Downdraft engine — a native-runtime game engine (winit + wgpu, no Electron, no browser shell). The JS host is interchangeable: Bun, Node, and Deno all run the same engine through a shared FFI/device layer.

Everything the engine ships is exposed as **subpath exports** of this one package:

- `@downdraft/engine` — core index (ECS, render loop, HostAPI types)
- `@downdraft/engine/app/renderer` — `startGame()` / `bootstrapGame()` game bootstrap
- `@downdraft/engine/libraries/<name>` — engine building blocks (physics, audio, models, water, weather, navmesh, gpu-kernels, …)
- `@downdraft/engine/modules/<name>` — opt-in feature modules with lifecycle + typed DI (movement-2d/3d, terrain, sailing, camera-controls, devtools, …)
- `@downdraft/engine/platform/…` — runtime adapters (native surface, FFI, SAB channels)

## Install

```sh
bun add @downdraft/engine @downdraft/platform-native @downdraft/cli
```

`@downdraft/platform-native` supplies the native window/GPU device layer (prebuilt binaries per OS/arch arrive via optional dependencies).

## Quick start

```ts
import { startGame } from "@downdraft/engine/app/renderer";

startGame({
  renderer: (canvas) => new WebGPURenderer(canvas),
  sim: (seed) => new SimWebWorker(seed?.libraryBuffers),
  simConfig: { seed: 12345 },
});
```

See the [Downdraft engine repository](https://github.com/knackstedt/downdraft) for architecture docs and examples.
