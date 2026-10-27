import { AppRenderer } from "@downdraft/engine";
import type { AppModule } from "@downdraft/engine/app/main";
import { createAppMcp } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { store } from "./app/store";
import { mountMcpTools } from "./mcp/tools";
import { mountDevtools } from "./mount";
import { sessions } from "./targets/runtime";

const log = createLogger();

// ============================================================================
// devtools — standalone viewer AppModule.
//
// A devtools viewer has no sim worker: sessions/discovery/channels live on
// the renderer thread. 2D mode, zero viewports — the frame is painted by
// ScreenUiCompositors (GPU surfaces + floating frames) and html-ui docs.
// The surface itself is the same mountDevtools() an app can embed.
// ============================================================================

const BG = { r: 0x14 / 255, g: 0x16 / 255, b: 0x19 / 255, a: 1 };

export const appModule: AppModule = {
  // We are the devtools — don't run an in-app devtools dock.
  devtools: { ui: "none" },

  renderer: (surface) =>
    new AppRenderer(surface, {
      mode: "2d",
      clearColor: BG,
      enableTelemetry: true,
    }),

  ui: (ctx) => {
    const renderer = ctx.renderer as AppRenderer;
    renderer.setViewportCount(0);
    const mount = mountDevtools(ctx);
    return {
      start() {
        log.info("app", "ui started");
      },
      dispose() {
        mount.dispose();
        store.setState({ running: false });
      },
    };
  },

  mcp: (ctx) => {
    const renderer = ctx.renderer as AppRenderer;
    createAppMcp({
      appId: "downdraft-devtools",
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
    log.info("app", "devtools ready");
    sessions.syncStore();
  },
};
