// ============================================================================
// Electron OSR Module — Renderer-side Barrel Exports
// ============================================================================
// NOTE: Main-process exports are in ./main.ts to avoid pulling Node.js APIs
// (child_process, path, __dirname) into the renderer bundle.

export type {
    AtlasLayout, AtlasPanelRect, OSRDataUpdate, OSRInputEvent, OSRIPC, OSRPanelConfig, OSRRendererConfig, OSRRendererEvent, OSRRendererMode, OSRRendererStatus, OSRSharedTexturePixelFormat, OSRTextureHandle, WorldSpaceUIElement
} from "./types";

export { BillboardMode } from "./types";
export type { BillboardMode as BillboardModeType } from "./types";

export { OSRInputRouter } from "./renderer/input-router";
export { OSRManager } from "./renderer/osr-manager";
export { ElectronOSRModule } from "./renderer/osr-module";
export type { ElectronOSRModuleOptions } from "./renderer/osr-module";
export { OSRSABRingBuffer } from "./renderer/osr-sab-buffer";
export type { OSRSABRegion } from "./renderer/osr-sab-buffer";
export { OSRTextureReceiver } from "./renderer/texture-receiver";
export { OSRTextureReceiverManager } from "./renderer/texture-receiver-manager";
export { WorldSpaceUIPass } from "./renderer/world-space-ui-pass";
export type { CameraState } from "./renderer/world-space-ui-pass";

