// ============================================================================
// Model Viewer — Main Process Entry
// ============================================================================
//
// Minimal Electron config — model-viewer is a tool, not a full game.
// No OSR, MCP, or saves needed. Also runs standalone in a browser via
// its own vite.config.ts (port 5180).

import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-model-viewer",
  window: {
    title: "Downdraft Model Viewer",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#1a1a2e",
    placement: "center",
  },
  features: {
    // No OSR, MCP, or saves needed for the model viewer.
    // gpuInfo stays enabled: the devtools BaseSceneInspector polls
    // gpu-system-info / electron-gpu-info / vulkan-validation-status every
    // 2s — disabling it makes Electron log "No handler registered" errors.
    osr: false,
    mcp: false,
    saves: false,
  },
});
