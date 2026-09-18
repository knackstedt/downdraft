// ============================================================================
// @downdraft/library-pixi-ui-native — in-process PixiJS UI for native mode.
//
// Runs PixiJS v8's WebGPU backend on the game's shared wgpu-native device and
// renders the UI into a GPUTexture the game composites via a blit pass. No
// Chromium, no Web Worker, no OffscreenCanvas. Browser pixi-ui is untouched.
// ============================================================================

export { NativePixiUiHost, type NativePixiUiHostOptions } from "./host";
export { UiBlitPass } from "./ui-blit-pass";
