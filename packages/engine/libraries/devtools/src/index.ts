// ============================================================================
// @downdraft/engine/libraries/devtools — engine devtools bridge
//
// Two frontends consume the same provider/command data model
// (DevtoolsProviderTarget — registerEngineProviders works on both):
//
//   WebDevtoolsHost (current, web/): development-only loopback server
//     (Bun.serve HTTP + WebSocket JSON-RPC) serving the browser frontend in
//     packages/devtools-web. F12 in native-entry.ts opens the devtools in a
//     desktop browser window.
//
//   NativeDebuggerHost (legacy): Rust egui crate renders PaintJobs into a
//     GPUTexture composited over the frame by UiBlitPass. Kept while the web
//     path is verified on real hardware; slated for removal.
//
// Panels: Console (CDP Runtime.consoleAPICalled + exceptionThrown + logger
// sink), Scene/DOM trees, GPU info, CDP profiler, per-thread ProfilingSAB
// metrics, and provider-fed snapshot panels (sim, memory, render-graph,
// materials, doctor, workers, input, postfx, assets, game).
// ============================================================================

export { CdpBridge } from "./cdp-bridge";
export type { CdpConsoleEntry, CdpException, CdpProfile } from "./cdp-bridge";
export { encodeSnapshot, PANEL, SNAP_FLAG, SNAP_STATUS } from "./egui-ffi";
export type { DevtoolsCommand, PanelName, PanelSnapshot, SnapshotSection } from "./egui-ffi";
export { NativeDebuggerHost } from "./host";
export type { NativeDebuggerOptions } from "./host";
export { DevtoolsMirror } from "./mirror";
export type { PanelCommandHandler, PanelProvider } from "./mirror";
export { registerEngineProviders } from "./native-providers";
export type { EngineProviderContext } from "./native-providers";
export { checkpoint, notify, verifyPixel } from "./verify";

// ── Web devtools (browser UI over WS + JSON-RPC) ──
export { openDevToolsUrl } from "./web/browser";
export { WebDebuggerSceneShim, WebDevtoolsHost } from "./web/host";
export type { WebDevtoolsOptions } from "./web/host";
export { WebDevtoolsMirror } from "./web/mirror";
export { DevToolsServer } from "./web/server";

