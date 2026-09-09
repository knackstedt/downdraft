// ============================================================================
// @downdraft/library-devtools — native Pixi.js debugger overlay
//
// A dedicated debug overlay (second NativePixiUiHost + UiBlitPass) composited
// above the native game, with pixi panels mirroring Chrome DevTools:
//   - Console (CDP Runtime.consoleAPICalled + exceptionThrown)
//   - Scene (custom scene viewer from useSceneStore)
//   - GPU (renderer GPU info / resources / pass timings / frame graph)
//   - Performance Recorder (CDP Profiler → flame graph)
//   - Performance Metrics (process.memoryUsage / cpuUsage + ProfilingSAB)
//   - DOM Tree (PIXI scene graph + ECS scene tree)
//
// Toggled by F12 in native-entry.ts. Leverages the Chrome DevTools Protocol
// via Bun's node:inspector Session where possible.
// ============================================================================

export { NativeDebuggerHost } from "./host";
export type { NativeDebuggerOptions } from "./host";
export { CdpBridge } from "./cdp-bridge";
export type { CdpConsoleEntry, CdpProfile, CdpException } from "./cdp-bridge";
export { DebuggerScene } from "./debugger-scene";
export { verifyPixel, notify, checkpoint } from "./verify";
