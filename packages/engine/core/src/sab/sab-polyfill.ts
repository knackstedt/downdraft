// ============================================================================
// sab-polyfill — SharedArrayBuffer polyfill for hosts without real SAB
// ============================================================================
//
// Some JS hosts do not support SharedArrayBuffer. This polyfill replaces it
// with an ArrayBuffer subclass so that all existing channel code (typed array
// views, Atomics.load/add/store) works unchanged.
//
// The "sharing" is implemented separately by the BufferSyncManager
// (packages/engine/core/src/worker/buffer-sync.ts), which copies buffer regions
// between the main thread and worker via postMessage at tick/frame boundaries.
//
// Why this works:
//   - `class FakeSAB extends ArrayBuffer` passes V8's IS_ARRAYBUFFER check,
//     so `new Int32Array(fakeSAB, offset, length)` creates working views.
//   - `Atomics.load/add/store` work on ArrayBuffer-backed typed arrays (V8
//     doesn't enforce the SAB requirement for these — verified). They perform
//     non-atomic reads/writes, which is correct for the copy-based protocol
//     (each side has its own buffer copy — no concurrent access).
//   - Only `Atomics.wait` throws on non-SAB arrays. We shim it to return
//     "timed-out" as a safety net.
//
// This file must be imported BEFORE any code that references SharedArrayBuffer.
// It is a no-op when real SharedArrayBuffer is available (desktop/Electron).
//

import { createLogger } from "../util/logger";

const log = createLogger();

/** True if the real SharedArrayBuffer is available. False if polyfilled. */
export const usingRealSAB = typeof SharedArrayBuffer !== "undefined";

if (!usingRealSAB) {
  // Polyfill SharedArrayBuffer as an ArrayBuffer subclass.
  // Typed array views (Int32Array, Float32Array, etc.) work on it because
  // V8's IS_ARRAYBUFFER check passes for ArrayBuffer subclasses.
  (globalThis as any).SharedArrayBuffer = class SharedArrayBuffer extends ArrayBuffer {
    constructor(size: number) {
      super(size);
    }
  };

  // Shim Atomics.wait — only wait throws on non-SAB arrays.
  // load/add/store/store/notify all work without throwing on ArrayBuffer.
  (Atomics as any).wait = () => "timed-out" as const;

  // Debug identifier — detectable from console/devtools.
  (globalThis as any).__DOWNDRAFT_SAB_POLYFILL = true;
  log.warn(
    "SAB Polyfill",
    "SharedArrayBuffer is not available — using copy-based buffer sync protocol.\n" +
    "This is expected on Android WebView production builds.\n" +
    "If you see this in a desktop browser or Electron, COOP/COEP headers may be missing.",
  );
}
