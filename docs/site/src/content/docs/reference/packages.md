---
title: Packages
description: Package overview and descriptions
---

DownDraft Engine is organized as a Bun workspace monorepo with the following packages:

## Core Packages

| Package | Description |
|---|---|
| `@downdraft/engine` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, modules, particles, animation, physics, audio, assets, save system |
| `@downdraft/engine/app` | Runtime-agnostic game bootstrap: `startGame()`/`bootstrapGame()`, HostAPI types |
| `@downdraft/engine/ui` | Devtools/editor UI sources: devtools panel, profiler, material graph editor, animation state machine editor, asset browser |
| `@downdraft/engine/mcp` | MCP server for AI agent interaction (JSON-RPC over stdio) |
| `@downdraft/engine/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/release/assets/test`) |
| `@downdraft/platform-native` | Native runtime host: winit windowing, wgpu device, HostAPI bridge, MCP server (Rust cdylib via FFI — `bun:ffi`/`koffi`/`Deno.dlopen`) |

## Engine Libraries

| Package | Description |
|---|---|
| `@downdraft/engine/libraries/water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/engine/libraries/marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/engine/libraries/physics-rapier` | Rapier3D physics backend |
| `@downdraft/engine/libraries/audio-kira` | Kira audio backend (Rust FFI via `packages/audio-native`) |
| `@downdraft/engine/libraries/networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/engine/libraries/weather` | Weather system |

## Engine Modules

| Package | Description |
|---|---|
| `@downdraft/engine/modules/devtools` | DevTools panel, scene inspector, GPU debugging |
| `@downdraft/engine/modules/camera-controls` | Camera input handling |
| `@downdraft/engine/modules/terrain` | Terrain composition (marching-cubes + LOD) |
| `@downdraft/engine/modules/movement-3d` | 3D player movement |
| `@downdraft/engine/modules/movement-2d` | 2D grid-based movement |
| `@downdraft/engine/modules/sailing` | Sailing mechanics (wind, buoyancy, steering) |
| `@downdraft/engine/modules/native-osr` | Offscreen rendering (native WebGPU surfaces) |
| `@downdraft/engine/modules/mcp` | MCP automation server |
| `@downdraft/engine/modules/xr` | WebXR support |

## Game Libraries (to-the-ocean)

Game-specific libraries live in a game repo's `libraries/` directory — e.g. to-the-ocean's under the `@to-the-ocean/library-*` namespace.

| Package | Description |
|---|---|
| `@to-the-ocean/library-boats` | Boat design system and boat data buffer |
| `@to-the-ocean/library-items` | Item definitions and registry |
| `@to-the-ocean/library-economy` | Market system and price history |
| `@to-the-ocean/library-fishing` | Fishing mechanics |
| `@to-the-ocean/library-survival` | Survival mechanics |

## Game Modules (to-the-ocean)

Game-specific modules live in a game repo's `modules/` directory — e.g. to-the-ocean's under the `@to-the-ocean/module-*` namespace.

| Package | Description |
|---|---|
| `@to-the-ocean/module-inventory` | Inventory management |
| `@to-the-ocean/module-crafting` | Crafting recipes and system |
| `@to-the-ocean/module-wildlife` | Wildlife simulation |
| `@to-the-ocean/module-buoyancy` | Boat buoyancy physics |
| `@to-the-ocean/module-collision` | Voxel collision system |

## Native Libraries

| Package | Description |
|---|---|
| `packages/audio-native` | Rust native audio library (Kira backend) with cross-compile support |

## Core Subsystems

The `@downdraft/engine` package exports the following subsystems:

- **ECS** — World, Entity, Component, Archetype, Query, System, Schedule, Events, Hierarchy
- **Render** — Device, Surface, RenderGraph, RenderPass, Pipeline, BindGroup, Buffer
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
- **SAB** — SeqlockBuffer, Protocol, Writer, Reader, Input
- **Worker** — SimWorker, Supervisor, DBWorker, Protocol
- **Platform** — Window, RenderSurface, HostAPI bridge, HiDPI, HDR, FS, Time
- **Change Detection** — Tracker, Atomics
- **Module** — Module, Registry, TSLoader, WASMLoader, ABI
- **Save** — Serializer, Schema, Migrate
- **Builder** — Builder, DevMode, DebugMode, ProdMode
- **Telemetry** — Collector, GCTracker, Reporter
- **Debug Draw** — Lines, Points, Text, Queue
- **Scripting** — Script, Binding, HotReload
