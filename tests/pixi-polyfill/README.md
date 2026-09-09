# PixiJS Polyfill Visual Parity Test Suite

Verifies that the native PixiJS polyfill (`@downdraft/library-pixi-ui-native` on
Bun + wgpu-native) renders identically to the browser reference (PixiJS v8
WebGPU in Electron/Chromium).

## How it works

Each scene is a pure function that builds a PixiJS scene tree from primitives
(`Graphics`, `Text`, `Container`). The **same** scene is rendered two ways:

1. **Browser reference** — bundled by `Bun.build`, served by a static
   `Bun.serve`, and rendered in the project's bundled **Electron** (Chromium +
   WebGPU) driven via Playwright's `_electron` support. The system
   `google-chrome` does not expose WebGPU on this host, but the project's
   Electron does (same path the e2e tests use, via `DOWNDRAFT_GPU=swiftshader`
   by default).
2. **Native polyfill** — rendered in-process by `NativePixiUiHost` on the
   shared wgpu-native device into a `VirtualCanvas` GPUTexture, which is
   captured directly as a PNG (no swapchain present).

Both PNGs are compared pixel-by-pixel (`compare.ts`). A scene passes when the
mean per-channel difference is below `maxMeanPerChannel` (default 6.0/255);
per-pixel anti-aliasing fringes are tolerated via `mismatchTolerance`
(default 24).

## Running

```bash
# All scenes:
bun test tests/pixi-polyfill/polyfill.spec.ts

# A single scene (debugging):
PIXI_POLYFILL_ONLY=text bun test tests/pixi-polyfill/polyfill.spec.ts
```

Artifacts (browser/native/diff PNGs) are written to `tests/pixi-polyfill/artifacts/`.

## Environment

- `DOWNDRAFT_GPU` — `swiftshader` (default, software WebGPU) or `hardware`
  (real GPU) for the browser reference.
- `PIXI_POLYFILL_ONLY=sceneId` — render/compare only one scene.

## Adding a scene

1. Create `scenes/<category>/<name>.ts` exporting a `PixiScene` (see
   `scenes/text.ts`).
2. Import + add it to `SCENES` in `scenes/registry.ts`.
3. Run the spec.

## Font matching

The native FreeType rasterizer (SDL2_ttf) always uses `DejaVuSans.ttf` and
ignores `fontFamily`/weight/italic. The browser harness loads the same TTF via
`@font-face` and **awaits `document.fonts.ready` before building the scene** so
PixiJS rasterizes with DejaVu Sans (not a fallback). Scenes should use
`fontFamily: "DejaVu Sans"` and avoid bold/italic unless a matching TTF
variant is registered for the native side too.

## Found bugs (fixed)

- **R/B channel swap in native text/image textures**: `copyExternalImageToTexture`
  uploaded RGBA canvas pixels to `bgra8unorm` textures without swapping R and B,
  causing text colors to render with red and blue swapped. Fixed in
  `packages/platform-native/src/gpu/wgpu-wrapper.ts`.
