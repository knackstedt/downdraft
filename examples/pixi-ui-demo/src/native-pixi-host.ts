// ============================================================================
// native-pixi-host.ts — in-process PixiUI for the native runtime.
//
// On the native host there is no OffscreenCanvas/WebGL2 worker — instead the
// demo scene runs in-process on NativePixiUiHost (PixiJS v8 WebGPU on the
// shared wgpu-native device). This adapter exposes the PixiUiHost-shaped
// surface the demo wiring + pixi_* MCP tools consume.
//
// Only reachable via dynamic import on the native path.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext } from "@downdraft/engine/libraries/pixi-ui";
import { NativePixiUiHost } from "@downdraft/engine/libraries/pixi-ui-native";
import { createLogger } from "@downdraft/engine/util/logger";
import createDemoScene from "./pixi-scene";
const log = createLogger();


/** PixiUiHost-shaped surface consumed by createPixiUiMcpTools + game wiring. */
export interface NativePixiHostAdapter {
  onAction: ((action: any) => void) | null;
  onInteractiveChange: ((interactive: boolean) => void) | null;
  start(): Promise<void>;
  writeStats(stats: Record<string, number>): void;
  setFontScale(scale: number): void;
  postEvent(event: any): void;
  queryScene(): Promise<{ nodes: any[]; interactive: boolean; backend: string }>;
  captureOverlay(): Promise<{ png: ArrayBuffer | null; width: number; height: number }>;
  setInteractive(interactive: boolean): void;
  dispatchPointer(type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave", x: number, y: number, button?: number): void;
  dispose(): void;
}

export interface NativeDemoUiHandle {
  host: NativePixiHostAdapter;
  /** Per-frame: drain events into the scene (call before game render). */
  tick(dt: number): void;
  /** Render PixiJS into the UI texture + blit onto the swapchain (call after game render). */
  composite(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function createNativeDemoUi(opts: {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** The main surface (getCanvas(0)) — NativeSurface on the native host. */
  surface: any;
}): Promise<NativeDemoUiHandle> {
  const { device, adapter, surface } = opts;
  let canvasW = surface.width | 0;
  let canvasH = surface.height | 0;

  const pixiUi = new NativePixiUiHost({
    device,
    adapter,
    targetFormat: "bgra8unorm",
    width: canvasW,
    height: canvasH,
  });
  await pixiUi.ready;

  let interactive = false;
  let fontScale = 1;
  const eventQueue: any[] = [];
  let latestStats: Record<string, number> = {};

  const host: NativePixiHostAdapter = {
    onAction: null,
    onInteractiveChange: null,
    start: () => Promise.resolve(),
    writeStats(stats) { latestStats = stats; },
    setFontScale(scale) { fontScale = Math.max(1, scale); sceneCtx.fontScale = fontScale; },
    postEvent(event) { eventQueue.push(event); },
    async queryScene() {
      const nodes = scene?.summarize?.() ?? [];
      return { nodes, interactive, backend: "webgpu-native" };
    },
    captureOverlay() {
      return new Promise((resolve) => {
        try {
          pixiUi.render();
          (pixiUi.canvas as any).toBlob(async (blob: Blob | null) => {
            if (!blob) { resolve({ png: null, width: 0, height: 0 }); return; }
            resolve({ png: await blob.arrayBuffer(), width: pixiUi.canvas.width, height: pixiUi.canvas.height });
          });
        } catch {
          resolve({ png: null, width: 0, height: 0 });
        }
      });
    },
    setInteractive(v) {
      interactive = v;
      host.onInteractiveChange?.(v);
    },
    dispatchPointer(type, x, y, button = 0) {
      dispatchSynthetic(type, x, y, button);
    },
    dispose() { dispose(); },
  };

  const sceneCtx: PixiUiSceneContext = {
    app: pixiUi.app,
    width: canvasW,
    height: canvasH,
    fontScale,
    sceneConfig: {},
    setInteractive(v) { host.setInteractive(v); },
    postAction: (a) => host.onAction?.(a),
    log: (level, msg) => {
      if (level === "error") log.error("pixi-scene", `${msg}`);
      else if (level === "warn") log.warn("pixi-scene", `${msg}`);
      else log.info("pixi-scene", `${msg}`);
    },
  };
  const scene: PixiUiScene = createDemoScene(sceneCtx);

  // ── Synthetic pointer dispatch → PixiJS EventSystem ──
  function dispatchSynthetic(type: string, x: number, y: number, button: number): void {
    const eventSystem = (pixiUi.renderer as any).events;
    if (!eventSystem) return;
    const domElement = eventSystem.domElement ?? pixiUi.canvas;
    const resolution = (pixiUi.renderer as any).resolution ?? 1;
    const px = x * resolution;
    const py = y * resolution;
    const r = pixiUi.renderer as any;
    if (r.lastObjectRendered !== pixiUi.app.stage) r._lastObjectRendered = pixiUi.app.stage;
    const rb = eventSystem.rootBoundary;
    if (rb && !rb.rootTarget) rb.rootTarget = pixiUi.app.stage;
    const syntheticEvent = {
      type,
      pointerId: 1,
      pointerType: "mouse",
      clientX: px,
      clientY: py,
      button,
      buttons: type === "pointerdown" ? (button === 0 ? 1 : button === 2 ? 2 : 4) : 0,
      preventDefault: () => {},
      stopPropagation: () => {},
      nativeEvent: null,
      isTrusted: true,
      offsetX: px,
      offsetY: py,
      pageX: px,
      pageY: py,
      target: domElement,
      composedPath: () => [domElement],
      cancelable: true,
      isPrimary: true,
      width: 1,
      height: 1,
      tiltX: 0,
      tiltY: 0,
      pressure: 0.5,
      twist: 0,
      tangentialPressure: 0,
    };
    const HANDLERS: Record<string, string> = {
      pointerdown: "_onPointerDown",
      pointermove: "_onPointerMove",
      pointerup: "_onPointerUp",
      pointerleave: "_onPointerOverOut",
    };
    const handler = eventSystem[HANDLERS[type] ?? type] as ((e: any) => void) | undefined;
    if (typeof handler === "function") {
      try { handler.call(eventSystem, syntheticEvent); } catch { /* ignore */ }
    }
  }

  // ── Per-frame tick ──
  let elapsed = 0;
  function tick(dt: number): void {
    elapsed += dt;
    const w = surface.width | 0;
    const h = surface.height | 0;
    if (w > 0 && h > 0 && (w !== canvasW || h !== canvasH)) {
      canvasW = w; canvasH = h;
      try { pixiUi.resize(w, h); } catch {}
      try { scene.resize?.(w, h); } catch {}
    }
    const events = eventQueue.length ? eventQueue.splice(0, eventQueue.length) : [];
    try {
      scene.update({ stats: latestStats, events, dt, elapsedTime: elapsed });
    } catch (e) { log.error("native-ui", `scene update: ${e}`); }
  }

  // ── Composite: render Pixi into the UI texture, blit onto the swapchain ──
  function composite(): void {
    const wctx = surface.getContext?.("webgpu") as { getCurrentTexture(): any } | null;
    const tex = wctx?.getCurrentTexture?.();
    if (!tex) return;
    pixiUi.render();
    const uiView = pixiUi.getUiTextureView();
    if (!uiView) return;
    try {
      const encoder = device.createCommandEncoder();
      pixiUi.blitPass.execute(encoder, tex.createView(), uiView);
      (device as any).queue.submit([encoder.finish()]);
    } catch (e) {
      log.error("native-ui", `composite error: ${e}`);
    }
  }

  function resize(width: number, height: number): void {
    canvasW = width; canvasH = height;
    try { pixiUi.resize(width, height); } catch {}
    try { scene.resize?.(width, height); } catch {}
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try { scene.dispose(); } catch {}
    try { pixiUi.dispose(); } catch {}
  }

  return { host, tick, composite, resize, dispose };
}
