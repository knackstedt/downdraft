// ============================================================================
// @downdraft/engine/app — root re-exports for the host SDK
// ============================================================================
//
// This barrel re-exports the high-level config surface. Entry points:
//   - @downdraft/engine/app/renderer — the typed `downdraft` HostAPI accessor
//     + game bootstrap (live; runtime-agnostic)
//   - @downdraft/engine/app/shared   — host contract types (HostAPI)

export type { Host, HostOsr } from "./renderer/index";
