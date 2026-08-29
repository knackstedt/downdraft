// ============================================================================
// webgpu-guard — boot-time WebGPU check for mobile
// ============================================================================
//
// The engine's sim architecture is built on SharedArrayBuffer (zero-copy
// renderer↔sim communication). On desktop browsers and Electron, SAB requires
// cross-origin isolation (COOP: same-origin + COEP: require-corp).
//
// On Android WebView, cross-origin isolation is NOT supported — the WebView
// uses "logical" COI instead of "concrete" COI (it lacks process isolation,
// which is the security mechanism that makes concrete COI safe). So
// `self.crossOriginIsolated` is always false even with COOP/COEP headers,
// and SharedArrayBuffer is unavailable on production builds.
//
// When SAB is unavailable, the SAB polyfill (sab-polyfill.ts) replaces it
// with an ArrayBuffer subclass, and the BufferSyncManager (buffer-sync.ts)
// synchronizes buffer regions between threads via postMessage. This is
// transparent to all game and engine code — no fallback paths needed.
//
// The `--enable-features=SharedArrayBuffer` command-line flag works on
// debuggable builds (debug APKs) and enables real SAB (bypassing the
// polyfill). See `draft mobile --debug` + the adb instructions in the shell
// README.
//
// This guard checks for WebGPU only (hard requirement). SAB is handled
// transparently by the polyfill. We check for SAB directly (not
// `crossOriginIsolated`) so that SAB enabled via the command-line flag on
// debug builds is correctly detected and the polyfill is skipped.
//
// WebGPU floor:
//   - Android WebView 121+
//   - iOS / iPadOS 26+ (WKWebView — NOT Safari-the-browser which got WebGPU
//     at iOS 18; the WKWebView component only enabled it at iOS 26 / Tahoe)

export interface WebGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Check that WebGPU is available.
 * Returns `{ ok: true }` if WebGPU is present, otherwise `{ ok: false, reason }`.
 *
 * SharedArrayBuffer is no longer a hard requirement — when unavailable (Android
 * WebView production builds), the SAB polyfill provides a transparent fallback
 * via copy-based buffer sync. See sab-polyfill.ts + buffer-sync.ts.
 */
export function checkWebGpuAndIsolation(): WebGuardResult {
  const nav = globalThis as unknown as { navigator?: { gpu?: unknown } };

  if (!nav.navigator?.gpu) {
    return {
      ok: false,
      reason:
        "WebGPU is not available on this device. " +
        "Downdraft games require a WebGPU-capable WebView " +
        "(Android WebView 121+ or iOS / iPadOS 26+).",
    };
  }

  // SharedArrayBuffer is optional — the polyfill handles it transparently.
  // No SAB check here. The polyfill (sab-polyfill.ts) activates automatically
  // when SAB is undefined and logs a warning with the debug identifier
  // `globalThis.__DOWNDRAFT_SAB_POLYFILL = true`.

  return { ok: true };
}

/**
 * Show a full-screen error overlay when the device is unsupported.
 * Used as a last resort when the guard fails — the game cannot boot.
 */
export function showUnsupportedDeviceScreen(reason: string): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:#0a0a12",
    "color:#c084fc",
    "font-family:system-ui,-apple-system,sans-serif",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "padding:32px",
    "text-align:center",
    "z-index:99999",
  ].join(";");

  const title = document.createElement("h1");
  title.textContent = "Unsupported Device";
  title.style.cssText = "font-size:24px;margin:0 0 16px";

  const body = document.createElement("p");
  body.textContent = reason;
  body.style.cssText = "font-size:16px;line-height:1.5;max-width:480px;opacity:0.85";

  overlay.appendChild(title);
  overlay.appendChild(body);
  document.body.appendChild(overlay);
}
