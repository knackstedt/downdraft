// ============================================================================
// PixiUiBridge — batteries-included PixiJS overlay wiring for games.
//
// Every pixi-ui game hand-rolled the same ~100-line onReady block:
//   new PixiUiHost({...}) → host.onAction = switch → await host.start()
//   → rAF loop calling host.writeStats({...}) → window mousemove tracker
//   → dispose() in onDispose.
//
// The bridge owns that lifecycle. Games declare it via GameModule.ui:
//
//   startGame({
//     ui: (ctx) => createPixiUiBridge({
//       statsLayout: MY_STATS_LAYOUT,
//       sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href,
//       passThrough: true,
//       trackPointer: true,
//       getStats: () => ({ fps: store.fps, ... }),
//       onAction: (action) => { switch (action.kind) { ... } },
//     }),
//   });
//
// startGame() calls bridge.start() after renderer init (before onReady) and
// bridge.dispose() on hot-reload. Games can also use the bridge manually
// (escape hatch) — construct, start(), dispose().
// ============================================================================

import { getHostCapabilities, getNativeHost } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import type { PixiUiAction, PixiUiEvent, Rect } from "./bridge-protocol";
import { PixiUiHost } from "./host";
import type { PixiUiLibConfig } from "./library";

const log = createLogger("info");

export interface PixiUiBridgeConfig extends PixiUiLibConfig {
  /**
   * Per-frame stats provider. Called once per animation frame after start();
   * the returned record is written to the UiStatsSAB. Return null to skip a
   * frame (e.g. renderer not ready yet).
   */
  getStats?: () => Record<string, number> | null;

  /**
   * Worker→main action router (button clicks, slider changes, save/load).
   * Equivalent to assigning `host.onAction`.
   */
  onAction?: (action: PixiUiAction) => void;

  /** Worker→main interactive-mode changes (modal UI toggling pointer events). */
  onInteractiveChange?: (interactive: boolean) => void;

  /** Worker→main opaque-panel region reports (renderer can skip draws under them). */
  onOpaqueChange?: (regions: Rect[]) => void;

  /**
   * Track the OS pointer over the game canvas and merge
   * `{ mouseX, mouseY, mouseValid }` into every stats write — the standard
   * triplet scenes use to draw a brush/cursor indicator. Coordinates are in
   * canvas pixels relative to the layer-0 canvas (or `trackPointer.canvas`).
   * `mouseValid` is 1 while the pointer is over the canvas, 0 otherwise.
   *
   * Pass `true` to track the layer-0 canvas, or an options object to target
   * a specific element. Default: false.
   */
  trackPointer?: boolean | { canvas?: HTMLCanvasElement | (() => HTMLCanvasElement | null) };

  /** Called when host.start() rejects. Default: logs via engine logger. */
  onError?: (err: unknown) => void;
}

export class PixiUiBridge {
  readonly host: PixiUiHost;
  private config: PixiUiBridgeConfig;
  private statsRafId = 0;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private pointerX = 0;
  private pointerY = 0;
  private pointerValid = false;
  private started = false;

  constructor(config: PixiUiBridgeConfig) {
    this.config = config;
    this.host = new PixiUiHost(config);
    if (config.onAction) this.host.onAction = config.onAction;
    if (config.onInteractiveChange) this.host.onInteractiveChange = config.onInteractiveChange;
    if (config.onOpaqueChange) this.host.onOpaqueChange = config.onOpaqueChange;
  }

  /**
   * Start the overlay: spawn the UI worker, begin the stats rAF loop and
   * pointer tracking. Resolves when the worker reports ready. Start errors
   * are routed to onError (default: engine logger) and re-thrown — callers
   * that want non-fatal UI failures should catch.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (this.config.trackPointer) this.startPointerTracking();

    try {
      await this.host.start();
    } catch (err) {
      (this.config.onError ?? ((e) => log.error("PixiUiBridge", `start failed: ${e}`)))(err);
      throw err;
    }

    if (this.config.getStats) {
      const loop = () => {
        const stats = this.config.getStats!();
        if (stats) {
          this.host.writeStats(
            this.config.trackPointer
              ? { ...stats, mouseX: this.pointerX, mouseY: this.pointerY, mouseValid: this.pointerValid ? 1 : 0 }
              : stats,
          );
        }
        this.statsRafId = requestAnimationFrame(loop);
      };
      this.statsRafId = requestAnimationFrame(loop);
    }
  }

  /** Post a structured event to the worker scene. */
  postEvent(event: PixiUiEvent): void {
    this.host.postEvent(event);
  }

  /** Current tracked pointer position (canvas px) — only when trackPointer is on. */
  getPointer(): { x: number; y: number; valid: boolean } {
    return { x: this.pointerX, y: this.pointerY, valid: this.pointerValid };
  }

  /** Tear down: stop the stats loop + pointer tracking, dispose the host. */
  dispose(): void {
    if (this.statsRafId) {
      cancelAnimationFrame(this.statsRafId);
      this.statsRafId = 0;
    }
    if (this.mouseMoveHandler) {
      window.removeEventListener("mousemove", this.mouseMoveHandler);
      this.mouseMoveHandler = null;
    }
    this.host.dispose();
    this.started = false;
  }

  private startPointerTracking(): void {
    const opt = this.config.trackPointer;
    const resolveCanvas = typeof opt === "object" && opt.canvas
      ? typeof opt.canvas === "function" ? opt.canvas : () => opt.canvas as HTMLCanvasElement
      : () => (getHostCapabilities().hasDom
          ? document.querySelector('canvas[data-dd-layer="0"]') as HTMLCanvasElement | null
          : (getNativeHost()?.surface as HTMLCanvasElement | undefined) ?? null);

    this.mouseMoveHandler = (e: MouseEvent) => {
      const canvas = resolveCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        this.pointerX = e.clientX - rect.left;
        this.pointerY = e.clientY - rect.top;
        this.pointerValid = true;
      } else {
        this.pointerValid = false;
      }
    };
    window.addEventListener("mousemove", this.mouseMoveHandler);
  }
}

/** Construct a PixiUiBridge. Satisfies the GameModule.ui handle contract
 *  ({ start(), dispose() }) so it can be returned directly from `ui: (ctx) => ...`. */
export function createPixiUiBridge(config: PixiUiBridgeConfig): PixiUiBridge {
  return new PixiUiBridge(config);
}
