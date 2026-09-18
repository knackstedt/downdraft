// ============================================================================
// @downdraft/engine/app — root re-exports for the host SDK
// ============================================================================
//
// This barrel re-exports the high-level config surface. For process-specific
// entry points, import from the subpath exports:
//   - @downdraft/engine/app/main     — main process (createDowndraftApp, webGpuSwitches)
//   - @downdraft/engine/app/preload  — preload (createDowndraftBridge)
//   - @downdraft/engine/app/renderer — renderer (typed downdraft accessor)
//   - @downdraft/engine/app/shared   — IPC constants (all processes)
//   - @downdraft/engine/app/vite     — vite config factory (build-time only)

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
