// ============================================================================
// webgpu-guard — boot-time WebGPU + SharedArrayBuffer check for mobile
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
// and SharedArrayBuffer is unavailable.
//
// The `--enable-features=SharedArrayBuffer` command-line flag DOES work, but
// ONLY on debuggable builds (debug APKs). The Chromium WebView provider only
// reads `/data/local/tmp/webview-command-line` when `Build.IS_DEBUGGABLE` is
// true; on production (release) builds it calls `CommandLine.init(null)` and
// no flags are loaded. The file also requires adb/shell access to write —
// the app itself cannot write it.
//
// For testing on your own device: build a debug APK and use adb to set the
// flag (see `draft mobile --debug` + the adb instructions in the shell
// README). For production distribution: a non-SAB fallback communication
// path is required (TODO — not yet implemented).
//
// This guard checks for WebGPU AND SharedArrayBuffer directly, rather than
// relying on `crossOriginIsolated`, so that SAB enabled via the
// command-line flag on debug builds is correctly detected.
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
 * Check that WebGPU and SharedArrayBuffer are available.
 * Returns `{ ok: true }` if both are present, otherwise `{ ok: false, reason }`.
 *
 * On Android WebView, `crossOriginIsolated` is always false (the WebView uses
 * "logical" COI, not "concrete" COI). We check for SharedArrayBuffer directly
 * instead of relying on `crossOriginIsolated`, so that SAB enabled via the
 * `--enable-features=SharedArrayBuffer` flag is correctly detected.
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

  // Check for SharedArrayBuffer directly. On desktop browsers, SAB is gated
  // behind cross-origin isolation (COOP/COEP). On Android WebView, SAB is
  // only available on debuggable builds via the --enable-features=SharedArrayBuffer
  // command-line flag (set via adb); production WebView builds do not support SAB
  // at all due to lack of process isolation (logical COI, not concrete COI).
  if (typeof SharedArrayBuffer === "undefined") {
    return {
      ok: false,
      reason:
        "SharedArrayBuffer is not available. " +
        "On desktop browsers, this requires cross-origin isolation " +
        "(COOP + COEP headers). On Android WebView, SAB is only available " +
        "on debuggable builds with the '--enable-features=SharedArrayBuffer' " +
        "flag set via adb; production WebView builds do not support SAB " +
        "(no process isolation → logical COI only). " +
        "For testing: build a debug APK and run " +
        "'adb shell \"echo _ --enable-features=SharedArrayBuffer > /data/local/tmp/webview-command-line\"'. " +
        "For production: a non-SAB fallback is required (not yet implemented).",
    };
  }

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
