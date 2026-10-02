// ============================================================================
// @downdraft/engine/libraries/blitz-ui — shared Blitz/Dioxus UI support.
//
// - BlitzUiRouter: InputManager → wasm UI input bridge (works on both
//   web and native).
// - createBlitzUiNativeModule: headless vello_cpu → texture → UiBlitPass
//   compositing for the native runtime — native-only, import via
//   "@downdraft/engine/libraries/blitz-ui/native-module". Game crates
//   compile the shared `downdraft-blitz-shell` Rust crate
//   (libraries/blitz-ui/native) with their own Dioxus app + snapshot type.
// ============================================================================

export { BlitzUiRouter, type BlitzWasmInput } from "./router";
export { UiBlitPass } from "./ui-blit-pass";

