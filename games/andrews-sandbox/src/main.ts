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
});
