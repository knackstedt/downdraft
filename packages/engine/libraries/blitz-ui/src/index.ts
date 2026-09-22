// ============================================================================
// @downdraft/engine/libraries/blitz-ui — shared Blitz/Dioxus UI support.
//
// - BlitzUiRouter: InputManager → wasm UI input bridge (works on both
//   web and native).
// - createBlitzUiNativeModule: headless vello_cpu → texture → UiBlitPass
//   compositing for the Bun/SDL runtime. Game crates compile the shared
//   `downdraft-blitz-shell` Rust crate (libraries/blitz-ui/native) with
//   their own Dioxus app + snapshot type.
// ============================================================================

export { BlitzUiRouter, type BlitzWasmInput } from "./router";
export {
    createBlitzUiNativeModule,
    type BlitzHostRenderer,
    type BlitzUiNativeOptions,
    type BlitzWasmModule,
} from "./native-module";
