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
export { createNativeBridge, type NativeBridgeOptions } from "./bridge/native-bridge";
export { createNativeMvBridge, type NativeFsTreeEntry, type NativeMvBridge, type NativeMvBridgeOptions } from "./bridge/native-fs-bridge";
export { resolveNativeUserDataDir } from "./bridge/user-data-dir";
export { VirtualCanvas, VirtualCanvasContext } from "./compat/virtual-canvas-context";
export { dlopen, ptr, readMappedRange, type CFunction } from "./ffi/ffi-adapter";
export { findShimLibrary, libFileName, PLATFORM_DIR, resolveNativeLibrary, resolvePlatformLibrary, resolveShimLibrary, RUST_TRIPLE } from "./ffi/lib-paths";
export { installGPU, resetGPU } from "./gpu/install";
export { validateWgslNative, type WgslValidationResult } from "./gpu/native-wgsl";
export { attachSharedDevice, createDeviceStateCells, importCommandBuffer, markDeviceLost, sharedDeviceAlive, shareDevice, submitCommandPtrs, type DeviceStateCells, type GpuDeviceHandle, type SharedDeviceView, type WorkerCommandRef } from "./gpu/shared-device";
export { WgpuAdapter, WgpuBindGroup, WgpuBindGroupLayout, WgpuBuffer, WgpuCommandBuffer, WgpuCommandEncoder, WgpuComputePassEncoder, WgpuComputePipeline, WgpuDevice, WgpuGPU, WgpuPipelineLayout, WgpuQueue, WgpuRenderPassEncoder, WgpuRenderPipeline, WgpuSampler, WgpuShaderModule, WgpuTexture, WgpuTextureView } from "./gpu/wgpu-wrapper";
export { acquireSingleInstanceLock, addCrashFeatureLog, installNativeErrorHandlers, installWindowStatePersistence, releaseSingleInstanceLock } from "./host-lifecycle";
export { createImageBitmapNative, getFreeTypeTextRenderer, installImagePolyfills, NativeCanvas2D, NativeImageBitmap } from "./image/native-image";
export { createNativeHostTools, startNativeMcpServer, type NativeMcpOptions, type NativeMcpServer } from "./mcp/native-mcp";
export { startNativeGame, wireFreeTypeText, type NativeGameContext, type NativeGameOptions } from "./native-game";
export { runNativeGameModule, type RunNativeGameModuleOptions } from "./native-game-module";
export { createNativeHost, type NativeHostConfig, type NativeHostContext } from "./native-host";
export { installRestartHook, requestGameRestart, type RestartHookOptions } from "./native-restart";
export { captureScreenshot, encodePNG, paddedReadbackToRGBA } from "./screenshot/screenshot";
export { createHostServices, scopeServicesForPlugin, type HostServices, type HostServicesApi, type HostServicesOptions } from "./services/host-services";
export { NativeCanvasContext, NativeSurface } from "./window/native-surface";
export { NativeWindow } from "./window/native-window";

