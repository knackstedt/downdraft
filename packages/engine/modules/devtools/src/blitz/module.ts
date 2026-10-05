// ============================================================================
// blitz/module.ts — createDevtoolsUiModule: the docked Blitz devtools as a
// RendererModule.
//
//   renderer.useRendererModule(createDevtoolsUiModule({ renderer, profilingSAB }));
//
// Mounts a Chrome-DevTools-style dock inside the game window on its own
// dedicated HtmlUiHost — the dock doc lives in its own ui worker, so a
// runaway game doc can never starve devtools raster (or vice versa).
// `shareGameUi: true` opts back into mounting on the game's HtmlUiTok.
// F12 toggles the dock.
// ============================================================================

import { resourceToken, type RendererModule, type RendererModuleContext } from "@downdraft/engine";
import { HtmlUiTok } from "@downdraft/engine/modules/html-ui";

import { BlitzDevtoolsHost, createSelfHostedDevtoolsUi } from "./host";

export const BlitzDevtoolsTok = resourceToken<BlitzDevtoolsHost>("blitzDevtools");

export interface DevtoolsUiModuleConfig {
  /** The game renderer — feeds GPU/scene/metrics collectors. */
  renderer?: unknown;
  /** Optional scene-graph host — feeds the scene tree panel. */
  gameScene?: unknown;
  /** Optional ProfilingSAB for per-worker performance metrics. */
  profilingSAB?: SharedArrayBuffer | null;
  /** Dock height as a fraction of the surface (default 0.42). */
  dockFraction?: number;
  /** Open the dock on start. Default false. */
  autoShow?: boolean;
  /** Toggle key (default "F12"). Set to null to disable the hotkey. */
  toggleKey?: string | null;
  /**
   * Mount the dock on the game's HtmlUiTok when one is provided — the dock
   * doc then shares the game UI's single ui worker (one HtmlUiHost = one
   * worker for all its docs). Default false: devtools always self-hosts so
   * it gets its own worker — a long game-doc raster can never starve the
   * dock, and the dock's 15fps repaints never queue behind game UI work.
   * Sharing remains useful only where the extra worker's memory matters.
   */
  shareGameUi?: boolean;
  /** Called with the live host inside register() — use it to wire
   *  registerEngineProviders / registerThreadEval / game providers. */
  onHost?: (host: BlitzDevtoolsHost) => void;
}

export function createDevtoolsUiModule(config: DevtoolsUiModuleConfig = {}): RendererModule {
  return {
    name: "devtools-ui",
    version: "0.1.0",
    provides: [BlitzDevtoolsTok],

    register(ctx: RendererModuleContext) {
      // Default: dedicated self-hosted host → guaranteed own ui worker.
      // Sharing the game's host is opt-in — see shareGameUi above.
      const shared = config.shareGameUi ? ctx.injectOptional(HtmlUiTok) : null;
      const ui = shared ?? createSelfHostedDevtoolsUi(ctx);

      const host = new BlitzDevtoolsHost({
        ui,
        renderer: config.renderer,
        gameScene: config.gameScene,
        profilingSAB: config.profilingSAB ?? null,
        surface: ctx.getSurface(),
        dockFraction: config.dockFraction,
        autoShow: config.autoShow,
      });
      host.start();
      ctx.provide(BlitzDevtoolsTok, host);
      (globalThis as Record<string, unknown>).__downdraftDevtools = host;
      config.onHost?.(host);

      const offFrame = ctx.onFrame("afterViewports", () => host.update());
      const offResize = ctx.onResize((w, h) => host.resize(w, h));

      let offKey: (() => void) | null = null;
      const toggleKey = config.toggleKey === undefined ? "F12" : config.toggleKey;
      if (toggleKey) {
        // Ahead of html-ui nav (-20) and host key routing (-10): the devtools
        // hotkey works regardless of which panel has focus.
        offKey = ctx.getInputBus().onKeyDown((e, ctrl) => {
          if (e.key === toggleKey) {
            host.toggle();
            ctrl.stopPropagation();
          }
        }, -30);
      }

      ctx.onDispose(() => {
        offFrame();
        offResize();
        offKey?.();
        host.dispose();
        if ((globalThis as Record<string, unknown>).__downdraftDevtools === host) {
          delete (globalThis as Record<string, unknown>).__downdraftDevtools;
        }
      });
    },
  };
}
