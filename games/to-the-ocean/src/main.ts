// ============================================================================
// To The Ocean — Main Process Entry
// ============================================================================
//
// The game bootstraps itself by calling createDowndraftApp() with its config.
// The engine handles all Electron machinery (window, switches, IPC, OSR, MCP)
// driven by this config. Raw Electron access is available via the extend hook.

import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-to-the-ocean",
  window: {
    title: "To The Ocean",
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#001a33",
    placement: "remember",
    stateFile: "window-state.json",
  },
  features: {
    osr: true,
    saves: { engineVersion: "0.1.0", mode: "auto", maxGenerations: 3 },
  },
});
