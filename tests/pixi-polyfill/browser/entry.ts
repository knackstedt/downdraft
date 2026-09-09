// ============================================================================
// entry.ts — Browser entry point for the pixi-polyfill test harness.
//
// This module is bundled by Bun.build into a single JS file and loaded by
// page.html. It reads the scene id from the URL query string, creates a
// PixiJS v8 WebGPU Application on a canvas, builds the scene, renders one
// frame, and signals readiness via `window.__PIXI_READY__`.
//
// The Playwright driver (render.ts) navigates to `/?scene=<id>`, waits for
// that flag, then screenshots the canvas element.
// ============================================================================

import { Application } from "pixi.js";
import { getSceneById } from "../scenes/registry";
import { DEFAULT_BACKGROUND, DEFAULT_HEIGHT, DEFAULT_WIDTH } from "../scenes/types";

async function main() {
  const params = new URLSearchParams(location.search);
  const sceneId = params.get("scene") ?? "";
  const scene = getSceneById(sceneId);
  if (!scene) {
    document.body.innerText = `Unknown scene: ${sceneId}`;
    (window as any).__PIXI_READY__ = true;
    (window as any).__PIXI_ERROR__ = `Unknown scene: ${sceneId}`;
    return;
  }

  const width = scene.width ?? DEFAULT_WIDTH;
  const height = scene.height ?? DEFAULT_HEIGHT;
  const background = scene.background ?? DEFAULT_BACKGROUND;

  // Create a canvas sized exactly to the render target so the Playwright
  // element screenshot is pixel-perfect (no devicePixelRatio scaling).
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const app = new Application();
  try {
    await app.init({
      canvas,
      width,
      height,
      background,
      backgroundAlpha: 1,
      preference: "webgpu",
      antialias: false,
      resolution: 1,
      autoDensity: false,
      autoStart: false,
    });
  } catch (e: any) {
    console.error("[harness] PIXI.Application init failed:", e);
    (window as any).__PIXI_READY__ = true;
    (window as any).__PIXI_ERROR__ = String(e?.message ?? e);
    return;
  }

  // Ensure the DejaVu Sans font is fully loaded BEFORE building the scene.
  // PixiJS Text rasterizes glyphs to a canvas texture at build time and caches
  // the result; if the @font-face TTF is not yet loaded, it rasterizes with a
  // fallback font and never re-rasterizes. Awaiting fonts.ready (and an
  // explicit load) first guarantees the same glyphs the native FreeType path
  // renders.
  try {
    const fonts = (document as any).fonts;
    if (fonts) {
      await fonts.load("12px 'DejaVu Sans'");
      await fonts.load("48px 'DejaVu Sans'");
      await fonts.ready;
    }
  } catch { /* fonts API unavailable */ }

  // Build the scene on the stage.
  try {
    scene.build(app.stage, { width, height });
  } catch (e: any) {
    console.error("[harness] scene.build failed:", e);
    (window as any).__PIXI_READY__ = true;
    (window as any).__PIXI_ERROR__ = `scene.build: ${e?.message ?? e}`;
    return;
  }

  // Render one frame (autoStart: false, so we drive it manually).
  app.render();

  // Debug: confirm the DejaVu Sans font actually loaded and measure a sample.
  try {
    const loaded = await (document as any).fonts?.check?.("32px 'DejaVu Sans'");
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = "32px 'DejaVu Sans'";
    const m = probe.measureText("PixiJS Text Rendering");
    console.log("[harness] font check:", loaded, "measure width:", m.width);
  } catch (e) { console.log("[harness] font probe failed:", e); }

  (window as any).__PIXI_APP__ = app;
  (window as any).__PIXI_READY__ = true;
}

main().catch((e) => {
  console.error("[harness] uncaught:", e);
  (window as any).__PIXI_READY__ = true;
  (window as any).__PIXI_ERROR__ = String(e?.message ?? e);
});
