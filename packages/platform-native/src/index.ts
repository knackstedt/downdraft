// ============================================================================
// @downdraft/platform-native — native platform layer (Bun/Node/Deno host)
//
// Provides:
//   - GPU binding (wgpu-native via cross-runtime FFI) → installs as navigator.gpu
//   - Native window (winit) → implements HTMLCanvasElement interface
//   - Native rAF (vsync-driven) → installs as requestAnimationFrame
//   - Native input (native window events → DOM-compatible events)
//   - Native image/font decoders (replaces createImageBitmap, OffscreenCanvas)
//   - Screenshot capture (swapchain → buffer → PNG)
//
// Usage:
//   import { createNativeHost } from "@downdraft/platform-native";
//   const host = await createNativeHost({ window: { title: "App", width: 1920, height: 1080 } });
// ============================================================================

export { installAssetGlob, nativeGlob } from "./assets/native-assets";
export { createNativeBridge, type NativeBridgeOptions } from "./bridge/native-bridge";
export { createNativeMvBridge, type NativeFsTreeEntry, type NativeMvBridge, type NativeMvBridgeOptions } from "./bridge/native-fs-bridge";
export { resolveNativeUserDataDir } from "./bridge/user-data-dir";
export { VirtualCanvas, VirtualCanvasContext } from "./compat/virtual-canvas-context";
export { dlopen, ptr, readMappedRange, type CFunction } from "./ffi/ffi-adapter";
export { findShimLibrary, libFileName, PLATFORM_DIR, resolveNativeLibrary, resolvePlatformLibrary, resolveShimLibrary, RUST_TRIPLE } from "./ffi/lib-paths";
export { acquireAdapterAndDevice, type AcquiredGpu, type AcquireGpuOptions } from "./gpu/adapter-boot";
export { adapterIdentityChanged, CRASH_LATCH_THRESHOLD, denyReasonForAdapter, LATCH_RETRY_BASE_MS, LATCH_RETRY_MAX_MS, planGpuBoot, readGpuState, recordHardwareAttempt, resolveGpuPolicy, type AdapterIdentity, type GpuAdapterMode, type GpuBackend, type GpuBootPlan, type GpuPersistedState, type GpuPolicy, type GpuPolicyInput } from "./gpu/adapter-policy";
export { borrowGpuBuffer, borrowGpuTexture, importGpuBuffer, importGpuTexture, type BorrowedTextureMeta } from "./gpu/borrow";
export { createGpuWorkerContext, type GpuAttachMsg, type GpuDetachedMsg, type GpuDetachMsg, type GpuReadyMsg, type GpuWorkerContext } from "./gpu/gpu-worker-context";
export { installGPU, resetGPU } from "./gpu/install";
export { validateWgslNative, type WgslValidationResult } from "./gpu/native-wgsl";
export { GPU_PASS_PRE_SUBMIT, GPU_PASS_PRE_UI, GpuPassMailbox, postPass, type GpuPassMsg } from "./gpu/pass-channel";
export { isTransferred, markTransferred } from "./gpu/registry";
export { GpuShareBroker, type GpuSharePayload } from "./gpu/share-broker";
export { attachSharedDevice, createDeviceStateCells, exportCommandBuffer, exportGpuResource, importCommandBuffer, markAllSharedDevicesDead, markDeviceLost, retireAllSharedDevices, retireSharedDevice, sharedDeviceAlive, sharedDeviceAttachedCount, shareDevice, submitCommandPtrs, type DeviceStateCells, type GpuDeviceHandle, type SharedDeviceView, type WorkerCommandRef } from "./gpu/shared-device";
export { WgpuAdapter, WgpuBindGroup, WgpuBindGroupLayout, WgpuBuffer, WgpuCommandBuffer, WgpuCommandEncoder, WgpuComputePassEncoder, WgpuComputePipeline, WgpuDevice, WgpuGPU, WgpuPipelineLayout, WgpuQueue, WgpuRenderPassEncoder, WgpuRenderPipeline, WgpuSampler, WgpuShaderModule, WgpuTexture, WgpuTextureView } from "./gpu/wgpu-wrapper";
export { acquireSingleInstanceLock, addCrashFeatureLog, installNativeErrorHandlers, installWindowStatePersistence, releaseSingleInstanceLock } from "./host-lifecycle";
export { createImageBitmapNative, getFreeTypeTextRenderer, installImagePolyfills, NativeCanvas2D, NativeImageBitmap } from "./image/native-image";
export { createNativeHostTools, startNativeMcpServer, type NativeMcpOptions, type NativeMcpServer } from "./mcp/native-mcp";
export { runNativeAppModule, type RunNativeAppModuleOptions } from "./native-app-module";
export { createNativeHost, type NativeHostConfig, type NativeHostContext } from "./native-host";
export { installRestartHook, requestAppRestart, type RestartHookOptions } from "./native-restart";
export { captureScreenshot, encodePNG, paddedReadbackToRGBA } from "./screenshot/screenshot";
export { initNativeSecrets, type SecretsStore } from "./secrets/index";
export { createHostServices, scopeServicesForPlugin, type HostServices, type HostServicesApi, type HostServicesOptions } from "./services/host-services";
export { AppWindow, type AppWindowOptions, type CloseRequestHandler } from "./window/app-window";
export { globalHotkeySupported, keysymFor, parseAccelerator, registerGlobalHotkey } from "./window/global-hotkeys";
export { NativeCanvasContext, NativeSurface } from "./window/native-surface";
export { NativeWindow, type NativeWindowConfig } from "./window/native-window";

