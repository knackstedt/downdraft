// ============================================================================
// @downdraft/engine/modules/webui — heavyweight browser-backed UI module
//
// `createWebUi` mounts real web-engine views (CEF on desktop, WPE on
// linux/android — the `downdraft.webui` host bridge) as screen-space
// composited panels with UI-priority input routing. Blitz (modules/html-ui)
// remains the canonical lightweight UI — this tier is for pages needing a
// full DOM, JS, and web APIs. The renderer-side FFI lives in
// `@downdraft/engine/libraries/webui`.
//
// Backend selection: createWebUi({ backend }) > DD_WEBUI_BACKEND >
// downdraft.config.json webui.backend > --webui= flag > platform default
// (cef on desktop, wpe on android). iOS is a future target — overlay-only
// WKWebView semantics, no composited texture path.
// ============================================================================

export { createWebUi } from "./create-web-ui";
export type {
  WebUiContext,
  WebUiOptions,
  WebUiPanelSpec,
  WebUiViewHandle,
} from "./create-web-ui";
export { WebUiTextureSource } from "./texture-source";
export type {
  WebUiBackend,
  WebUiEvent,
  WebUiHostBridge,
  WebUiInputEvent,
  WebUiViewConfig,
  WebUiViewStatus,
} from "@downdraft/engine/libraries/webui/types";
