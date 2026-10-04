---
title: Packages
description: Package overview and descriptions
---

DownDraft Engine is organized as a Bun workspace monorepo with the following packages:

## Core Packages

|| Package | Description |
|---|---|
|| `@downdraft/engine` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, modules, particles, animation, physics, audio, assets, save system |
|| `@downdraft/engine/app` | Runtime-agnostic game bootstrap: `startGame()`/`bootstrapGame()`, HostAPI types |
|| `@downdraft/engine/mcp` | MCP server for AI agent interaction (JSON-RPC) |
|| `@downdraft/engine/shader-graph` | Material/shader graph compiler and validator |
|| `@downdraft/cli` | CLI tool (`draft new/dev/debug/release/assets/test/mcp/plugin`) |
|| `@downdraft/platform-native` | Native runtime host: winit windowing, wgpu device, HostAPI bridge, MCP server (Rust cdylib via FFI — `bun:ffi`/`koffi`/`Deno.dlopen`) |

## Engine Libraries

Engine libraries export `EngineLibrary` descriptors (e.g. `WaterLib`, `PhysicsRapierLib`) for declarative wiring in `GameModule.libraries[]`, plus bare class exports as an escape hatch.

|| Package | Description |
|---|---|
|| `@downdraft/engine/libraries/asset-browser` | In-game asset browser UI |
|| `@downdraft/engine/libraries/audio-kira` | Kira audio backend (Rust FFI, crate `downdraft-audio` under `native/`) |
|| `@downdraft/engine/libraries/blitz-ui` | Native Blitz/vello UI rasterization cdylib FFI |
|| `@downdraft/engine/libraries/character` | Character system |
|| `@downdraft/engine/libraries/devtools` | DevTools host and panels |
|| `@downdraft/engine/libraries/entities` | Generic model renderer shared by games |
|| `@downdraft/engine/libraries/gamepad` | Gamepad input |
|| `@downdraft/engine/libraries/gaussian-splats` | Gaussian splat rendering |
|| `@downdraft/engine/libraries/gpu-kernels` | Shared GPU compute kernels |
|| `@downdraft/engine/libraries/html-ui-kit` | Widget/theme/navigation kit for html-ui |
|| `@downdraft/engine/libraries/lighting` | Lighting system |
|| `@downdraft/engine/libraries/marching-cubes` | Voxel terrain with LOD and deformation |
|| `@downdraft/engine/libraries/models` | Model loading and management |
|| `@downdraft/engine/libraries/navmesh` | Navigation mesh generation and pathfinding |
|| `@downdraft/engine/libraries/networking` | WebSocket transport, state replication, RPCs |
|| `@downdraft/engine/libraries/pathfinding-2d` | 2D pathfinding |
|| `@downdraft/engine/libraries/persistence` | Save/load (worker-backed binary + filesystem stores) |
|| `@downdraft/engine/libraries/physics-native` | Native physics backend |
|| `@downdraft/engine/libraries/physics-rapier` | Rapier3D physics backend |
|| `@downdraft/engine/libraries/postfx` | Post-processing stack (31 chainable effects) |
|| `@downdraft/engine/libraries/recast` | Recast navmesh generation bindings |
|| `@downdraft/engine/libraries/sand` | Falling-sand simulation |
|| `@downdraft/engine/libraries/stickman` | Stickman character system |
|| `@downdraft/engine/libraries/surface-nets` | Surface-nets mesh extraction from voxel fields |
|| `@downdraft/engine/libraries/water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
|| `@downdraft/engine/libraries/weather` | Weather system |
|| `@downdraft/engine/libraries/weatherfx` | Weather visual effects |

## Engine Modules

Feature modules use the factory pattern (`createXxxModule(config)`) and provide typed DI tokens. Games register them via `moduleHost.useModules([...])`.

|| Package | Description |
|---|---|
|| `@downdraft/engine/modules/camera-controls` | Camera input and control modes |
|| `@downdraft/engine/modules/controller-ui` | Controller/ten-foot UI support |
|| `@downdraft/engine/modules/devtools` | DevTools overlay panel (native OSR) |
|| `@downdraft/engine/modules/editor` | Editor tooling |
|| `@downdraft/engine/modules/html-ui` | Blitz HTML/CSS game UI, rasterized in a worker |
|| `@downdraft/engine/modules/mcp` | In-game MCP automation harness |
|| `@downdraft/engine/modules/movement-2d` | 2D movement system |
|| `@downdraft/engine/modules/movement-3d` | 3D movement system |
|| `@downdraft/engine/modules/native-osr` | Offscreen rendering (native WebGPU surfaces) |
|| `@downdraft/engine/modules/sailing` | Sailing mechanics |
|| `@downdraft/engine/modules/terrain` | Terrain system |
|| `@downdraft/engine/modules/vitals` | Vitals (health/stamina/etc.) system |
|| `@downdraft/engine/modules/xr` | WebXR / VR support |

## Game Libraries & Modules

Game-specific code lives in each game repo's `libraries/` and `modules/` directories, conventionally packaged as `@<game-scope>/library-*` (bare classes, no lifecycle) and `@<game-scope>/module-*` (lifecycle + typed DI), following the same split as the engine. No engine package depends on any game package.

## Native Rust Crates

|| Crate | Location | Description |
|---|---|---|
|| `downdraft-platform` | `packages/platform-native/native-rs` | Platform cdylib (`libdowndraft_platform`): winit windowing, wgpu device, HostAPI |
|| `downdraft-gamepad` | `packages/platform-native/native-gamepad` | Gamepad input cdylib (`libdowndraft_gamepad`) |
|| `downdraft-secrets` | `packages/platform-native/native-secrets` | OS keychain secrets cdylib (`libdowndraft_secrets`) |
|| `downdraft-physics` | `packages/engine/libraries/physics-native/native` | Native physics backend cdylib (`libdowndraft_physics`) |
|| `downdraft-audio` | `packages/engine/libraries/audio-kira/native` | Optional Kira audio cdylib (`libdowndraft_audio`) |

|| `downdraft-blitz-osr` | `packages/engine/libraries/blitz-ui/native-osr` | Blitz/vello UI rasterization cdylib (`libdowndraft_blitz_osr`; `native/` is the supporting `downdraft-blitz-shell` rlib) |
|| `downdraft-android` | `packages/android-shell` | Android NativeActivity shell (`libdowndraft_android`; statically links `downdraft-platform`, embeds libnode) |

`packages/node-mobile` is not a crate — it's the overlay recipe that builds `libnode.so` for Android from pinned upstream Node.

## Core Subsystems

The `@downdraft/engine` package exports the following subsystems:

- **ECS** — World, Entity, Component, Archetype, Query, System, Schedule, Events, Hierarchy
- **Render** — Device, Surface, FrameGraph, RenderPass, Pipeline, BindGroup, Buffer
- **Scene** — Scene, World, Layer, Camera, Checkpoint
- **Assets** — Manager, Loaders (mesh, texture, shader, audio), Importer, LOD, Cache
- **Material** — Material, Graph, Compiler, Library
- **Mesh** — Mesh, VertexLayout, Builder, Skinning
- **Animation** — Clip, Player, StateMachine, Skeleton, Retarget, Mixamo
- **Particles** — Emitter, Simulator, ComputePass, RenderPass, System
- **UI (html-ui)** — Blitz HTML/CSS panels, compositor, input routing
- **Physics** — Interface, Registry, Realm, Body, Collider, Character, Raycast, Lifecycle
- **Audio** — Interface, Engine, Source, Listener, Mixer
- **Input** — State, Mapping, Context, SAB Bridge
- **SAB** — Record/Slot buffers, sim + input channels, sequence counters, Writer/Reader pairs
- **Worker** — SimWorker host, task pool, RPC, crash recovery
- **Platform** — Window, RenderSurface, HostAPI bridge, HiDPI, HDR, FS, Time
- **Change Detection** — Tracker, Atomics
- **Module** — Module, ModuleHost, typed DI tokens, cross-thread tokens
- **Plugin** — PluginHost, manifests, permissions, worker/WASM/QuickJS loaders
- **Save** — Serializer, Schema, Migrate
- **Builder** — Builder, DevMode, DebugMode, ProdMode
- **Telemetry** — Collector, GCTracker, Reporter
- **Debug Draw** — Lines, Points, Text, Queue
- **Scripting** — Script, Binding, HotReload
