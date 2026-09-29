// DORMANT — Electron-only path. See DORMANT.md in this directory.
// ============================================================================
// Electron OSR Module — Shared Types
// ============================================================================
// The runtime-agnostic OSR types now live in `modules/native-osr` (the Blitz
// backend owns them during the migration bake). This shim keeps dormant
// Electron code compiling until Track E2 deletes the module.

import type { OSRRendererConfig as NativeOSRRendererConfig } from "@downdraft/engine/modules/native-osr/types";
export * from "@downdraft/engine/modules/native-osr/types";

// ── Electron-only members (shared-texture path) ─────────────────────────────
// The live native-osr contract dropped these in Phase 3; the dormant Electron
// renderers still reference them, so they live here until deletion.

export type OSRSharedTexturePixelFormat = "rgba" | "bgra";

/** Electron renderer config — adds the shared-texture members the dormant
 *  path used. Local declaration wins over the `export *` re-export. */
export interface OSRRendererConfig extends NativeOSRRendererConfig {
  /** Pixel format of the shared texture. Default 'rgba'. */
  sharedTexturePixelFormat?: OSRSharedTexturePixelFormat;
  /** Enable GPU zero-copy shared texture path. Default true. Set false to force CPU path. */
  useSharedTexture?: boolean;
}
