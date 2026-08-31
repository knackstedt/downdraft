// ============================================================================
// @downdraft/library-pixi-ui — public API
//
// A worker-hosted PixiJS UI overlay. The library spawns a Web Worker that
// renders a GUI onto an OffscreenCanvas (via transferControlToOffscreen)
// stacked above the main game canvas. Games feed per-frame scalars via a
// SharedArrayBuffer and event-driven data via postMessage.
//
// Usage (declarative — via GameModule.libraries[]):
//
//   import { PixiUiLib } from "@downdraft/library-pixi-ui";
//
//   startGame({
//     libraries: [PixiUiLib],  // or [PixiUiLib, { backend: "webgpu", ... }]
//     // ...
//     onReady: async (ctx) => {
//       const host = ctx.libraryHost!.injectResource(PixiUiHostTok);
//       // Write per-frame stats from the game loop:
//       host.writeStats({ fps: renderer.getFPS(), health: 100, ... });
//       // Post events:
//       host.postEvent({ kind: "setInventory", items: [...] });
//       // Handle worker→game actions:
//       host.onAction = (action) => { if (action.kind === "pause") ... };
//     },
//   });
//
// Escape hatch (manual wiring in onReady):
//
//   import { PixiUiHost } from "@downdraft/library-pixi-ui";
//   const host = new PixiUiHost({ backend: "webgl2", sceneModuleUrl: new URL("./pixi-scene.ts", import.meta.url).href });
//   await host.start();
// ============================================================================

// Engine library descriptor + DI token
export { PixiUiHostTok, PixiUiLib } from "./library";
export type { PixiUiLibConfig, UiStatsLayout } from "./library";

// Main-thread host
export { PixiUiHost } from "./host";
export type { PixiUiHostOptions } from "./host";

// UiStatsSAB helpers (for direct reads by MCP tools / debug)
export {
    allocateUiStatsSab,
    buildSlotMap, HEADER_BYTES,
    MAGIC, readFrameCounter,
    readUiStat,
    readUiStats,
    validateUiStatsSab, VERSION, writeUiStats
} from "./ui-stats-sab";

// Bridge protocol types (for game event/action definitions)
export {
    DEFAULT_STATS_LAYOUT,
    isInitMessage,
    serializeConfig
} from "./bridge-protocol";
export type {
    CaptureResultMessage,
    InitMessage,
    InteractiveRegionsMessage,
    MainToWorkerMessage,
    PixiUiAction,
    PixiUiEvent,
    PointerMessage,
    PointerMissedMessage,
    ReadyMessage,
    Rect,
    SceneNodeSummary,
    SceneStateMessage,
    SceneStateSummary,
    SerializedPixiUiConfig,
    SetInteractiveMessage,
    WorkerToMainMessage
} from "./bridge-protocol";

// Scene interface (games implement PixiUiScene)
export type {
    PixiUiScene,
    PixiUiSceneContext,
    PixiUiSceneFactory,
    PixiUiUpdateData
} from "./scene";

// MCP automation tools
export { createPixiUiMcpTools } from "./mcp-tools";
