# DownDraft Engine

A TypeScript game engine that runs your game as **one native process** — winit + wgpu, hosted by Bun, Node, or Deno. No Electron. No Chromium. No IPC boundary. Your game code drives a real native window and the GPU directly, with Rust cdylibs (platform, physics, audio, UI rasterization) loaded over FFI for the hot paths.

## What the hell is this?

It's a full game engine, not just a renderer:

- **Deferred WebGPU renderer** — G-Buffer, shadow maps, post-processing, and a Bevy-style render graph with automatic resource aliasing.
- **Archetype ECS** — change detection, hierarchy, and double-buffered events, running in a dedicated worker thread.
- **Zero-copy sim↔render** — the renderer on the main thread and the simulation in a worker talk over `SharedArrayBuffer`, not messages. The sim can attach a non-owning view of the GPU device and encode command buffers in parallel.
- **Batteries included** — physics (Rapier3D), spatial audio (Kira), skeletal animation, GPU particles, networking, worker-backed binary saves, weather, water, navmesh, and more, as opt-in [engine libraries and modules](https://downdraft.dev/reference/packages/).
- **Real UI** — game UI is authored in HTML/CSS/JSX and rasterized by Blitz in a worker, composited as native textures. No Chromium, no webview.
- **A built-in MCP server** — AI agents can drive, inspect, and debug a *running* game (screenshots, input injection, world-state queries). AI is one workflow among many; the engine is fully usable by hand.

Games are ordinary npm projects that depend on `@downdraft/engine` and boot from `src/native-entry.ts`. `draft release` compiles them into real distributables — single binaries on all desktop targets, plus `.deb`/AppImage/Flatpak on Linux — and there's a genuinely native Android port (same winit+wgpu stack plus embedded libnode, no WebView).

## Why would I want to use it?

- **You want to write your game in TypeScript without shipping a browser.** You get the JS/TS ecosystem and iteration speed — plus tiered HMR through an embedded Vite dev shell — but the end product is a native binary driving Vulkan/Metal/D3D12, not a web page.
- **You want engine features, not plumbing.** ECS, render graph, physics, audio, animation, particles, saves, networking, devtools overlay, material graph editor — declaratively wired through typed DI rather than hand-rolled glue.
- **You want to choose your JS runtime.** The engine is runtime-agnostic: Bun by default, Node+tsx or Deno via `draft dev --runtime=node|deno`. Bun is just this repo's package manager and test runner.
- **You want an AI-assisted workflow.** The MCP harness gives agents real introspection — they can read sim state, inject input, take screenshots, and wait on conditions — instead of guessing from logs.

## Why is it better than X?

Honest comparisons, not hype:

| Instead of… | DownDraft's difference |
|---|---|
| **Electron / webview game shells** | One process, no bundled Chromium, no renderer/preload split, no IPC for every API call. Saves, screenshots, and window control are direct in-process calls. Smaller binaries, less memory, fewer moving parts. |
| **Three.js / Babylon.js** | Those are renderers; you still build the engine. DownDraft ships the sim worker architecture, ECS, module system, save system, devtools, and a `draft release` path to real desktop/Android binaries. |
| **Bevy** | Same conceptual pieces (archetype ECS, render graph) but a different threading model — Bevy schedules systems in parallel inside one Rust process; DownDraft runs your TypeScript sim in an isolated worker over SharedArrayBuffer. You trade Bevy's maturity, multi-core system parallelism, and web/WASM targets for no compile step, real code HMR, and the npm ecosystem. |
| **Unity / Godot** | No editor-first lock-in: everything is code, games are plain npm projects, and the engine itself is a versioned dependency you can read and patch. Much younger ecosystem — pick it because you want code-first and TypeScript, not because it's more mature. |

DownDraft is early-stage (`0.x`). It's a good fit if you want a code-first, TypeScript-native engine with real native output — and can live with a smaller community than the incumbents.

## Quick Start

```bash
bun install

draft new my-game
cd my-game
draft dev          # opens a native window with HMR

draft release      # build + package for desktop
```

A game entrypoint is just:

```ts
// src/native-entry.ts
import { runNativeGameModule } from "@downdraft/platform-native";
import { gameModule } from "./game-module";

await runNativeGameModule(gameModule, {
  title: "My Game",
  appId: "downdraft-my-game",
});
```

For local development against a game repo cloned under `games/` (e.g. sandjongg), see [`development.md`](./development.md).

## Documentation

| Topic | Link |
|---|---|
| Introduction & installation | https://downdraft.dev/getting-started/introduction/ |
| Development workflow & HMR | https://downdraft.dev/getting-started/development/ |
| ECS, rendering, physics, audio, particles, animation | https://downdraft.dev/guides/ecs/ (and sibling guides) |
| Modules, plugins, native Rust modules | https://downdraft.dev/guides/modules/ · https://downdraft.dev/guides/plugins/ |
| MCP & AI agents | https://downdraft.dev/guides/mcp/ |
| Packaging & distribution | https://downdraft.dev/guides/packaging/ |
| Architecture (process model, SAB, render pipeline) | https://downdraft.dev/architecture/process-model/ |
| CLI reference | https://downdraft.dev/reference/cli/ |
| Package & library index | https://downdraft.dev/reference/packages/ |
| Troubleshooting | https://downdraft.dev/reference/troubleshooting/ |

For the deep engine-internals reference (module contracts, SAB protocols, dev/test harness details), see [`AGENTS.md`](./AGENTS.md).

## License

MIT
