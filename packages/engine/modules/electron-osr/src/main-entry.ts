// ============================================================================
// Electron OSR Module — Main-process Barrel Exports
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
} from "./types";

export { BillboardMode } from "./types";

export { OSRRendererManager } from "./main/osr-renderer-manager";
export { OSRAtlasRenderer } from "./main/osr-atlas-renderer";
export { OSRDedicatedRenderer } from "./main/osr-dedicated-renderer";
export { InputForwarder } from "./main/input-forwarder";
