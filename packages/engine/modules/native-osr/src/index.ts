// ============================================================================
// Native OSR Module — Blitz-backed offscreen HTML/CSS panels
// ============================================================================
// Renderer-side machinery for the native (Bun/SDL/wgpu) runtime. The host
// side lives in `@downdraft/platform-native` (NativeOsrHost owns one Blitz
// document per renderer/panel behind the `downdraft.osr` bridge); this module
// owns the GPU texture sink, world-space compositing pass, and input router.

export type {
    AtlasLayout, AtlasPanelRect, OSRDataUpdate, OSRHostBridge, OSRInputEvent, OSRPanelConfig, OSRPixelFormat, OSRRendererConfig, OSRRendererEvent, OSRRendererMode, OSRRendererStatus, OSRTextureHandle, WorldSpaceUIElement
} from "./types";

export { BillboardMode } from "./types";
export type { BillboardMode as BillboardModeType } from "./types";

export { OSRInputRouter } from "./input-router";
export type { InputRouterConfig, MouseState } from "./input-router";
export { NativeOSRManager } from "./native-osr-manager";
export { NativeOsrTextureSource } from "./native-texture-source";
export { WorldSpaceUIPass } from "./world-space-ui-pass";
export type { CameraState } from "./world-space-ui-pass";

