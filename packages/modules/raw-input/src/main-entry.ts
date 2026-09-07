// ============================================================================
// Raw Input Module — Main-process Barrel Exports
// ============================================================================
// These exports use Node.js APIs (electron, the native .node addon) and must
// only be imported from the Electron main process, never the renderer.

export type {
  RawInputDelta,
  RawInputPlatform,
  RawInputStatus,
  RawInputCaptureConfig,
} from "./types";

export { RawInputHost } from "./main/raw-input-host";
