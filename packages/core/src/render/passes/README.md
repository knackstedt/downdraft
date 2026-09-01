# Render Passes

This directory contains all render pass implementations (70 files). It is
currently flat. The categorization below documents a **future migration** into
subdirectories. Files should **not** be moved yet — doing so would break the
many relative imports across the codebase. When the migration is performed,
update all `./passes/<name>` import paths accordingly.

## Proposed subdirectory layout

### `passes/base/` — RenderPass base class & shared utilities
Core abstractions that all other passes build on.

| File | Description |
|------|-------------|
| (none currently — `render-pass.ts` lives in `../render-pass.ts`) | `RenderPass` base class |
| `volumetric-types.ts` | Shared volumetric fog type definitions |
| `gi-types.ts` | Shared global illumination (RSM/VPL) type definitions |

### `passes/gbuffer/` — GBuffer & deferred lighting
Passes related to the deferred rendering pipeline (GBuffer generation +
deferred shading).

| File | Description |
|------|-------------|
| `deferred-lighting.ts` | Deferred lighting pass (reads GBuffer) |
| `depth-prepass.ts` | Depth pre-pass (z-prepass for deferred) |
| `cluster-lighting-pass.ts` | Clustered deferred lighting pass |

### `passes/postfx/` — Post-processing passes
Screen-space and fullscreen post-processing effects.

| File | Description |
|------|-------------|
| `highlight.ts` | Highlight/selection outline post-effect |
| `glow.ts` | Selective bloom/glow pass |
| `grain.ts` | Film grain post-effect |
| `sharpen.ts` | Image sharpening pass |
| `edges.ts` | Edge detection / toon outline pass |
| `outline.ts` | Object outline post-effect |
| `motion-blur.ts` | Camera/object motion blur |
| `lens-flare.ts` | Lens flare post-effect |
| `ssao.ts` | Screen-space ambient occlusion |
| `ssr.ts` | Screen-space reflections |
| `post-process.ts` | Generic post-process pass (tone mapping, etc.) |
| `underwater-fog.ts` | Underwater fog post-effect |
| `debug-viz.ts` | Debug visualization overlays |

> **Note:** The unified `PostProcessStack` (21+ chainable effects), its WGSL
> shaders, the `PostfxLib` engine-library descriptor, and the `LUT3D` color
> grading effect have moved to the dedicated `@downdraft/library-postfx`
> package at `packages/libraries/postfx/`. The standalone `lut3d.ts`
> frame-graph pass has been removed in favor of the in-chain `lut` effect.

### `passes/compute/` — Compute passes
GPU compute shader passes (GPGPU).

| File | Description |
|------|-------------|
| `graph-compute.ts` | Graph-based compute pass (node-authored compute shaders) |
| `skinning.ts` | GPU skinning compute pass (`SkinningComputePass`) |
| `skinning-vs.ts` | Vertex-shader skinning pass (compute-assisted) |
| `procedural-texture.ts` | Procedural texture generation (compute) |

### `passes/forward/` — Forward rendering passes
Traditional forward-rendering passes (opaque, transparent, sky, etc.).

| File | Description |
|------|-------------|
| `opaque.ts` | Opaque forward pass (main geometry pass) |
| `transparent.ts` | Transparent/alpha-blended forward pass |
| `skybox.ts` | Skybox rendering pass |
| `sky-dome.ts` | Procedural sky dome pass |
| `dome-360.ts` | 360° dome/environment pass |
| `terrain.ts` | Terrain rendering pass |
| `water.ts` | Water surface pass |
| `clouds.ts` | Volumetric clouds pass |
| `atmosphere.ts` | Atmospheric scattering pass |
| `fluid-render.ts` | Fluid simulation render pass |

### `passes/shadow/` — Shadow mapping passes
(If a sixth subdirectory is desired; otherwise fold into `forward/`.)

| File | Description |
|------|-------------|
| `shadow.ts` | Base shadow map pass |
| `shadow-map.ts` | Shadow map system manager |
| `csm.ts` | Cascaded shadow maps |
| `point-light-shadow.ts` | Point light shadow cube maps |
| `spot-light-shadow.ts` | Spot light shadow maps |

### `passes/special/` — Specialized / miscellaneous passes
(If a seventh subdirectory is desired; otherwise keep at top level.)

| File | Description |
|------|-------------|
| `debug.ts` | Debug render pass (lines, points, text) |
| `cubemap-capture.ts` | Cubemap capture pass (reflection probes) |
| `reflection-probe.ts` | Reflection probe pass/types |
| `rsm-pass.ts` | Reflective shadow map (RSM) pass for GI |
| `volumetric-pass.ts` | Volumetric lighting/fog pass |
| `sdf-text.ts` | SDF text rendering pass |
| `ui-composite.ts` | UI composition pass |
| `video-texture.ts` | Video texture source pass |
| `decal-mesh.ts` | Decal mesh generation utilities |
| `decal-pass.ts` | Decal rendering pass |
| `greased-line-pass.ts` | Greased line rendering pass |
| `morph-target.ts` | Morph target pass |

## Migration notes

1. **Import paths**: All passes are currently imported via `./passes/<name>`
   from the render barrel and via `../passes/<name>` from sibling render files.
   After moving, these paths become `./passes/<subdir>/<name>` and
   `../passes/<subdir>/<name>` respectively.
2. **Spec files**: Each `.spec.ts` file should move alongside its source file.
3. **Barrel exports**: `packages/core/src/render/index.ts` re-exports all
   passes — update the paths there after migration.
4. **Cross-pass imports**: Some passes import from sibling passes (e.g.
   `post-process.ts` imports from `volumetric-types.ts`). Update these
   relative paths after moving.
