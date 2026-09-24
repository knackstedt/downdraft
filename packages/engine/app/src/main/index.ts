// DORMANT — Electron-only path. See DORMANT.md in this directory.
// ============================================================================
// @downdraft/engine/app/main — main process host SDK entry point
// ============================================================================

export type {
    HeapSnapshotResult,
    ProcessSnapshotResult,
    TracePreset,
    TraceStartOptions,
    TraceStartResult,
    TraceStatusResult,
    TraceStopResult
} from "../shared/types";
export { createDowndraftApp } from "./app";
export { installErrorHandlers, setExitOnDialogClose, showErrorDialog } from "./error-dialog";
export { registerDevtoolsHandlers, resolveDevtoolsConfig } from "./handlers/devtools";
export type { ResolvedDevtoolsConfig } from "./handlers/devtools";
export { registerGpuInfoHandlers } from "./handlers/gpu-info";
export { startMcpProxy } from "./handlers/mcp";
export { registerOsrHandlers } from "./handlers/osr";
export { registerSaveHandlers } from "./handlers/saves";
export { createTracingTools, registerTracingHandlers } from "./handlers/tracing";
export { cleanupStaleStorage, resolveUserDataDir } from "./storage";
export { applySwitches, webGpuSwitches } from "./switches";
export type { Switch } from "./switches";
export type {
    DevtoolsConfig, DowndraftAppConfig, DowndraftFeatures, DowndraftLifecycle, DowndraftMcpConfig, DowndraftSavesConfig, DowndraftWindowConfig, MainContext,
    WindowPlacement
} from "./types";
export { createWindow } from "./window";

