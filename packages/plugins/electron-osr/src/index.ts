// ============================================================================
// Electron OSR Plugin — Renderer-side Barrel Exports
// ============================================================================
// NOTE: Main-process exports are in ./main.ts to avoid pulling Node.js APIs
// (child_process, path, __dirname) into the renderer bundle.

export type {
    AtlasLayout, AtlasPanelRect, OSRDataUpdate, OSRIPC, OSRInputEvent, OSRPanelConfig, OSRRendererConfig, OSRRendererEvent, OSRRendererMode, OSRRendererStatus, OSRSharedTexturePixelFormat, OSRTextureHandle, WorldSpaceUIElement
} from "./types.ts";

export { BillboardMode } from "./types.ts";
export type { BillboardMode as BillboardModeType } from "./types.ts";

export { OSRInputRouter } from "./renderer/input-router.ts";
export { OSRManager } from "./renderer/osr-manager.ts";
export { ElectronOSRPlugin } from "./renderer/osr-plugin.ts";
export { OSRTextureReceiverManager } from "./renderer/texture-receiver-manager.ts";
export { OSRTextureReceiver } from "./renderer/texture-receiver.ts";
export { WorldSpaceUIPass } from "./renderer/world-space-ui-pass.ts";
export type { CameraState } from "./renderer/world-space-ui-pass.ts";

