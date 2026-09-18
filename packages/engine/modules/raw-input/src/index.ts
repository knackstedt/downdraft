// ============================================================================
// Raw Input Module — Renderer-side Barrel Exports
// ============================================================================
// NOTE: Main-process exports are in ./main-entry.ts to avoid pulling Node.js
// APIs (electron, the native .node addon) into the renderer bundle.

export type {
  RawInputDelta,
  RawInputPlatform,
  RawInputStatus,
  RawInputCaptureConfig,
} from "./types";

export { installPointerLockPolyfill } from "./renderer/polyfill";
export { RawInputModule } from "./renderer/raw-input-module";
export type { RawInputModuleOptions } from "./renderer/raw-input-module";
