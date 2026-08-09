// ============================================================================
// To The Ocean — Main Process Entry
// ============================================================================
//
// The game bootstraps itself by calling createDowndraftApp() with its config.
// The engine handles all Electron machinery (window, switches, IPC, OSR, MCP)
// driven by this config. Raw Electron access is available via the extend hook.

import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";

const deterministic = process.env.DOWNDRAFT_DETERMINISTIC === "1";

createDowndraftApp({
  window: {
    title: "To The Ocean",
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#001a33",
    placement: "remember",
    stateFile: "window-state.json",
    webPreferences: {
      webgpu: true,
      sharedTexture: true,
    },
  },
  switches: webGpuSwitches(),
  features: {
    saves: { engineVersion: "0.1.0" },
    osr: true,
    mcp: { port: parseInt(process.env.MCP_PORT ?? "9876", 10) },
    // In deterministic/test mode, don't auto-open devtools (steals focus from canvas)
    devtools: { enabled: true, autoOpen: !deterministic, keybind: deterministic ? "" : "F12" },
    gpuInfo: true,
    consoleForwarding: true,
    errorDialog: !deterministic,
    windowStatePersistence: !deterministic,
  },
});
