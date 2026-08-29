// ============================================================================
// sandjongg — Mobile Entry Point
// ============================================================================
//
// Reuses the shared GameModule from game-module.ts (same renderer, sim, UI,
// and onReady wiring as desktop). Mobile adds touch input; desktop adds
// devtools + MCP + deterministic mode.
//

import { createDowndraftMobileApp } from "@downdraft/app/mobile";
import { sandjonggModule } from "./game-module";

createDowndraftMobileApp({
  appId: "com.downdraft.sandjongg",
  module: sandjonggModule,
  // Sandjongg is a 2D click-based game — tap scheme maps taps to mouse clicks.
  touchInput: { scheme: "tap" },
}).catch((e) => {
  console.error("[mobile] Fatal:", e);
});
