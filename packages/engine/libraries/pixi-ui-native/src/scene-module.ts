// ============================================================================
// scene-module.ts — createNativePixiUiScene: run a pixi-ui scene in-process
// on the native renderer.
//
// The browser path runs a PixiUiScene in a Web Worker behind PixiUiHost
// (OffscreenCanvas + SAB + postMessage). On the native runtime there is no
// DOM compositor — instead this module hosts the same scene factory on a
// NativePixiUiHost (PixiJS WebGPU on the game's shared device, rendered into
// a texture) and composites it through GameRenderer's end-of-frame UI pass
// via ScreenUiCompositor.
//
//   renderer.useRendererModule(createNativePixiUiScene({
//     scene: (ctx) => createMyScene(ctx),
//     isInteractive: () => store.anyMenuOpen,
//     onAction: (a) => { /* same switch as the browser onAction */ },
//   }));
//   handle.writeStats({ fps: 60, ... });   // mirrors PixiUiHost.writeStats
//   handle.postEvent({ kind: "..." });     // mirrors PixiUiHost.postEvent
//
// Input: pointer events are captured on the surface and forwarded to PixiJS's
// EventSystem when isInteractive() is true and a UI element is hit. Consumed
// events are stopPropagation()'d — register this module BEFORE the game
// attaches its own canvas listeners so UI hits shield the game.
// ============================================================================

import type { RendererModule, RendererModuleContext } from "@downdraft/engine";
import { createLogger, resourceToken } from "@downdraft/engine";
import type {
    PixiUiAction,
    PixiUiEvent,
    PixiUiScene,
    PixiUiSceneContext,
    PixiUiSceneFactory,
} from "@downdraft/engine/libraries/pixi-ui";
import { NativePixiUiHost } from "./host";
import { NativePixiInputRouter } from "./input-router";

type StatsValues = Partial<Record<string, number>>;

const log = createLogger("info");

export interface NativePixiUiSceneOptions {
  /** Module name (default "pixi-ui-scene"). */
  name?: string;
  /** The game's scene factory — the same function the browser worker path
   *  loads via PixiUiHost's sceneModuleUrl. */
  scene: PixiUiSceneFactory;
  /** Opaque config passed to the scene factory (ctx.sceneConfig). */
  sceneConfig?: unknown;
  /** Initial font scale (>= 1.0). */
  fontScale?: number;
  /** Pointer-routing gate — return true while any interactive overlay is
   *  open so UI hit-tests can consume events. Default: hit-test always. */
  isInteractive?: () => boolean;
  /** Scene action sink — mirrors PixiUiHost.onAction. */
  onAction?: (action: PixiUiAction) => void;
  /** GPUAdapter override — pixi only reads `adapter.features` for
   *  compressed-format detection; defaults to navigator.gpu.requestAdapter(). */
  adapter?: GPUAdapter;
}

export interface NativePixiUiSceneHandle {
  /** The in-process pixi host (null until the module registers). */
  readonly host: NativePixiUiHost | null;
  /** The live scene (null until the factory resolves). */
  readonly scene: PixiUiScene | null;
  /** Merge per-frame scalar stats — mirrors PixiUiHost.writeStats. */
  writeStats(stats: StatsValues): void;
  /** Queue a structured event for the next scene.update — mirrors postEvent. */
  postEvent(event: PixiUiEvent): void;
  /** Update the scene font scale (re-read by scenes on next update). */
  setFontScale(scale: number): void;

  // ── PixiUiHost-compat surface (drop-in for games sharing wiring with the
  //    browser path — e.g. MCP pixi_* tools via createPixiUiMcpTools) ──
  /** Scene action sink — settable, mirrors PixiUiHost.onAction. */
  onAction: ((action: PixiUiAction) => void) | null;
  /** No-op — the module self-starts on register(). */
  start(): Promise<void>;
  /** Force/hold interactive mode (mirrors PixiUiHost.setInteractive). */
  setInteractive(interactive: boolean): void;
  /** Inject a pointer event in surface coordinates (MCP dispatch_pointer). */
  dispatchPointer(type: string, x: number, y: number, button?: number): void;
  /** Scene-graph summary for MCP queryScene. */
  queryScene(timeoutMs?: number): Promise<{ nodes: unknown[]; interactive: boolean; backend: string }>;
  /** PNG snapshot of the UI texture (MCP capture_overlay). Best-effort —
   *  returns `{png:null}` when readback isn't available. */
  captureOverlay(timeoutMs?: number): Promise<{ png: ArrayBuffer | null; width: number; height: number }>;
  /** Tear down the scene + host (also runs on module dispose). */
  dispose(): void;
}

