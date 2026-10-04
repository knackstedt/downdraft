// ============================================================================
// @downdraft/engine/libraries/devtools — engine devtools bridge
//
// Two frontends consume the same provider/command data model
// (DevtoolsProviderTarget — registerEngineProviders works on both):
//
//   Blitz devtools (in-engine): an html-ui/Blitz document docked in the game
//     window — Chrome-DevTools-style tabs driven by the collectors and
//     provider snapshots below. Lives in @downdraft/engine/modules/devtools
//     (blitz/). Toggled with F12.
//
//   WebDevtoolsHost (web/): development-only loopback server (Bun.serve HTTP
//     + WebSocket JSON-RPC) serving the browser frontend in
//     packages/devtools-web. Opens in a desktop browser window.
//
// Panels: Console (CDP Runtime.consoleAPICalled + exceptionThrown + logger
// sink), Scene/DOM trees, GPU info, CDP profiler, per-thread ProfilingSAB
// metrics, and provider-fed snapshot panels (sim, memory, render-graph,
// materials, doctor, workers, input, postfx, assets, game).
// ============================================================================

export { CdpBridge } from "./cdp-bridge";
export type { CdpConsoleEntry, CdpException, CdpProfile } from "./cdp-bridge";
export {
    collectDomTree,
    collectGpuInfo,
    collectMetrics,
    collectProfile,
    collectSceneTree,
    collectThreads
} from "./collectors";
export type { CollectorContext, GpuInfoJson, MetricsSlot, ProfileJson, ThreadInfo, TreeRow } from "./collectors";
export { registerEngineProviders } from "./native-providers";
export type { DevtoolsProviderTarget, EngineProviderContext } from "./native-providers";
export { PANEL, SNAP_FLAG, SNAP_STATUS } from "./snapshot";
export type {
    DevtoolsCommand,
    PanelCommandHandler,
    PanelName,
    PanelProvider,
    PanelSnapshot,
    SnapshotControl,
    SnapshotKvRow,
    SnapshotLine,
    SnapshotSection,
    SnapshotSeries
} from "./snapshot";
export { checkpoint, notify, verifyPixel } from "./verify";

// ── Web devtools (browser UI over WS + JSON-RPC) ──
export { openDevToolsUrl } from "./web/browser";
export { WebDebuggerSceneShim, WebDevtoolsHost } from "./web/host";
export type { WebDevtoolsOptions } from "./web/host";
export { WebDevtoolsMirror } from "./web/mirror";
export { DevToolsServer } from "./web/server";

