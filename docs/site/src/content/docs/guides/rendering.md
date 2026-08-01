---
title: Rendering
description: WebGPU render pipeline and render graph
---

DownDraft uses WebGPU for rendering, with a deferred pipeline and a Bevy-style render graph.

## RenderLoop

```typescript
import { Camera, MeshBuilder, RenderLoop } from "@downdraft/core";

const camera = new Camera();
camera.setAspect(16, 9);
camera.distance = 5;

const mesh = MeshBuilder.cube(1);

const renderLoop = new RenderLoop({
  canvas,        // HTMLCanvasElement or OffscreenCanvas
  mesh,
  camera,
  mode: "gbuffer",  // or "simple" for forward rendering
});

await renderLoop.init();
renderLoop.start();
```

## Deferred Pipeline

The `RenderLoop` supports a deferred rendering pipeline:

1. **Depth prepass** — Early-Z prepass for occlusion culling
2. **G-Buffer** — Albedo, normal, roughness, metallic, depth, velocity
3. **Shadow map** — Shadow map pass
4. **Deferred lighting** — Compute lighting from G-Buffer
5. **Skybox** — Sky rendering
6. **Transparent** — Back-to-front transparent pass
7. **Post-process** — Tonemap, bloom, FXAA/TAA, color grade

A simple forward path is also available via `mode: "simple"`.

## Render Graph

The `RenderGraph` is a DAG (Directed Acyclic Graph) of render passes with:

- **Automatic resource aliasing** — GPU resources are reused across passes when lifetimes don't overlap
- **Usage flag sync** — Resource transitions are handled automatically
- **Pass validation** — Resource dependencies are validated at graph build time

## Render Passes

Built-in render passes include:

| Pass | Description |
|---|---|
| Opaque | G-Buffer geometry pass (albedo, normal, roughness, metallic, depth, velocity) |
| Transparent | Back-to-front transparent geometry |
| Depth Prepass | Early-Z prepass for occlusion culling |
| Shadow | Shadow map rendering |
| Post-Process | Post-processing chain (tonemap, bloom, FXAA/TAA, color grade) |
| UI Composite | Composite UI overlay |
| Debug | Debug visualization (wireframe, AABBs) |

## Mesh System

```typescript
import { MeshBuilder } from "@downdraft/core";

const cube = MeshBuilder.cube(1);
const sphere = MeshBuilder.sphere(0.5, 32, 16);
```

The mesh system supports vertex/index buffers, custom vertex attribute layouts, procedural mesh building, and skinned meshes with bone hierarchies.

## Material System

Materials combine a shader (WGSL) with uniforms and textures. The material graph provides a node-based editor (Unreal-style) with real-time WGSL compilation and validation.

Built-in material library includes PBR, unlit, skybox, particle, and post-process materials.
