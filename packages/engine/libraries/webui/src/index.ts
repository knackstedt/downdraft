// ============================================================================
// @downdraft/engine/libraries/webui — heavyweight browser-backed UI tier
//
// A real web engine (CEF/Chromium on desktop, WPE/WebKit on linux+android)
// behind the shared dd_webui_* ABI, for UI that needs full JavaScript, web
// APIs, and complex pages Blitz can't render. Blitz (modules/html-ui)
// remains the canonical lightweight UI — this tier is opt-in per view.
//
// Import surface:
//   - types: WebUiHostBridge / WebUiViewConfig / WebUiEvent / WebUiInputEvent
//   - webui-ffi: WebUIView / loadWebUiLib / resolveWebUiBackend (native FFI)
//   - The renderer-facing module lives at @downdraft/engine/modules/webui
//     (createWebUi) and consumes the `downdraft.webui` host bridge.
// ============================================================================

export type {
  WebUiBackend,
  WebUiViewConfig,
  WebUiViewStatus,
  WebUiEvent,
  WebUiInputEvent,
  WebUiNavOp,
  WebUiPixelFormat,
  WebUiHostBridge,
} from "./types";

export {
  WebUIView,
  loadWebUiLib,
  resolveWebUiBackend,
  webUiGlobalInit,
  webUiGlobalShutdown,
  WEBUI_FRAME_HEADER,
} from "./webui-ffi";
export type { WebUiSymbols, WebUiGlobalInitOpts } from "./webui-ffi";
