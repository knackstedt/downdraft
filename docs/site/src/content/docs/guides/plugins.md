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
| `@downdraft/plugin-weather` | Weather system |
| `@downdraft/plugin-camera-controls` | Orbit/pan/zoom camera controller (renderer plugin) |
| `@downdraft/plugin-devtools` | Transform gizmo, debug overlays (renderer plugin) |
| `@downdraft/plugin-electron-osr` | Electron offscreen render UI (renderer plugin) |
| `@downdraft/plugin-xr` | WebXR VR sessions (sim + renderer plugin) |

## Game Plugins (to-the-ocean)

Game-specific plugins live in `games/to-the-ocean/plugins/` under the `@to-the-ocean/plugin-*` namespace. They depend on engine plugins and `@downdraft/core` but are owned by the game.

| Plugin | Description |
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

## Renderer Plugins

The `Plugin` interface above is **sim-thread only** — it runs inside the sim
worker and has no access to the GPU device, canvas, or DOM. Concerns that live
on the renderer thread (camera controllers, input handling, gizmos, XR
sessions, offscreen UI) use a separate `RendererPlugin` interface.

### `RendererPlugin` Interface

```typescript
import type { RendererPlugin, RendererPluginContext } from "@downdraft/core";

const myPlugin: RendererPlugin = {
  name: "my-renderer-plugin",
  version: "0.1.0",
  register(ctx: RendererPluginContext) {
    // Access the GPU device, canvas, format, render pipeline
    const device = ctx.getDevice();
    const canvas = ctx.getCanvas();

    // Subscribe to pointer/key/wheel/drag events from the shared input bus
    const bus = ctx.getInputBus();
    bus.onPointerDown((e, ctrl) => {
      // ctrl.stopPropagation() blocks lower-priority subscribers
      // (e.g. the camera controller) from receiving this event
    }, /* priority */ 100);

    // Hook into the frame loop at specific phases
    ctx.onFrame("beforeFrame", (dt, elapsedTime) => { /* ... */ });
    ctx.onFrame("afterViewports", (dt, elapsedTime) => { /* ... */ });

    // Render inside the scene render pass (after opaque, before post)
    ctx.onRenderPass((passEncoder, camera, viewportIdx) => {
      // Draw gizmos, overlays, etc.
    });

    // Register a camera controller (orbit/pan/zoom)
    ctx.setCameraController(myController);

    // Override per-viewport cameras (used by XR for stereo eyes)
    ctx.setViewportCameraProvider((vp, dt, et) => myEyeCamera);

    // Swap the rAF source, render target provider, viewport count
    // (used by XR to switch to session.requestAnimationFrame)
    ctx.setRAFSource(myRAF, myCancel);
    ctx.setRenderTargetProvider(myProvider);
    ctx.setViewportCount(2);

    // Clean up on dispose
    ctx.onDispose(() => { /* release resources */ });
  },
};
```

### Registering Renderer Plugins

Renderer plugins are registered with `GameRenderer` via the
`RendererPluginHost`:

```typescript
import { GameRenderer } from "@downdraft/core";
import { createCameraControlsPlugin } from "@downdraft/plugin-camera-controls";

const renderer = new GameRenderer({ /* ... */ });
await renderer.init();

// Register the camera controls plugin
const cameraPlugin = createCameraControlsPlugin({
  initialCamera: { position: [0, 5, 10], target: [0, 0, 0], fov: 60 },
  orbit: { rotateSpeed: 0.005, minDistance: 0.1, maxDistance: 500 },
});
renderer.useRendererPlugin(cameraPlugin);

// Access the controller later via the plugin's getter
const controller = cameraPlugin.getController();
controller?.frameBounds(min, max);
```

### Input Bus

The `RendererInputBus` is a shared, priority-ordered event bus that all
renderer plugins subscribe to. Events flow from the canvas DOM listeners
through the bus to subscribers in priority order (lower number = earlier). A
subscriber can call `ctrl.stopPropagation()` to block later subscribers —
this is how a gizmo drag blocks the camera controller from also rotating.

Subscribers can register handlers for:
- `onPointerDown` / `onPointerMove` / `onPointerUp` (pointer events)
- `onWheel` (wheel events)
- `onKeyDown` / `onKeyUp` (keyboard events)
- `onDrag` (synthesized drag-delta stream while a button is held)

### Camera Controller

The `CameraController` is a batteries-included orbit/pan/zoom camera with:
- Multiple named cameras (e.g. "main", "minimap")
- Smooth interpolation (lerp) between camera states
- `bindOrbit(inputBus, options)` — wires orbit/pan/zoom input from a
  `RendererInputBus` to the active camera
- `frameBounds(min, max)` — auto-frames the camera to fit an AABB
- `setAspect(w, h)` — updates the camera projection aspect ratio

Games that use `GameRenderer` get the controller via
`@downdraft/plugin-camera-controls`. Games with bespoke render loops (like
the model-viewer) can use `CameraController` + `RendererInputBusImpl`
directly from `@downdraft/core`.

### Sim + Renderer Plugins

Some concerns span both threads. XR, for example, needs sim-thread resources
(session state, input mapping) and renderer-thread infrastructure (per-eye
cameras, XR rAF, layer textures). These ship as two objects:

```typescript
// Sim thread — registers XR session manager + input mapper as resources
gameWorld.usePlugin(xrPlugin);

// Renderer thread — owns the XR frame loop, per-eye cameras, rAF swap
const xr = new XRPlugin({ device });
renderer.useRendererPlugin(xr);
await xr.enterVR();
```

## WASM ABI

The stable WASM ABI provides:

- Component access (read/write)
- SAB channel allocation
- System registration
- Resource access

This allows plugins written in Rust, C/C++, AssemblyScript, or any WASM-compatible language to integrate with the engine.
