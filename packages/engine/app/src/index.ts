// ============================================================================
// @downdraft/engine/app — root re-exports for the host SDK
// ============================================================================
//
// This barrel re-exports the high-level config surface. Entry points:
//   - @downdraft/engine/app/renderer — the typed `downdraft` HostAPI accessor
//     + game bootstrap (live; runtime-agnostic)
//   - @downdraft/engine/app/shared   — host contract types (HostAPI)
//   - @downdraft/engine/app/main|preload|vite — DORMANT Electron paths, kept
//     exportable until the dormant-tree deletion

// DORMANT (Electron): main/preload config types — retained for the dormant
// trees' typecheck until Phase 7 deletes them.
export type {
    DowndraftAppConfig, DowndraftFeatures, DowndraftLifecycle, DowndraftMcpConfig, DowndraftSavesConfig, DowndraftWindowConfig, MainContext,
    WindowPlacement
} from "./main/types";

export type { DowndraftBridgeConfig } from "./preload/bridge";
export type { Host, HostOsr } from "./renderer/index";
export type { DowndraftViteConfigOptions } from "./vite/index";

