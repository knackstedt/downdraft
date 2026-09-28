// ============================================================================
// @downdraft/engine/libraries/pixi-ui-native — in-process PixiJS UI for native mode.
//
// Runs PixiJS v8's WebGPU backend on the game's shared wgpu-native device and
// renders the UI into a GPUTexture the game composites via a blit pass. No
// Chromium, no Web Worker, no OffscreenCanvas. Browser pixi-ui is untouched.
// ============================================================================

export { NativePixiUiHost, type NativePixiUiHostOptions } from "./host";
export { NativePixiInputRouter, type NativePixiInputRouterOptions } from "./input-router";
export {
    createNativePixiUiScene,
    NativePixiUiSceneTok,
    type NativePixiUiSceneHandle,
    type NativePixiUiSceneOptions
} from "./scene-module";
export { UiBlitPass } from "./ui-blit-pass";