export const NativePixiUiSceneTok = resourceToken<NativePixiUiSceneHandle>("nativePixiUiScene");

const MODIFIER_BITS = { shift: 1, ctrl: 2, alt: 4, meta: 8 };

function modifierBits(e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): number {
  return (e.shiftKey ? MODIFIER_BITS.shift : 0)
    | (e.ctrlKey ? MODIFIER_BITS.ctrl : 0)
    | (e.altKey ? MODIFIER_BITS.alt : 0)
    | (e.metaKey ? MODIFIER_BITS.meta : 0);
}

export function createNativePixiUiScene(options: NativePixiUiSceneOptions): RendererModule & NativePixiUiSceneHandle {
  const moduleName = options.name ?? "pixi-ui-scene";

  let host: NativePixiUiHost | null = null;
  let scene: PixiUiScene | null = null;
  let sceneCtx: PixiUiSceneContext | null = null;
  let router: NativePixiInputRouter | null = null;
  let forceInteractive = false;
  const pendingStats: StatsValues = {};
  const eventQueue: PixiUiEvent[] = [];

  const mod: RendererModule & NativePixiUiSceneHandle = {
    name: moduleName,
    version: "1.0.0",
    provides: [NativePixiUiSceneTok],

    get host() { return host; },
    get scene() { return scene; },
    writeStats(stats) { Object.assign(pendingStats, stats); },
    postEvent(event) { eventQueue.push(event); },
    setFontScale(scale) { if (sceneCtx) sceneCtx.fontScale = scale; },

    onAction: null,
    start: () => Promise.resolve(),
    setInteractive(interactive) { forceInteractive = interactive; },
    dispatchPointer(type, x, y, button = 0) {
      if (!router) return;
      switch (type) {
        case "pointerdown": router.handlePointerDown(x, y, button, 0); break;
        case "pointermove": router.handlePointerMove(x, y, button, 0); break;
        case "pointerup": router.handlePointerUp(x, y, button, 0); break;
      }
    },
    queryScene: async () => ({
      nodes: scene?.summarize?.() ?? [],
      interactive: forceInteractive || (options.isInteractive?.() ?? false),
      backend: "wgpu-native",
    }),
    captureOverlay: async () => {
      const w = host?.canvas.width ?? 0;
      const h = host?.canvas.height ?? 0;
      try {
        const extract = (host?.renderer as any)?.extract;
        if (!extract) return { png: null, width: w, height: h };
        const cnv = extract.canvas(host!.app.stage) as any;
        const c2d = cnv?.getContext?.("2d");
        const img = c2d?.getImageData?.(0, 0, cnv.width, cnv.height);
        if (!img?.data) return { png: null, width: w, height: h };
        const { encodePNG } = await import("@downdraft/platform-native/screenshot/screenshot" as any);
        const png = encodePNG(cnv.width, cnv.height, new Uint8Array(img.data.buffer));
        const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
        return { png: ab, width: cnv.width, height: cnv.height };
      } catch {
        return { png: null, width: w, height: h };
      }
    },
    dispose() {
      try { scene?.dispose(); } catch { /* ignore */ }
      try { host?.dispose(); } catch { /* ignore */ }
      host = null;
      scene = null;
      router = null;
    },

    register(ctx: RendererModuleContext) {
      const canvas = ctx.getCanvas() as any;
      const w = canvas.width || canvas.clientWidth || 1280;
      const h = canvas.height || canvas.clientHeight || 720;
      const unsubs: Array<() => void> = [];

      // Async bring-up: adapter (only used by pixi for feature detection) →
      // NativePixiUiHost → scene factory. Frames render without the UI until
      // the scene resolves.
      const init = (async () => {
        const adapter = options.adapter
          ?? await (navigator.gpu as GPU).requestAdapter()
          ?? (() => { throw new Error("navigator.gpu.requestAdapter returned null"); })();
        host = new NativePixiUiHost({
          device: ctx.getDevice(),
          adapter,
          targetFormat: ctx.getFormat(),
          width: w,
          height: h,
          resolution: 1,
        });
        await host.ready;

        sceneCtx = {
          app: host.app,
          width: w,
          height: h,
          fontScale: options.fontScale ?? 1,
          sceneConfig: options.sceneConfig,
          setInteractive: (interactive) => { forceInteractive = interactive; },
          postAction: (action) => {
            try { (mod.onAction ?? options.onAction)?.(action); } catch (err) {
              log.error(moduleName, `onAction error: ${err}`);
            }
          },
          log: (level, msg) => log[level]?.(moduleName, msg),
        };
        scene = await options.scene(sceneCtx);

        router = new NativePixiInputRouter(host, w, h, {
          isInteractive: () => forceInteractive || (options.isInteractive?.() ?? true),
        });

        // Surface-level listeners with stopPropagation shielding — on native,
        // MiniEventTarget treats stopPropagation as immediate within a target,
        // so a UI-consumed pointer event never reaches later canvas listeners
        // (the game's input handler). Register this module before the game
        // wires its input for the shielding to apply.
        const on = (type: string, fn: (e: any) => boolean) => {
          const listener = (e: any) => {
            try {
              if (fn(e)) e.stopPropagation?.();
            } catch (err) {
              log.error(moduleName, `${type} router error: ${err}`);
            }
          };
          canvas.addEventListener(type, listener);
          unsubs.push(() => canvas.removeEventListener(type, listener));
        };
        on("pointerdown", (e) => router!.handlePointerDown(e.clientX ?? 0, e.clientY ?? 0, e.button ?? 0, modifierBits(e)));
        on("pointermove", (e) => router!.handlePointerMove(e.clientX ?? 0, e.clientY ?? 0, e.button ?? 0, modifierBits(e)));
        on("pointerup", (e) => router!.handlePointerUp(e.clientX ?? 0, e.clientY ?? 0, e.button ?? 0, modifierBits(e)));
        on("wheel", (e) => router!.handleWheel(e.clientX ?? 0, e.clientY ?? 0, e.deltaX ?? 0, e.deltaY ?? 0, modifierBits(e)));
      })();

      init.catch((err) => {
        log.error(moduleName, `init failed: ${err}`);
      });

      // Composite the UI texture in GameRenderer's end-of-frame UI pass.
      const compositor = {
        hasContent: () => scene !== null && host !== null && host.getUiTextureView() !== null,
        render: (pass: GPURenderPassEncoder) => {
          const view = host?.getUiTextureView();
          if (host && view) host.blitPass.renderInto(pass, view);
        },
      };
      const unregCompositor = ctx.registerUiCompositor?.(compositor);
      if (unregCompositor) unsubs.push(unregCompositor);

      // Per-frame: hand the scene the latest stats + drained events, then
      // render the UI texture (ordered before the frame's submit, so the UI
      // pass samples the fresh texture).
      unsubs.push(ctx.onFrame("afterViewports", (dt, elapsedTime) => {
        if (!scene || !host) return;
        const events = eventQueue.splice(0, eventQueue.length);
        try {
          scene.update({ stats: pendingStats, events, dt, elapsedTime });
        } catch (err) {
          log.error(moduleName, `scene.update error: ${err}`);
        }
        host.render();
      }));

      unsubs.push(ctx.onResize((w2, h2) => {
        const iw = Math.round(w2);
        const ih = Math.round(h2);
        if (iw <= 0 || ih <= 0) return;
        try { host?.resize(iw, ih); } catch { /* optional */ }
        try { router?.resize(iw, ih); } catch { /* optional */ }
        try { scene?.resize?.(iw, ih); } catch (err) {
          log.error(moduleName, `scene.resize error: ${err}`);
        }
      }));

      ctx.onDispose(() => {
        unsubs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
        unsubs.length = 0;
        mod.dispose();
      });

      ctx.provide(NativePixiUiSceneTok, mod);
    },
  };

  return mod;
}
