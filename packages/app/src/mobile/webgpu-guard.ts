// ============================================================================
// webgpu-guard — boot-time WebGPU + cross-origin isolation check for mobile
// ============================================================================
//
// The engine's sim architecture is built on SharedArrayBuffer (zero-copy
// renderer↔sim communication). SAB requires cross-origin isolation
// (COOP: same-origin + COEP: require-corp) on the top-level document.
//
// On mobile (Capacitor), the native embedded HTTP server serves the web
// assets with COOP/COEP headers so `self.crossOriginIsolated === true`.
// If either WebGPU or cross-origin isolation is missing, the game cannot
// boot — we show a clear, localized error screen instead of a silent hang.
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
 * Check that WebGPU and cross-origin isolation are available.
 * Returns `{ ok: true }` if both are present, otherwise `{ ok: false, reason }`.
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

  if (!self.crossOriginIsolated) {
    return {
      ok: false,
      reason:
        "Cross-origin isolation is not enabled. " +
        "SharedArrayBuffer requires COOP + COEP headers. " +
        "Ensure the embedded HTTP server is serving assets with " +
        "'Cross-Origin-Opener-Policy: same-origin' and " +
        "'Cross-Origin-Embedder-Policy: require-corp'.",
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
