// DORMANT — Electron/browser entry point; the example runs native-only now.
// ============================================================================
// PixiUI Demo — Renderer Entry Point (Electron / browser)
//
// Demonstrates the @downdraft/engine/libraries/pixi-ui engine library: a PixiJS UI
// overlay rendered inside a Web Worker on an OffscreenCanvas, stacked above
// a trivial game canvas. The game feeds per-frame scalars (health, fps) via
// a SharedArrayBuffer and events via postMessage. MCP tools verify the
// overlay renders and is interactive.
//
// The GameModule lives in ./game-module.ts and is shared with
// ./native-entry.ts (Bun + SDL + wgpu-native). This file is the Electron /
// browser bootstrap only.
// ============================================================================

import { startGame } from "@downdraft/engine/app/renderer";
import "@downdraft/engine/app/renderer/downdraft-base.css";
import { pixiUiDemoModule } from "./game-module";

startGame(pixiUiDemoModule);
