// ============================================================================
// Import Settings Types — re-exported from @downdraft/core
// ============================================================================
// The canonical definitions live in @downdraft/core/assets/import-settings.ts
// so the ImportCache (in core) can store ImportSettings without a cross-package
// dependency. This module re-exports them for plugin-models convenience.
//

export { createDefaultImportSettings, mergeImportSettings } from "@downdraft/core";
export type { ImportSettings, SettingsSource, UnitSystem, UpAxis } from "@downdraft/core";

