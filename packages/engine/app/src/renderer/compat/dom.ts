// ============================================================================
// compat/dom.ts — DOM-host compatibility helpers (DEPRECATED)
//
// These helpers assume a real DOM compositor (document.querySelector, 2D
// canvas contexts, Image/URL.createObjectURL). They only work on DOM hosts —
// on the native runtime (`getHostCapabilities().hasDom === false`) there is
// no DOM and no overlay tree, so these throw / fail.
//
// New code should use `getSurface()` (renderer/index.ts) and the
// `RenderSurface` contract instead. These remain exported for DOM-only
// consumers during the migration.
// ============================================================================

/**
 * Get the canvas element for a given layer index.
 * Layer 0 is the primary game canvas (id="game-canvas" by default).
 * Higher indices are additional canvases (e.g. minimap, debug overlay).
 *
 * @deprecated DOM-host only. Use `getSurface()` — native surfaces are not
 *   DOM elements and have no layer tree.
 */
export function getCanvas(layer: number = 0): HTMLCanvasElement {
  const el = document.querySelector(`canvas[data-dd-layer="${layer}"]`) as HTMLCanvasElement | null;
  if (el) return el;
  // Fallback to legacy id-based lookup for backward compatibility
  if (layer === 0) {
    const legacy = document.getElementById("game-canvas") as HTMLCanvasElement | null;
    if (legacy) return legacy;
  }
  throw new Error(`No canvas found for layer ${layer}. Ensure the HTML has <canvas data-dd-layer="${layer}">.`);
}

/**
 * Get the DOM overlay element for a given overlay index.
 * Overlay 0 is the primary React root (id="root" by default).
 *
 * @deprecated DOM-host only — the native runtime has no DOM overlay tree.
 *   `GameModule.mountUI` is never invoked on native.
 */
export function getOverlay(overlay: number = 0): HTMLElement {
  const el = document.querySelector(`div[data-dd-overlay="${overlay}"]`) as HTMLElement | null;
  if (el) return el;
  if (overlay === 0) {
    const legacy = document.getElementById("root") as HTMLElement | null;
    if (legacy) return legacy;
  }
  throw new Error(`No overlay found for index ${overlay}. Ensure the HTML has <div data-dd-overlay="${overlay}">.`);
}

/**
 * Get all canvas layers in order (layer 0 first).
 *
 * @deprecated DOM-host only. Native hosts expose exactly one RenderSurface.
 */
export function getAllCanvases(): HTMLCanvasElement[] {
  return Array.from(document.querySelectorAll("canvas[data-dd-layer]")) as HTMLCanvasElement[];
}

// --- Thumbnail capture ---

/**
 * Capture a downscaled JPEG thumbnail of a canvas as an ArrayBuffer.
 *
 * Downscaled to a max width of 320px (preserving aspect ratio). Falls back to
 * a placeholder image if canvas capture fails. The returned ArrayBuffer is
 * suitable for `ISaveStore.setThumbnail()` / `SaveOptions.thumbnail`.
 *
 * @deprecated DOM-host only — requires 2D canvas contexts + Image decoding.
 *   On native, thumbnails are captured from surface readback by the host.
 */
export async function captureCanvasThumbnail(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const maxW = 320;
  const scale = Math.min(1, maxW / canvas.width);
  const thumbW = Math.floor(canvas.width * scale);
  const thumbH = Math.floor(canvas.height * scale);

  const fullBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });

  if (fullBlob) {
    const img = new Image();
    const url = URL.createObjectURL(fullBlob);
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img load"));
        img.src = url;
      });
      const off = document.createElement("canvas");
      off.width = thumbW;
      off.height = thumbH;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(img, 0, 0, thumbW, thumbH);
      const thumbBlob = await new Promise<Blob | null>((resolve) => {
        off.toBlob((b) => resolve(b), "image/jpeg", 0.8);
      });
      if (thumbBlob) return await thumbBlob.arrayBuffer();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Placeholder if capture fails
  const placeholder = document.createElement("canvas");
  placeholder.width = 320;
  placeholder.height = 180;
  const pctx = placeholder.getContext("2d")!;
  pctx.fillStyle = "#0a0a12";
  pctx.fillRect(0, 0, 320, 180);
  pctx.fillStyle = "rgba(255,255,255,0.5)";
  pctx.font = "14px monospace";
  pctx.textAlign = "center";
  pctx.fillText("No preview", 160, 90);
  const phBlob = await new Promise<Blob | null>((resolve) => {
    placeholder.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });
  if (phBlob) return await phBlob.arrayBuffer();
  throw new Error("Thumbnail capture failed");
}

/**
 * Composite the WebGPU canvas screenshot with a DOM-overlay PNG into a single
 * PNG. The canvas is drawn first (bottom layer), then the overlay PNG on top.
 *
 * Browser/standalone fallback only — on the native host `downdraft.captureFrame()`
 * already returns the composited frame (game + overlay layers), so callers
 * should prefer it and only reach for this helper when no host exists.
 *
 *   1. Draw the WebGPU canvas onto an offscreen 2D canvas
 *   2. Load the overlay PNG as an ImageBitmap
 *   3. Draw the overlay ImageBitmap on top
 *   4. Export the composited canvas as PNG
 *
 * @deprecated DOM-host only — requires `document.createElement("canvas")` 2D
 *   contexts and `createImageBitmap`. Native screenshots go through
 *   `downdraft.captureFrame()`.
 */
export async function compositeScreenshot(
  canvas: HTMLCanvasElement,
  overlayPng: ArrayBuffer,
  width: number,
  height: number,
): Promise<Blob | null> {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d");
  if (!ctx) return null;

  // Layer 1: WebGPU canvas (bottom)
  ctx.drawImage(canvas, 0, 0, width, height);

  // Layer 2: DOM overlay PNG (top)
  const overlayBlob = new Blob([overlayPng], { type: "image/png" });
  const overlayBitmap = await createImageBitmap(overlayBlob);
  ctx.drawImage(overlayBitmap, 0, 0, width, height);
  overlayBitmap.close();

  return new Promise((resolve) => {
    offscreen.toBlob((blob) => resolve(blob), "image/png");
  });
}
