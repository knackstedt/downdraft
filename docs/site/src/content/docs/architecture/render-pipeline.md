---
title: Render Pipeline
description: Deferred WebGPU rendering pipeline and render graph
---

DownDraft uses a deferred WebGPU rendering pipeline with a Bevy-style render graph for automatic resource management.

## Pipeline Stages

The deferred pipeline executes in this order:

1. **Depth Prepass** — Early-Z prepass writes depth buffer for occlusion culling. Reduces overdraw in the main pass.

2. **G-Buffer Pass** — Opaque geometry rendered to multiple render targets:
   - Albedo (RGBA8)
   - Normal (RGBA16F)
   - Roughness / Metallic (RG8)
   - Depth (Depth32Float)
   - Velocity (RG16F) — for TAA

3. **Shadow Map Pass** — Shadow depth maps rendered from light perspectives. Supports cascaded shadow maps for directional lights and point shadow maps for point lights.

4. **Deferred Lighting** — Compute pass reads G-Buffer and shadow maps to calculate lighting. Supports:
   - Directional lights (sun)
   - Point lights (dynamic, distance-culled)
   - Spot lights (flashlight, etc.)
   - Ambient and fog

5. **Sky Pass** — Sky dome rendered with atmospheric scattering, sun/moon, weather blending.

6. **Transparent Pass** — Back-to-front rendering of transparent geometry (water, particles, clouds).

7. **Post-Process Chain** — Configurable post-processing stack:
   - Tonemapping (ACES, Reinhard, etc.)
   - Bloom
   - FXAA / TAA
   - Depth of field
   - Sobel edge detection
   - Afterimage
   - ASCII art
   - Color grading (LUT)
   - Pixelation

## Render Graph

The `RenderGraph` is a DAG of render passes with:

- **Automatic resource aliasing** — GPU resources (textures, buffers) are reused across passes when lifetimes don't overlap
- **Usage flag synchronization** — Resource transitions between read/write are handled automatically
- **Pass validation** — Resource dependencies validated at graph build time
- **Pipeline caching** — Render pipelines cached and specialized

## Viewport Support

The renderer supports split-screen with 1-4 viewports. Each viewport renders independently with its own camera, sharing the same render pass (offscreen targets are cleared on first viewport, loaded on subsequent).

## Frame Rate Limiting

A frame rate limiter is available for X11 multi-monitor vsync issues where `requestAnimationFrame` fires at the fastest monitor's refresh rate. The limiter uses an adaptive accumulator to skip frames when the RAF interval is faster than the target frame time.

## GPU Profiling

When supported, GPU timestamp queries provide per-pass timing data:

- Sky, Terrain, Entities, Clouds, Water, Debug, Models, Particles, Gizmo, UnderwaterFog
- Each pass tracks draw calls and triangle counts
- Exposed via telemetry collector and MCP tools
