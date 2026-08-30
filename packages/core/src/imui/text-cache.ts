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

interface CacheKey {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  color: string;
}

const ATLAS_PADDING = 2;
const MAX_ATLAS_WIDTH = 2048;
const ATLAS_HEIGHT = 512;
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

  getSampler(): GPUSampler {
    return this.sampler;
  }

  private makeKey(text: string, opts: TextRenderOptions): string {
    return `${text}|${opts.fontFamily}|${opts.fontSize}|${opts.fontWeight}|${opts.color}`;
  }

  getText(text: string, opts: TextRenderOptions): TextCacheEntry | null {
    const key = this.makeKey(text, opts);
    const existing = this.entries.get(key);
    if (existing) {
      this.lastUsed.set(key, ++this.accessCounter);
      return existing;
    }

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
        entryX / MAX_ATLAS_WIDTH,
        entryY / ATLAS_HEIGHT,
        (entryX + textWidth) / MAX_ATLAS_WIDTH,
        (entryY + textHeight) / ATLAS_HEIGHT,
      ],
    };
    this.entries.set(key, entry);
    this.lastUsed.set(key, ++this.accessCounter);
    return entry;
  }

  flush(): void {
    if (!this.dirty || this.cursorX === 0) return;

    if (!this.atlasTexture) {
      this.atlasTexture = this.device.createTexture({
        size: [MAX_ATLAS_WIDTH, ATLAS_HEIGHT],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.atlasView = this.atlasTexture.createView();
    }

    const usedHeight = this.cursorY + this.atlasRowHeight;
    const imageData = this.atlasCtx.getImageData(0, 0, MAX_ATLAS_WIDTH, usedHeight);
    this.device.queue.writeTexture(
      { texture: this.atlasTexture },
      imageData.data as unknown as BufferSource,
      { bytesPerRow: MAX_ATLAS_WIDTH * 4, rowsPerImage: usedHeight },
      [MAX_ATLAS_WIDTH, usedHeight],
    );

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
