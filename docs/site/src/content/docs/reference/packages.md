---
title: Packages
description: Package overview and descriptions
---

DownDraft Engine is organized as a Bun workspace monorepo with the following packages:

## Core Packages

| Package | Description |
|---|---|
| `@downdraft/core` | Engine core: ECS, render passes, render graph, SAB, input, telemetry, plugins, particles, animation, physics, audio, assets, save system |
| `@downdraft/app` | Electron app shell: main process, preload, renderer entry, mobile host |
| `@downdraft/ui` | React UI: devtools panel, profiler, material graph editor, animation state machine editor, asset browser |
| `@downdraft/mcp` | MCP server for AI agent interaction (JSON-RPC over stdio) |
| `@downdraft/shader-graph` | Material/shader graph compiler and validator |
| `@downdraft/cli` | CLI tool (`draft new/dev/debug/build/build-games/dist/export/mobile/assets/test`) |

## First-Party Plugins

| Package | Description |
|---|---|
| `@downdraft/plugin-water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/plugin-marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/plugin-physics-rapier` | Rapier3D physics backend |
| `@downdraft/plugin-audio-kira` | Kira audio backend (Rust FFI via `packages/audio-native`) |
| `@downdraft/plugin-networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/plugin-weather` | Weather system |

## Game Plugins (to-the-ocean)

Game-specific plugins live in `games/to-the-ocean/plugins/` under the `@to-the-ocean/plugin-*` namespace.

| Package | Description |
|---|---|
| `@to-the-ocean/plugin-boats` | Boat design system and boat data buffer |
| `@to-the-ocean/plugin-items` | Item definitions and registry |
| `@to-the-ocean/plugin-inventory` | Inventory management |
| `@to-the-ocean/plugin-crafting` | Crafting recipes and system |
| `@to-the-ocean/plugin-economy` | Market system and price history |
| `@to-the-ocean/plugin-fishing` | Fishing mechanics |
| `@to-the-ocean/plugin-survival` | Survival mechanics |
| `@to-the-ocean/plugin-wildlife` | Wildlife simulation |
| `@to-the-ocean/plugin-buoyancy` | Boat buoyancy physics |
| `@to-the-ocean/plugin-collision` | Voxel collision system |

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
- **Physics** — Interface, Registry, Realm, Body, Collider, Character, Raycast, Lifecycle
- **Audio** — Interface, Engine, Source, Listener, Mixer
- **Input** — State, Mapping, Context, SAB Bridge
- **SAB** — SeqlockBuffer, Protocol, Writer, Reader, Input
- **Worker** — SimWorker, Supervisor, DBWorker, Protocol
- **Platform** — Window, Electrobun, HiDPI, HDR, FS, Time
- **Change Detection** — Tracker, Atomics
- **Plugin** — Plugin, Registry, TSLoader, WASMLoader, ABI
- **Save** — Serializer, Schema, Migrate
- **Builder** — Builder, DevMode, DebugMode, ProdMode
- **Telemetry** — Collector, GCTracker, Reporter
- **Debug Draw** — Lines, Points, Text, Queue
- **Scripting** — Script, Binding, HotReload
