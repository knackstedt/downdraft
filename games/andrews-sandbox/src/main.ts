// ============================================================================
// Andrew's Sandbox — Main Process Entry
// ============================================================================

import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-andrews-sandbox",
  window: {
    title: "Andrew's Sandbox",
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#1a1a2e",
    placement: "remember",
    stateFile: "window-state.json",
  },
  features: {
    osr: true,
    saves: { engineVersion: "0.1.0", mode: "auto", maxGenerations: 3 },
  },
  // Intercept ESC at the OS level before Chromium processes it. Chromium's
  // pointer-lock-exit-on-ESC happens before the JS keydown handler, which
  // means the renderer never sees ESC while pointer lock is active. By
  // intercepting here, we prevent the pointer-lock exit and notify the
  // renderer via IPC so the ESC menu can toggle normally.
  extend: (ctx) => {
    const win = ctx.window;
    const wc = win?.webContents;
    if (!wc) {
      console.error("[main] No webContents — ESC interception disabled");
      return;
    }
    console.log("[main] ESC interception enabled via before-input-event");
    wc.on("before-input-event", (event, input) => {
      if (input.key === "Escape" && input.type === "keyDown") {
        console.log("[main] ESC intercepted — preventing default, sending IPC");
        event.preventDefault();
        wc.send("__esc_pressed");
      }
    });
  },
});
