// ============================================================================
// @downdraft/app — root re-exports for the host SDK
// ============================================================================
//
// This barrel re-exports the high-level config surface. For process-specific
// entry points, import from the subpath exports:
//   - @downdraft/app/main     — main process (createDowndraftApp, webGpuSwitches)
//   - @downdraft/app/preload  — preload (createDowndraftBridge)
//   - @downdraft/app/renderer — renderer (typed downdraft accessor)
//   - @downdraft/app/shared   — IPC constants (all processes)
//   - @downdraft/app/vite     — vite config factory (build-time only)

export type {
  DowndraftAppConfig,
  DowndraftWindowConfig,
  DowndraftFeatures,
  DowndraftSavesConfig,
  DowndraftMcpConfig,
  DowndraftLifecycle,
  MainContext,
  WindowPlacement,
} from "./main/types";

export type { DowndraftBridgeConfig } from "./preload/bridge";
export type { DowndraftBridge, DowndraftOsrBridge } from "./renderer/index";
export type { DowndraftViteConfigOptions } from "./vite/index";
