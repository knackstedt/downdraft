// ============================================================================
// atlas.ts — shelf-packed coverage atlas for rasterized text runs.
//
// One rgba8unorm texture; runs upload their premultiplied coverage bitmap
// into a region. Eviction is generational: when the atlas fills, `reset()`
// bumps `generation` and all cached regions invalidate (callers re-rasterize
// on demand — run rasterization is ~100µs).
// ============================================================================

interface Shelf {
  y: number;
  h: number;
  x: number;
}

/** Transparent gutter around every region — linear sampling at a quad edge
 *  pulls half a pad texel instead of the neighboring run's ink. Without it
 *  tightly-packed shelves bleed foreign coverage into text edges. */
const PAD = 1;

export interface AtlasRegion {
  u: number;
  v: number;
  w: number;
  h: number;
  generation: number;
}

export class TextAtlas {
  readonly size: number;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  generation = 0;
  private shelves: Shelf[] = [];
  private nextY = 0;
  private padded = new Uint8Array(new ArrayBuffer(0));

  constructor(readonly device: GPUDevice, size = 2048) {
    this.size = size;
    this.texture = device.createTexture({
      label: "text-atlas",
      size: { width: size, height: size },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.device.queue.writeTexture(
      { texture: this.texture },
      new Uint8Array(size * size * 4),
      { bytesPerRow: size * 4 },
      { width: size, height: size },
    );
  }

  /** Allocate a texel rectangle, or null if the atlas is full. The returned
   *  region already excludes the padding gutter — upload/write into it as
   *  if it were exact-size. */
  alloc(w: number, h: number): AtlasRegion | null {
    if (w <= 0 || h <= 0) return null;
    const pw = w + PAD * 2;
    const ph = h + PAD * 2;
    // Best-fit shelf: shortest shelf that still fits the height.
    let bestIdx = -1;
    this.shelves.forEach((s, i) => {
      if (s.h >= ph && s.x + pw <= this.size) {
        if (bestIdx < 0 || s.h < this.shelves[bestIdx]!.h) bestIdx = i;
      }
    });
    const best = bestIdx >= 0 ? this.shelves[bestIdx]! : null;
    if (best) {
      const r: AtlasRegion = { u: best.x + PAD, v: best.y + PAD, w, h, generation: this.generation };
      best.x += pw;
      return r;
    }
    if (this.nextY + ph > this.size) return null;
    const shelf: Shelf = { y: this.nextY, h: ph, x: pw };
    this.shelves.push(shelf);
    this.nextY += ph;
    return { u: PAD, v: shelf.y + PAD, w, h, generation: this.generation };
  }

  /** Upload premultiplied RGBA coverage into an allocated region. Writes the
   *  gutter too — zeroed, so a generation-reset atlas can't leak stale ink
   *  through the pad texels. */
  upload(region: AtlasRegion, data: Uint8Array): void {
    const w = region.w;
    const h = region.h;
    const sw = w + PAD * 2;
    const sh = h + PAD * 2;
    const slotBpr = sw * 4;
    const bpr = Math.ceil(slotBpr / 256) * 256;
    const need = bpr * sh;
    if (this.padded.length < need) this.padded = new Uint8Array(need);
    this.padded.fill(0, 0, need);
    for (let row = 0; row < h; row++) {
      this.padded.set(
        data.subarray(row * w * 4, (row + 1) * w * 4),
        (row + PAD) * bpr + PAD * 4,
      );
    }
    this.device.queue.writeTexture(
      { texture: this.texture, origin: { x: region.u - PAD, y: region.v - PAD } },
      this.padded.subarray(0, need) as Uint8Array<ArrayBuffer>,
      { bytesPerRow: bpr },
      { width: sw, height: sh },
    );
  }

  /** Invalidate every region. Callers must re-rasterize on next lookup. */
  reset(): void {
    this.generation++;
    this.shelves.length = 0;
    this.nextY = 0;
  }

  destroy(): void {
    this.texture.destroy();
  }
}
