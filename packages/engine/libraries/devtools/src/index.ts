// ============================================================================
// @downdraft/engine/libraries/devtools — engine devtools backend
//
// The provider/command data model (DevtoolsProviderTarget —
// registerEngineProviders works on any backend) is consumed by the
// @downdraft/devtools frontend — mounted in-window as an overlay (F12) or
// attached remotely over a DevToolsServer mirror.
//
//   EmbeddedDevtoolsHost: the headless in-process backend host bootstrap
//     wires per app (CdpBridge + DevtoolsBackend, no UI of its own).
//
//   DevToolsServer (web/): loopback WS/JSON-RPC server that fronts a
//     DevtoolsBackend for remote viewers; WebDevtoolsMirror is the
//     WS-attached backend subclass it drives.
//
// Panels: Console (CDP Runtime.consoleAPICalled + exceptionThrown + logger
// sink), Scene/DOM trees, GPU info, CDP profiler, per-thread ProfilingSAB
// metrics, and provider-fed snapshot panels (sim, memory, render-graph,
// materials, doctor, workers, input, postfx, assets, app).
// ============================================================================

export { DevtoolsBackend, panelSlot, slotName } from "./backend";
export type { DevtoolsBackendOptions } from "./backend";
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

export { EmbeddedDevtoolsHost } from "./embedded-host";
export type { EmbeddedDevtoolsHostOptions } from "./embedded-host";

// ── Remote devtools transport (WS + JSON-RPC) ──
export { WebDevtoolsMirror } from "./web/mirror";
export { DevToolsServer } from "./web/server";

