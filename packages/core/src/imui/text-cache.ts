export interface TextCacheEntry {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  uv: [number, number, number, number]; // u0, v0, u1, v1
}

export interface TextRenderOptions {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  maxWidth?: number;
}

/**
 * Direct text rasterizer hook — when set, the TextAtlasCache bypasses
 * Canvas2D entirely and uses this function to render text directly to
 * RGBA pixels. This is used by the native platform layer to provide
 * FreeType-based text rendering without going through the Canvas2D polyfill.
 *
 * The function receives the text string and font size, and returns
 * { data: Uint8Array, width: number, height: number } where data is
 * RGBA pixels (white text with alpha channel = coverage).
 */
export type DirectTextRenderer = (text: string, fontSize: number) =>
  { data: Uint8Array; width: number; height: number } | null;

interface CacheKey {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  color: string;
}

const ATLAS_PADDING = 4;
const MAX_ATLAS_WIDTH = 4096;
const ATLAS_HEIGHT = 1024;
const ROW_HEIGHT = 64;

export class TextAtlasCache {
  private device: GPUDevice;
  private sampler: GPUSampler;
  private atlasCanvas: HTMLCanvasElement | OffscreenCanvas;
  private atlasCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private atlasTexture: GPUTexture | null = null;
  private atlasView: GPUTextureView | null = null;
  private cursorX: number = 0;
  private cursorY: number = 0;
  private atlasRowHeight: number = 0;
  private entries: Map<string, TextCacheEntry> = new Map();
  private lastUsed: Map<string, number> = new Map();
  private accessCounter: number = 0;
  private dirty: boolean = true;
  private directRenderer: DirectTextRenderer | null = null;
  /** Raw pixel buffer for direct rendering (bypasses Canvas2D). */
  private atlasPixels: Uint8Array | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    if (typeof OffscreenCanvas !== "undefined") {
      this.atlasCanvas = new OffscreenCanvas(MAX_ATLAS_WIDTH, ATLAS_HEIGHT);
    } else {
      this.atlasCanvas = document.createElement("canvas");
      (this.atlasCanvas as HTMLCanvasElement).width = MAX_ATLAS_WIDTH;
      (this.atlasCanvas as HTMLCanvasElement).height = ATLAS_HEIGHT;
    }
    const ctx = this.atlasCanvas.getContext("2d")!;
    this.atlasCtx = ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  }

  /**
   * Set a direct text renderer (e.g. FreeType). When set, text is rendered
   * directly to RGBA pixels and placed into the atlas, bypassing Canvas2D.
   */
  setDirectRenderer(renderer: DirectTextRenderer | null): void {
    this.directRenderer = renderer;
    if (renderer && !this.atlasPixels) {
      this.atlasPixels = new Uint8Array(MAX_ATLAS_WIDTH * ATLAS_HEIGHT * 4);
    }
  }

  getSampler(): GPUSampler {
    return this.sampler;
  }

  private makeKey(text: string, opts: TextRenderOptions): string {
    return `${text}|${opts.fontFamily}|${opts.fontSize}|${opts.fontWeight}|${opts.color}`;
  }

  /** Lazily create the atlas texture + view if they don't exist yet. */
  private ensureAtlasTexture(): void {
    if (!this.atlasTexture) {
      this.atlasTexture = this.device.createTexture({
        size: [MAX_ATLAS_WIDTH, ATLAS_HEIGHT],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.atlasView = this.atlasTexture.createView();
    }
  }

  getText(text: string, opts: TextRenderOptions): TextCacheEntry | null {
    const key = this.makeKey(text, opts);
    const existing = this.entries.get(key);
    if (existing) {
      this.lastUsed.set(key, ++this.accessCounter);
      return existing;
    }

    // ── Try direct renderer first (FreeType in native mode) ──
    if (this.directRenderer && this.atlasPixels) {
      const result = this.directRenderer(text, opts.fontSize);
      if (result && result.width > 0 && result.height > 0) {
        const tw = result.width + ATLAS_PADDING * 2;
        const th = result.height + ATLAS_PADDING * 2;

        if (this.cursorX + tw > MAX_ATLAS_WIDTH) {
          this.cursorX = 0;
          this.cursorY += this.atlasRowHeight;
          this.atlasRowHeight = 0;
        }

        if (this.cursorY + th > ATLAS_HEIGHT) {
          // Atlas full — clear ALL entries and pixel buffer.
          // We can't do partial LRU eviction because clearing the pixel
          // buffer invalidates ALL UV coordinates, not just the evicted
          // entries.  Surviving entries would point to zeroed pixels.
          // A full reset means all text gets re-rendered on demand next
          // frame — a brief, correct flash rather than persistent ghosts.
          this.entries.clear();
          this.lastUsed.clear();
          this.cursorX = 0;
          this.cursorY = 0;
          this.atlasRowHeight = 0;
          this.atlasPixels.fill(0);
          this.dirty = true;
        }

        if (th > this.atlasRowHeight) this.atlasRowHeight = th;

        const entryX = this.cursorX;
        const entryY = this.cursorY;
        this.cursorX += tw;
        this.dirty = true;

        // Copy FreeType RGBA pixels directly into the atlas pixel buffer
        const { data: srcData, width: srcW, height: srcH } = result;
        for (let py = 0; py < srcH; py++) {
          const dstRow = (entryY + ATLAS_PADDING + py) * MAX_ATLAS_WIDTH;
          const srcRow = py * srcW;
          for (let px = 0; px < srcW; px++) {
            const srcIdx = (srcRow + px) * 4;
            const dstIdx = (dstRow + entryX + ATLAS_PADDING + px) * 4;
            this.atlasPixels[dstIdx]     = srcData[srcIdx];
            this.atlasPixels[dstIdx + 1] = srcData[srcIdx + 1];
            this.atlasPixels[dstIdx + 2] = srcData[srcIdx + 2];
            this.atlasPixels[dstIdx + 3] = srcData[srcIdx + 3];
          }
        }

        // Ensure the atlas GPU texture exists so we can set the view
        // immediately — this prevents the renderer from falling through
        // to the bitmap glyph atlas fallback for dynamic text.
        this.ensureAtlasTexture();

        const entry: TextCacheEntry = {
          texture: this.atlasTexture!,
          view: this.atlasView!,
          width: result.width,
          height: result.height,
          // Use texel-center UVs to prevent linear-filter blurriness.
          // In WebGPU, UV x/width samples at the texel edge, blending
          // 50/50 with the adjacent (empty) padding texel.  Adding 0.5
          // shifts the sample to the texel center for crisp 1:1 mapping.
          uv: [
            (entryX + ATLAS_PADDING + 0.5) / MAX_ATLAS_WIDTH,
            (entryY + ATLAS_PADDING + 0.5) / ATLAS_HEIGHT,
            (entryX + ATLAS_PADDING + result.width - 0.5) / MAX_ATLAS_WIDTH,
            (entryY + ATLAS_PADDING + result.height - 0.5) / ATLAS_HEIGHT,
          ],
        };
        this.entries.set(key, entry);
        this.lastUsed.set(key, ++this.accessCounter);
        return entry;
      }
    }

    // ── Fallback: Canvas2D path (browser or no direct renderer) ──
    const ctx = this.atlasCtx;
    ctx.font = `${opts.fontWeight} ${opts.fontSize}px ${opts.fontFamily}`;
    ctx.textAlign = opts.textAlign;
    ctx.textBaseline = opts.textBaseline;
    ctx.fillStyle = opts.color;

    const metrics = ctx.measureText(text);
    const textWidth = Math.ceil(metrics.width) + ATLAS_PADDING * 2;
    const textHeight = Math.ceil(opts.fontSize * 1.3) + ATLAS_PADDING * 2;

    if (this.cursorX + textWidth > MAX_ATLAS_WIDTH) {
      // Wrap to next row
      this.cursorX = 0;
      this.cursorY += this.atlasRowHeight;
      this.atlasRowHeight = 0;
    }

    if (this.cursorY + textHeight > ATLAS_HEIGHT) {
      // Atlas full — evict the 25% least recently used entries instead of
      // clearing everything, so frequently-used text survives.
      const evictCount = Math.max(1, Math.floor(this.entries.size * 0.25));
      const sortedKeys = [...this.entries.keys()].sort(
        (a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0),
      );
      for (let e = 0; e < evictCount && e < sortedKeys.length; e++) {
        const k = sortedKeys[e];
        this.entries.delete(k);
        this.lastUsed.delete(k);
      }
      // Reset cursor to rebuild from the top of the atlas.
      this.cursorX = 0;
      this.cursorY = 0;
      this.atlasRowHeight = 0;
      // Clear the canvas so stale pixels don't bleed into new entries.
      this.atlasCtx.clearRect(0, 0, MAX_ATLAS_WIDTH, ATLAS_HEIGHT);
      this.dirty = true;
    }

    if (textHeight > this.atlasRowHeight) {
      this.atlasRowHeight = textHeight;
    }

    const entryX = this.cursorX;
    const entryY = this.cursorY;
    this.cursorX += textWidth;
    this.dirty = true;

    ctx.fillText(text, entryX + ATLAS_PADDING, entryY + ATLAS_PADDING);

    const entry: TextCacheEntry = {
      texture: null as any,
      view: null as any,
      width: textWidth - ATLAS_PADDING * 2,
      height: textHeight,
      uv: [
        (entryX + 0.5) / MAX_ATLAS_WIDTH,
        (entryY + 0.5) / ATLAS_HEIGHT,
        (entryX + textWidth - 0.5) / MAX_ATLAS_WIDTH,
        (entryY + textHeight - 0.5) / ATLAS_HEIGHT,
      ],
    };
    this.entries.set(key, entry);
    this.lastUsed.set(key, ++this.accessCounter);
    return entry;
  }

  flush(): void {
    if (!this.dirty || this.cursorX === 0) return;

    this.ensureAtlasTexture();

    const usedHeight = this.cursorY + this.atlasRowHeight;

    // Use direct pixel buffer when available (native FreeType path),
    // otherwise fall back to Canvas2D getImageData.
    if (this.atlasPixels && this.directRenderer) {
      // Upload the direct pixel buffer (only the used region)
      const subBuffer = this.atlasPixels.subarray(0, MAX_ATLAS_WIDTH * usedHeight * 4);
      this.device.queue.writeTexture(
        { texture: this.atlasTexture },
        subBuffer as unknown as BufferSource,
        { bytesPerRow: MAX_ATLAS_WIDTH * 4, rowsPerImage: usedHeight },
        [MAX_ATLAS_WIDTH, usedHeight],
      );
    } else {
      const imageData = this.atlasCtx.getImageData(0, 0, MAX_ATLAS_WIDTH, usedHeight);
      this.device.queue.writeTexture(
        { texture: this.atlasTexture },
        imageData.data as unknown as BufferSource,
        { bytesPerRow: MAX_ATLAS_WIDTH * 4, rowsPerImage: usedHeight },
        [MAX_ATLAS_WIDTH, usedHeight],
      );
    }

    for (const entry of this.entries.values()) {
      if (!entry.texture) {
        entry.texture = this.atlasTexture;
        entry.view = this.atlasView!;
      }
    }

    this.dirty = false;
  }

  getAtlasView(): GPUTextureView | null {
    return this.atlasView;
  }

  measureText(text: string, opts: TextRenderOptions): { width: number; height: number } {
    const ctx = this.atlasCtx;
    ctx.font = `${opts.fontWeight} ${opts.fontSize}px ${opts.fontFamily}`;
    const metrics = ctx.measureText(text);
    return {
      width: metrics.width,
      height: opts.fontSize * 1.3,
    };
  }

  wrapText(text: string, opts: TextRenderOptions, maxWidth: number): string[] {
    const ctx = this.atlasCtx;
    ctx.font = `${opts.fontWeight} ${opts.fontSize}px ${opts.fontFamily}`;
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = "";

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const width = ctx.measureText(testLine).width;
      if (width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  destroy(): void {
    this.atlasTexture?.destroy();
    this.atlasTexture = null;
    this.atlasView = null;
    this.entries.clear();
    this.lastUsed.clear();
  }
}
