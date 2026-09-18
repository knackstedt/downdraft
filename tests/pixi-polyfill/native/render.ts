// ============================================================================
// render.ts — Native polyfill renderer (Bun + wgpu-native + NativePixiUiHost).
//
// Creates a shared native host (GPU + DOM polyfills) once per process, then
// for each scene spins up a NativePixiUiHost, builds the scene on its stage,
// renders one frame into the UI texture, and captures that texture as a PNG.
//
// The UI texture is backed by a VirtualCanvas GPUTexture (not the swapchain),
// so capturing it does not require presenting to a window.
// ============================================================================

import { NativePixiUiHost } from "@downdraft/engine/libraries/pixi-ui-native";
import {
    captureScreenshot,
    createNativeHost,
    type NativeHostContext,
} from "@downdraft/platform-native";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getSceneById } from "../scenes/registry";
import { DEFAULT_BACKGROUND, DEFAULT_HEIGHT, DEFAULT_WIDTH } from "../scenes/types";

// Shared host — created lazily and reused across scenes in one process.
let sharedHost: NativeHostContext | null = null;

async function getSharedHost(): Promise<NativeHostContext> {
  if (sharedHost) return sharedHost;
  // A small window is required for the SDL event loop + GPU surface init,
  // but the UI is rendered into a separate VirtualCanvas texture, so the
  // window size is irrelevant to the captured output.
  sharedHost = await createNativeHost({
    window: {
      title: "PixiJS Polyfill Native Harness",
      width: 64,
      height: 64,
    },
  });
  return sharedHost;
}

/** Destroy the shared host (call at the end of the test run). */
export async function disposeNativeHost(): Promise<void> {
  if (sharedHost) {
    try { sharedHost.destroy(); } catch { /* ignore */ }
    sharedHost = null;
  }
}

export interface NativeRenderResult {
  path: string;
  width: number;
  height: number;
}

/**
 * Render a single scene in the native polyfill and capture the UI texture.
 * `onLog` receives human-readable progress lines.
 */
export async function renderNative(
  sceneId: string,
  outPath: string,
  onLog?: (msg: string) => void,
): Promise<NativeRenderResult> {
  const log = (m: string) => onLog?.(`[native] ${m}`);

  const scene = getSceneById(sceneId);
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);

  const width = scene.width ?? DEFAULT_WIDTH;
  const height = scene.height ?? DEFAULT_HEIGHT;
  const background = scene.background ?? DEFAULT_BACKGROUND;

  const host = await getSharedHost();
  const { device, adapter } = host;

  // The blit target format is the swapchain format; the UI texture format is
  // chosen by PixiJS when it configures the VirtualCanvas context. We read
  // that format back from the context after init for the BGRA→RGBA swap.
  const pixi = new NativePixiUiHost({
    device,
    adapter,
    targetFormat: "bgra8unorm",
    width,
    height,
    backgroundColor: background,
    backgroundAlpha: 1,
  });

  try {
    await pixi.ready;
    log("PixiJS Application initialized on shared wgpu-native device");

    // Build the scene on the stage.
    scene.build(pixi.stage, { width, height });

    // Render one frame into the UI texture.
    pixi.render();
    log("rendered one frame into UI texture");

    // Capture the UI texture as a PNG.
    const ctx = pixi.canvas.getWebgpuContext();
    const uiTexture = ctx.getUiTexture();
    if (!uiTexture) throw new Error("UI texture is null after render");
    const format = (ctx.getFormat() as GPUTextureFormat) ?? "bgra8unorm";

    mkdirSync(resolve(outPath, ".."), { recursive: true });
    captureScreenshot(device, uiTexture, width, height, outPath, format);
    log(`screenshot saved: ${outPath} (${width}x${height})`);

    return { path: outPath, width, height };
  } finally {
    try { pixi.dispose(); } catch { /* ignore */ }
  }
}
