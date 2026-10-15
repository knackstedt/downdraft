---
title: Gaussian Splats
description: gaussian-splats engine library — architecture, renderer integration, config
---

## Gaussian Splatting library (`@downdraft/engine/libraries/gaussian-splats`)

A renderer-only engine library for rendering 3D Gaussian Splat scenes (INRIA `.ply` and `.splat` formats). Uses a Structure-of-Arrays (SoA) data layout for GPU-friendly uploads.

### Architecture

The library is split into four modules, each implementing a phase of the splat rendering pipeline:

1. **Parser** (`parser.ts`) — Parses INRIA PLY and `.splat` files into a `GaussianSplatData` SoA structure: `position`, `scale`, `rotation`, `color` (with opacity sigmoid baked into alpha), and `shCoeffs` (f_rest SH coefficients). Supports SH degrees 0-3.

2. **GPU radix sort** (`gpu-sort.ts`) — `GpuSplatSorter` sorts splats back-to-front by camera distance using a GPU radix sort (4-bit radix, 8 passes for u32 keys). Below `sortThreshold` (default 8192), falls back to CPU merge sort. After sorting, compacts the splat buffer into sorted order via a compute pass.

3. **Spherical harmonics** (`sh-eval.ts`) — `packShCoeffs()` packs SH "rest" coefficients (degrees 1-3) from parsed data, truncated to the configured `shDegree`. `SH_EVAL_WGSL` is a WGSL chunk inserted into the fragment shader that evaluates real spherical harmonics for view-dependent color. The DC color is already baked into `GaussianSplatData.color` by the parser; SH adds the view-dependent contribution.

4. **Tile-based rasterization** (`tile-raster.ts`) — `TileRasterPipeline` implements an alternative render path: a compute pass bins splats into 16×16 screen-space tiles, then a full-screen-triangle fragment shader iterates over per-tile splat lists and alpha-blends back-to-front. This replaces the default instanced-quad approach. The global sort ensures per-tile splat order is correct without a separate per-tile sort.

### Renderer integration

`GaussianSplatRenderer` orchestrates all four modules. The render path:
1. Write camera uniforms (viewProj, cameraPos, resolution).
2. Sort + compact splats (GPU radix sort or CPU fallback, every `sortFrequency` frames).
3. If `tileRaster` is enabled: bin splats into tiles (compute) → draw full-screen triangle (per-pixel splat iteration).
4. Else: draw instanced quads (4 verts × N instances, with SH eval in fragment shader).

### Config (`GaussianSplatsLibConfig`)

| Field | Default | Description |
|-------|---------|-------------|
| `surfaceFormat` | `"bgra8unorm"` | Surface texture format |
| `maxSplats` | `1_000_000` | GPU sort buffer pre-allocation |
| `sortThreshold` | `8192` | Below this count, use CPU sort |
| `sortFrequency` | `1` | Sort every N frames |
| `shDegree` | `0` | Max SH degree (0=DC only, 1-3=view-dependent) |
| `tileRaster` | `false` | Use tile-based rasterization |
| `tileRasterOptions` | `{}` | Tile size + max splats per tile |

### Declarative usage

```ts
import { GaussianSplatsLib } from "@downdraft/engine/libraries/gaussian-splats";

startGame({
  libraries: [[GaussianSplatsLib, {
    shDegree: 2,
    sortThreshold: 4096,
    tileRaster: true,
  }]],
  // ...
});
```

All in `packages/engine/libraries/gaussian-splats/src/` — the four pipeline files above plus `renderer.ts` (orchestrator), `library.ts` (descriptor), `sorter.ts` (CPU fallback).

