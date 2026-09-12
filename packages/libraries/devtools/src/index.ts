// ============================================================================
// @downdraft/library-devtools — native egui debugger overlay
//
// A native debug overlay (egui + UiBlitPass) composited above the native game,
// with panels mirroring Chrome DevTools:
//   - Console (CDP Runtime.consoleAPICalled + exceptionThrown)
//   - Scene (custom scene viewer from useSceneStore)
//   - GPU (renderer GPU info / resources / pass timings / frame graph)
//   - Performance Recorder (CDP Profiler → flame graph)
//   - Performance Metrics (process.memoryUsage / cpuUsage + ProfilingSAB)
//   - DOM Tree (PIXI scene graph + ECS scene tree)
//
// Toggled by F12 in native-entry.ts. Leverages the Chrome DevTools Protocol
// via Bun's node:inspector Session where possible.
//
// The UI is rendered by a Rust egui crate (packages/libraries/devtools/native/)
// that runs egui's layout + tessellation on the CPU and serializes PaintJobs
// to TS, where EguiRenderer uploads + draws them on the shared wgpu-native
// device. The existing UiBlitPass composites the UI texture over the frame.
// ============================================================================

export { CdpBridge } from "./cdp-bridge";
export type { CdpConsoleEntry, CdpException, CdpProfile } from "./cdp-bridge";
export { NativeDebuggerHost } from "./host";
export type { NativeDebuggerOptions } from "./host";
export { checkpoint, notify, verifyPixel } from "./verify";

