---
title: Packages
description: Package overview and descriptions
---

DownDraft Engine is organized as a Bun workspace monorepo with the following packages:

## Core Packages

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, modules, particles, animation, physics, audio, assets, save system |
| `@downdraft/app` | Electron app shell: main process, preload, renderer entry, mobile host |
| `@downdraft/ui` | React UI: devtools panel, profiler, material graph editor, animation state machine editor, asset browser |
| `@downdraft/mcp` | MCP server for AI agent interaction (JSON-RPC over stdio) |
| `@downdraft/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/build/build-games/dist/export/mobile/assets/test`) |

## Engine Libraries

| Package | Description |
|---|---|
| `@downdraft/library-water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/library-marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/library-physics-rapier` | Rapier3D physics backend |
| `@downdraft/library-audio-kira` | Kira audio backend (Rust FFI via `packages/audio-native`) |
| `@downdraft/library-networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/library-weather` | Weather system |

## Engine Modules

| Package | Description |
|---|---|
| `@downdraft/module-devtools` | DevTools panel, scene inspector, GPU debugging |
| `@downdraft/module-camera-controls` | Camera input handling |
| `@downdraft/module-terrain` | Terrain composition (marching-cubes + LOD) |
| `@downdraft/module-movement-3d` | 3D player movement |
| `@downdraft/module-movement-2d` | 2D grid-based movement |
| `@downdraft/module-sailing` | Sailing mechanics (wind, buoyancy, steering) |
| `@downdraft/module-electron-osr` | Offscreen rendering |
| `@downdraft/module-mcp` | MCP automation server |
| `@downdraft/module-xr` | WebXR support |

## Game Libraries (to-the-ocean)

Game-specific libraries live in `games/to-the-ocean/libraries/` under the `@to-the-ocean/library-*` namespace.

| Package | Description |
|---|---|
| `@to-the-ocean/library-boats` | Boat design system and boat data buffer |
| `@to-the-ocean/library-items` | Item definitions and registry |
| `@to-the-ocean/library-economy` | Market system and price history |
| `@to-the-ocean/library-fishing` | Fishing mechanics |
| `@to-the-ocean/library-survival` | Survival mechanics |

## Game Modules (to-the-ocean)

Game-specific modules live in `games/to-the-ocean/modules/` under the `@to-the-ocean/module-*` namespace.

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

The `@downdraft/core` package exports the following subsystems:

- **ECS** — World, Entity, Component, Archetype, Query, System, Schedule, Events, Hierarchy
- **Render** — Device, Surface, RenderGraph, RenderPass, Pipeline, BindGroup, Buffer
- **Scene** — Scene, World, Layer, Camera, Checkpoint
- **Assets** — Manager, Loaders (mesh, texture, shader, audio), Importer, LOD, Cache
- **Material** — Material, Graph, Compiler, Library
- **Mesh** — Mesh, VertexLayout, Builder, Skinning
- **Animation** — Clip, Player, StateMachine, Skeleton, Retarget, Mixamo
- **Particles** — Emitter, Simulator, ComputePass, RenderPass, System
- **UI (imui)** — UIRoot, UIRenderer, LayoutEngine, Widgets, Input
- **Physics** — Interface, Registry, Realm, Body, Collider, Character, Raycast, Lifecycle
- **Audio** — Interface, Engine, Source, Listener, Mixer
- **Input** — State, Mapping, Context, SAB Bridge
- **SAB** — SeqlockBuffer, Protocol, Writer, Reader, Input
- **Worker** — SimWorker, Supervisor, DBWorker, Protocol
- **Platform** — Window, Electrobun, HiDPI, HDR, FS, Time
- **Change Detection** — Tracker, Atomics
- **Module** — Module, Registry, TSLoader, WASMLoader, ABI
- **Save** — Serializer, Schema, Migrate
- **Builder** — Builder, DevMode, DebugMode, ProdMode
- **Telemetry** — Collector, GCTracker, Reporter
- **Debug Draw** — Lines, Points, Text, Queue
- **Scripting** — Script, Binding, HotReload
