// ============================================================================
// webgpu-guard — boot-time WebGPU + SharedArrayBuffer check for mobile
// ============================================================================
//
// The engine's sim architecture is built on SharedArrayBuffer (zero-copy
// renderer↔sim communication). On desktop browsers and Electron, SAB requires
// cross-origin isolation (COOP: same-origin + COEP: require-corp).
//
// On Android WebView, cross-origin isolation is not supported — the WebView
// uses "logical" COI instead of "concrete" COI, so `self.crossOriginIsolated`
// is always false even with COOP/COEP headers. However, SharedArrayBuffer can
// still be enabled via the `--enable-features=SharedArrayBuffer` WebView
// command-line flag (set in /data/local/tmp/webview-command-line for debug
// builds, or via the app's native initialization for production builds).
//
// This guard checks for WebGPU AND SharedArrayBuffer directly, rather than
// relying on `crossOriginIsolated`, to support both standard browsers (where
// SAB is gated behind COI) and Android WebView (where SAB is enabled via
// flags without COI).
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
  // enabled via the --enable-features=SharedArrayBuffer flag, so we check
  // for the constructor directly rather than relying on crossOriginIsolated.
  if (typeof SharedArrayBuffer === "undefined") {
    return {
      ok: false,
      reason:
        "SharedArrayBuffer is not available. " +
        "On desktop browsers, this requires cross-origin isolation " +
        "(COOP + COEP headers). On Android WebView, this requires the " +
        "'--enable-features=SharedArrayBuffer' flag. " +
        "Ensure the embedded HTTP server is serving assets with " +
        "'Cross-Origin-Opener-Policy: same-origin' and " +
        "'Cross-Origin-Embedder-Policy: require-corp', and that the " +
        "WebView is configured with the SharedArrayBuffer feature flag.",
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
