// ============================================================================
// Electron OSR Plugin — Main-process Barrel Exports
// ============================================================================
// These exports use Node.js APIs (electron, child_process, path, etc.) and
// must only be imported from the Electron main process, never the renderer.

export type {
  OSRRendererMode,
  OSRSharedTexturePixelFormat,
  OSRRendererConfig,
  OSRPanelConfig,
  OSRDataUpdate,
  WorldSpaceUIElement,
  AtlasPanelRect,
  AtlasLayout,
  OSRRendererStatus,
  OSRRendererEvent,
  OSRInputEvent,
  OSRTextureHandle,
  OSRIPC,
} from "./types.ts";

export { BillboardMode } from "./types.ts";

export { OSRRendererManager } from "./main/osr-renderer-manager.ts";
export { OSRAtlasRenderer } from "./main/osr-atlas-renderer.ts";
export { OSRDedicatedRenderer } from "./main/osr-dedicated-renderer.ts";
export { InputForwarder } from "./main/input-forwarder.ts";
