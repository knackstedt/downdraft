// DORMANT — Electron/browser entry point; the example runs native-only now.
// ============================================================================
// Plugin Tester — Main Process Entry
// ============================================================================
//
// The game bootstraps itself by calling createDowndraftApp() with its config.
// The screenshot hack (previously embedded in the engine's main process) is
// now a deliberate game-specific extension via the extend hook.

import { createDowndraftApp, webGpuSwitches } from "@downdraft/engine/app/main";
import { createLogger } from "@downdraft/engine/util/logger";
import { writeFileSync } from "node:fs";

const log = createLogger("info");

createDowndraftApp({
  appId: "downdraft-plugin-tester",
  window: {
    title: "Downdraft Plugin Tester",
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "center",
  },
  switches: webGpuSwitches(),
  features: {
    devtools: true,
    gpuInfo: true,
    consoleForwarding: true,
    errorDialog: true,
    // No OSR, MCP, or saves needed for the plugin tester
  },
  extend: (ctx) => {
    // Auto-capture screenshot after 5s for verification
    // (previously hardcoded in the engine's main process)
    if (ctx.window) {
      ctx.window.once("ready-to-show", () => {
        setTimeout(async () => {
          if (!ctx.window || ctx.window.isDestroyed()) return;
          try {
            const img = await ctx.window.webContents.capturePage();
            const outPath = "/tmp/plugin-tester-electron.png";
            writeFileSync(outPath, img.toPNG());
            log.info("screenshot", `Saved to ${outPath}`);
          } catch (e) {
            log.error("screenshot", `Failed: ${(e as Error).message}`);
          }
        }, 5000);
      });
    }
  },
});
