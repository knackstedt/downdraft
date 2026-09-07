// ============================================================================
// Andrew's Sandbox — Preload Entry
// ============================================================================
//
// The default bridge (saves, display, osr, mcp, devtools, gpuInfo, console)
// is exposed automatically as window.downdraft. We extend it with an
// onEscPressed channel so the main process can forward ESC keypresses that
// it intercepted via before-input-event (preventing Chromium from exiting
// pointer lock).

import { createDowndraftBridge } from "@downdraft/app/preload";

createDowndraftBridge({
  extend: (api, { ipcRenderer }) => {
    (api as any).onEscPressed = (cb: () => void) => {
      console.log("[preload] Registering __esc_pressed listener");
      ipcRenderer.on("__esc_pressed", () => {
        console.log("[preload] __esc_pressed received — forwarding to renderer");
        cb();
      });
    };
  },
});
