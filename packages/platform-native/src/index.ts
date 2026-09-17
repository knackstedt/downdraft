// ============================================================================
// @downdraft/platform-native — Bun-native platform layer
//
// Provides:
//   - GPU binding (wgpu-native via bun:ffi) → installs as navigator.gpu
//   - Native window (SDL2) → implements HTMLCanvasElement interface
//   - Native rAF (vsync-driven) → installs as requestAnimationFrame
//   - Native input (SDL2 events → DOM-compatible events)
//   - Native image/font decoders (replaces createImageBitmap, OffscreenCanvas)
//   - Screenshot capture (swapchain → buffer → PNG)
//
// Usage:
//   import { createNativeHost } from "@downdraft/platform-native";
//   const host = await createNativeHost({ window: { title: "Game", width: 1920, height: 1080 } });
// ============================================================================

export { installAssetGlob, nativeGlob } from "./assets/native-assets";
export { dlopen, ptr, readMappedRange, type CFunction } from "./ffi/ffi-adapter";
export { installGPU, resetGPU } from "./gpu/install";
export { VirtualCanvas, VirtualCanvasContext } from "./gpu/virtual-canvas-context";
export { WgpuAdapter, WgpuBindGroup, WgpuBindGroupLayout, WgpuBuffer, WgpuCommandBuffer, WgpuCommandEncoder, WgpuComputePassEncoder, WgpuComputePipeline, WgpuDevice, WgpuGPU, WgpuPipelineLayout, WgpuQueue, WgpuRenderPassEncoder, WgpuRenderPipeline, WgpuSampler, WgpuShaderModule, WgpuTexture, WgpuTextureView } from "./gpu/wgpu-wrapper";
export { createImageBitmapNative, getFreeTypeTextRenderer, installImagePolyfills, NativeCanvas2D, NativeImageBitmap } from "./image/native-image";
export { startNativeGame, wireFreeTypeText, type NativeGameContext, type NativeGameOptions } from "./native-game";
export { createNativeHost, type NativeHostConfig, type NativeHostContext } from "./native-host";
export { captureScreenshot, encodePNG, paddedReadbackToRGBA } from "./screenshot/screenshot";
export { NativeCanvasContext, NativeSurface } from "./window/native-surface";
export { NativeWindow } from "./window/native-window";

