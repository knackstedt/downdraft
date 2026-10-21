import { GameRenderer } from "@downdraft/engine";
import type { GameModule } from "@downdraft/engine/app/main";
import type { RendererModule } from "@downdraft/engine/module/renderer-module";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { createGameMcp } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "./app/store";
import { mountShell } from "./ui/shell";
import { mountMcpTools } from "./mcp/tools";
import { TextAtlas } from "./text/atlas";
import { RunCache } from "./text/run-cache";
import { loadFaces } from "./text/fonts";
import { PanelHost } from "./ui/host";
import { setHtmlUi } from "./ui/panels";
import { registerAllPanels, setSurfaceCtx } from "./ui/register";
import { startTargetRuntime, stopTargetRuntime, sessions } from "./targets/runtime";
import { installHotkeys } from "./ui/hotkeys";
import { installDockDrag } from "./ui/drawer";

const log = createLogger();

let rejectionGuardInstalled = false;
/** The engine's native-error-handlers treat unhandledRejection as fatal
 *  (crash report + dialog + exit). A devtools host watches flaky targets —
 *  routine async channel failures shouldn't kill the viewer. Swap exit for a
 *  loud log; synchronous uncaughtException keeps engine fatal semantics.
 *  Installed from the ui hook so it lands after the engine registers its own
 *  handlers, and re-asserted on each dev session restart. */
function installRejectionGuard(): void {
  if (rejectionGuardInstalled) return;
  rejectionGuardInstalled = true;
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log.error("app", `unhandled rejection (non-fatal): ${detail}`);
  });
}

// ============================================================================
// platinum-devtools — renderer-only GameModule.
//
// A devtools viewer has no sim worker: sessions/discovery/channels live on
// the renderer thread. 2D mode, zero viewports — the frame is painted by
// ScreenUiCompositors (GPU surfaces + floating frames) and html-ui docs.
// ============================================================================

const BG = { r: 0x14 / 255, g: 0x16 / 255, b: 0x19 / 255, a: 1 };

export const gameModule: GameModule = {
  // We are the devtools — don't run an in-app devtools dock.
  devtools: { ui: "none" },

  renderer: (surface) =>
    new GameRenderer(surface, {
      mode: "2d",
      clearColor: BG,
      enableTelemetry: true,
    }),

  ui: (ctx) => {
    installRejectionGuard();
    const renderer = ctx.renderer as GameRenderer;
    renderer.setViewportCount(0);
    registerAllPanels();

    const mod = createHtmlUi({
      name: "platinum-shell",
      nav: false,
      build(ui) {
        setHtmlUi(ui);
        (globalThis as Record<string, unknown>).__platinumUi = ui;
        mountShell(ui, ctx);
      },
    });
    renderer.useRendererModule(mod);

    const surfacesModule: RendererModule = {
      name: "platinum-surfaces",
      version: "0.1.0",
      register(mctx) {
        (globalThis as Record<string, unknown>).__platinumBus = mctx.getInputBus();
        (globalThis as Record<string, unknown>).__platinumStore = store;
        const atlas = new TextAtlas(mctx.getDevice(), 2048);
        const cache = new RunCache(atlas);
        setSurfaceCtx({ mctx, cache });
        const host = new PanelHost(mctx, cache);
        (globalThis as Record<string, unknown>).__platinumHost = host;
        void cache.init().then(async () => {
          const defs = await loadFaces();
          defs.forEach((d) => cache.registerFace(d));
        }).catch((e) => log.warn("text", `font init failed: ${e}`));
        mctx.onFrame("afterFrame", (dt) => host.tick(dt));
        const unhotkey = installHotkeys(mctx);
        const undockdrag = installDockDrag(mctx.getInputBus());
        mctx.onDispose(() => {
          unhotkey();
          undockdrag();
          host.dispose();
          cache.dispose();
          atlas.destroy();
          setSurfaceCtx(null as never);
        });
      },
    };
    renderer.useRendererModule(surfacesModule);

    void startTargetRuntime().then(() => {
      log.info("app", "target runtime started");
    });

    return {
      start() {
        log.info("app", "ui started");
      },
      dispose() {
        stopTargetRuntime();
        store.setState({ running: false });
      },
    };
  },

  mcp: (ctx) => {
    const renderer = ctx.renderer as GameRenderer;
    createGameMcp({
      appId: "downdraft-platinum-devtools",
      surface: ctx.surface,
      isRunning: () => renderer.isRunning?.() ?? true,
      renderOnce: () => renderer.renderOnce?.(),
      pauseRendering: () => renderer.stop(),
      resumeRendering: () => renderer.start(),
      getWorldState: () => store.getState().worldState?.() ?? null,
      getUiState: () => store.getState().uiState?.() ?? null,
      setTestState: (params) => store.getState().setTestState?.(params),
      conditionVars: {
        app: () => store.getState(),
      },
      tools: mountMcpTools(ctx),
    });
  },

  onReady: () => {
    log.info("app", "platinum-devtools ready");
    sessions.syncStore();
  },

  onDispose: () => {
    stopTargetRuntime();
  },
};
