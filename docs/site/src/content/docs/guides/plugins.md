---
title: Plugins
description: Plugin system architecture and first-party plugins
---

DownDraft has a tiered plugin system supporting both TypeScript and WASM plugins.

## Plugin Interface

Plugins can register systems, components, resources, and assets. The plugin interface is the primary extension point for the engine.

```typescript
import { GameWorld, Scene, World } from "@downdraft/core";
import { PhysicsRapierPlugin } from "@downdraft/plugin-physics-rapier";
import { AudioKiraPlugin } from "@downdraft/plugin-audio-kira";
import { WaterPlugin } from "@downdraft/plugin-water";
import { MarchingCubesPlugin } from "@downdraft/plugin-marching-cubes";
import { NetworkingPlugin } from "@downdraft/plugin-networking";

const gameWorld = new GameWorld(new Scene(new World()));

gameWorld.usePlugin(PhysicsRapierPlugin);
gameWorld.usePlugin(AudioKiraPlugin);
gameWorld.usePlugin(WaterPlugin);
gameWorld.usePlugin(MarchingCubesPlugin);
gameWorld.usePlugin(NetworkingPlugin);
```

## Plugin Tiers

### TypeScript Plugins

- Run in-process in the sim worker
- No sandboxing — full access to engine APIs
- Loaded via the TS plugin loader
- Fastest iteration and development

### WASM Plugins

- Run in an isolated runtime within the sim worker
- Can be written in any language that compiles to WASM
- Have SAB channel access and system registration via a stable ABI
- Loaded via the WASM plugin loader

## Plugin Registry

The plugin registry handles dependency resolution — plugins can declare dependencies on other plugins, and the registry ensures correct load order.

## First-Party Plugins

| Plugin | Description |
|---|---|
| `@downdraft/plugin-water` | Gerstner wave water rendering, buoyancy, shore/wake interactions |
| `@downdraft/plugin-marching-cubes` | Voxel terrain with LOD and deformation |
| `@downdraft/plugin-physics-rapier` | Rapier3D physics backend |
| `@downdraft/plugin-audio-kira` | Kira audio backend (Rust FFI) |
| `@downdraft/plugin-networking` | WebSocket transport, state replication, RPCs |
| `@downdraft/plugin-boats` | Boat design system and boat data buffer |
| `@downdraft/plugin-items` | Item definitions and registry |
| `@downdraft/plugin-inventory` | Inventory management |
| `@downdraft/plugin-crafting` | Crafting recipes and system |
| `@downdraft/plugin-economy` | Market system and price history |
| `@downdraft/plugin-fishing` | Fishing mechanics |
| `@downdraft/plugin-weather` | Weather system |
| `@downdraft/plugin-survival` | Survival mechanics |

## WASM ABI

The stable WASM ABI provides:

- Component access (read/write)
- SAB channel allocation
- System registration
- Resource access

This allows plugins written in Rust, C/C++, AssemblyScript, or any WASM-compatible language to integrate with the engine.
