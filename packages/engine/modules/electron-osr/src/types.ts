// DORMANT — Electron-only path. See DORMANT.md in this directory.
// ============================================================================
// Electron OSR Module — Shared Types
// ============================================================================
// The runtime-agnostic OSR types now live in `modules/native-osr` (the Blitz
// backend owns them during the migration bake). This shim keeps dormant
// Electron code compiling until Track E2 deletes the module.

export * from "@downdraft/engine/modules/native-osr/types";
