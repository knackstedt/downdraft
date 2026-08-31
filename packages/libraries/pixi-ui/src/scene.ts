// ============================================================================
// PixiUiScene — the interface a game's UI scene implements. The worker
// calls the scene factory (received via config) to build the scene graph,
// then calls `update()` each frame with the latest UiStatsSAB values +
// drained events.
//
// Games provide a scene factory as a module export. The worker dynamically
// imports the module URL passed in the init config:
//
//   // games/my-game/src/pixi-scene.ts
//   import { Container, Text } from "pixi.js";
//   import type { PixiUiScene, PixiUiSceneContext } from "@downdraft/library-pixi-ui";
//
//   export default function createHudScene(ctx: PixiUiSceneContext): PixiUiScene {
//     const root = new Container();
//     const healthText = new Text({ text: "HP 100" });
//     root.addChild(healthText);
//     ctx.app.stage.addChild(root);
//
//     return {
//       root,
//       update({ stats, events }) {
//         if (stats.health !== undefined) {
//           healthText.text = `HP ${Math.floor(stats.health)}`;
//         }
//         for (const e of events) {
//           if (e.kind === "notification") { /* ... */ }
//         }
//       },
//       dispose() { root.destroy({ children: true }); },
//     };
//   }
//
// The scene module URL is passed to PixiUiLibConfig.sceneModuleUrl and
// forwarded to the worker in the init message.
// ============================================================================

import type { Application, Container } from "pixi.js";
import type { PixiUiAction, PixiUiEvent, Rect, SceneNodeSummary, StatsValues } from "./bridge-protocol";

/** Context passed to a scene factory. */
export interface PixiUiSceneContext {
  /** The PIXI.Application the worker created on the OffscreenCanvas. */
  app: Application;
  /** The canvas width/height in pixels (for layout). */
  width: number;
  height: number;
  /** The opaque scene config from PixiUiLibConfig.sceneConfig. */
  sceneConfig: unknown;
  /** Signal that the scene wants pointer events (flips the overlay canvas to
   *  pointer-events: auto on the main thread). Call with false to revert. */
  setInteractive(interactive: boolean): void;
  /** Post a game action back to the main thread (forwarded to host.onAction). */
  postAction(action: PixiUiAction): void;
  /** Post a debug log to the main thread console. */
  log(level: "info" | "warn" | "error", msg: string): void;
}

/** Per-frame update data passed to PixiUiScene.update(). */
export interface PixiUiUpdateData {
  /** Per-frame scalars read from the UiStatsSAB. */
  stats: StatsValues;
  /** Events drained from the postMessage queue since the last frame. */
  events: PixiUiEvent[];
  /** Elapsed seconds since the last update. */
  dt: number;
  /** Total elapsed seconds since the scene was created. */
  elapsedTime: number;
}

/** A game's UI scene. Built by a factory, updated each frame, disposed on shutdown. */
export interface PixiUiScene {
  /** The root container added to the app stage. */
  root: Container;
  /** Called each frame with the latest stats + drained events. */
  update(data: PixiUiUpdateData): void;
  /** Called on resize — update layout for the new canvas dimensions. */
  resize?(width: number, height: number): void;
  /**
   * Report the bounding boxes of interactive UI elements (buttons, sliders,
   * scrollable lists) in canvas pixel coordinates. The host uses these for
   * pass-through hit-testing: pointer events inside a region are forwarded
   * to the worker for PixiJS eventMode hit-testing; events outside all
   * regions are dispatched on the game canvas so the game keeps its input.
   *
   * Called after each `update()` and after `resize()`. Return `[]` when no
   * interactive elements are visible (e.g. display-only HUD). The host
   * caches the latest result.
   */
  getInteractiveRegions?(): Rect[];
  /** Produce a scene-graph summary for MCP queryScene. Default: walk `root`. */
  summarize?(): SceneNodeSummary[];
  /** Called on dispose — destroy display objects, release resources. */
  dispose(): void;
}

/** A factory function exported from the game's scene module. */
export type PixiUiSceneFactory = (ctx: PixiUiSceneContext) => PixiUiScene | Promise<PixiUiScene>;

/**
 * Default no-op scene used when no sceneModuleUrl is configured. The worker
 * entry replaces this with a real "PixiUI ready" label using PIXI directly
 * (this file is type-checked in both main + worker contexts, so it can't
 * import pixi.js at the top level).
 */
export function createDefaultScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = ctx.app.stage;
  return {
    root,
    update() {},
    dispose() {},
  };
}
