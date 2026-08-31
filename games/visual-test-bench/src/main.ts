// ============================================================================
// Visual Test Bench — Main Process Entry
// ============================================================================
//
// Minimal Electron config — the test bench is a tool, not a full game.
// No OSR, MCP, or saves needed.

import { createDowndraftApp } from "@downdraft/app/main";

createDowndraftApp({
  appId: "downdraft-visual-test-bench",
  window: {
    title: "Downdraft Visual Test Bench",
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0a0a12",
    placement: "center",
  },
  features: {
    osr: false,
    mcp: false,
    saves: false,
  },
});
