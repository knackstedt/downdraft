// ============================================================================
// Model Viewer — Main Process Entry
// ============================================================================
//
// Minimal Electron config — model-viewer is a tool, not a full game.
// No OSR, MCP, or saves needed. Also runs standalone in a browser via
// its own vite.config.ts (port 5180).

import { createDowndraftApp, webGpuSwitches } from "@downdraft/app/main";

createDowndraftApp({
  window: {
    title: "Downdraft Model Viewer",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1a1a2e",
    placement: "center",
  },
  switches: webGpuSwitches(),
  features: {
    devtools: true,
    consoleForwarding: true,
    errorDialog: true,
    // No OSR, MCP, saves, or gpuInfo needed for the model viewer
    osr: false,
    mcp: false,
    saves: false,
    gpuInfo: false,
  },
});
