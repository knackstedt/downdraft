// ============================================================================
// Native OSR Module — Blitz-backed offscreen HTML/CSS panels
// ============================================================================
// Renderer-side machinery for the native (Bun/SDL/wgpu) runtime. The host
// side lives in `@downdraft/platform-native` (NativeOsrHost owns one Blitz
// document per renderer/panel behind the `downdraft.osr` bridge); this module
// owns the GPU texture sink, world-space compositing pass, and input router.
//
// The shared types/pass/router were extracted from `modules/electron-osr`
// (dormant) — that module re-exports them until Track E2 deletes it.

export type {
    AtlasLayout, AtlasPanelRect, OSRDataUpdate, OSRInputEvent, OSRIPC, OSRPanelConfig, OSRRendererConfig, OSRRendererEvent, OSRRendererMode, OSRRendererStatus, OSRSharedTexturePixelFormat, OSRTextureHandle, WorldSpaceUIElement
} from "./types";

export { BillboardMode } from "./types";
export type { BillboardMode as BillboardModeType } from "./types";

export { OSRInputRouter } from "./input-router";
export type { InputRouterConfig, MouseState } from "./input-router";
export { WorldSpaceUIPass } from "./world-space-ui-pass";
export type { CameraState } from "./world-space-ui-pass";
export { NativeOsrTextureSource } from "./native-texture-source";
export { NativeOSRManager } from "./native-osr-manager";
