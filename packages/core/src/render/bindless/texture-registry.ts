// ============================================================================
// BindlessTextureRegistry — owns texture_2d_array "buckets" for bindless sampling
//
// WebGPU's native bindless mechanism is `texture_2d_array<T>`: one bind group
// entry is a single GPUTexture with many 2D array layers, sampled with a
// per-sample array index. All layers in a texture_2d_array must share format +
// width + height + mip count + sample count, and the layer count is bounded by
// `maxTextureArrayLayers` (default 256).
//
// Textures are bucketed by (format, width, height, mipCount, sampleCount). Each
// bucket holds up to MAX_PAGES texture_2d_array textures ("pages"), each with
// up to `layersPerPage` layers. When a page fills, a new page is appended and
// the material bind group is rebuilt (rare — not per frame).
//
// A registered texture returns a stable TextureHandle packing (pageIndex << 16)
// | layerIndex. Shaders index `texture_2d_array` bindings by pageIndex and
// sample layerIndex.
// ============================================================================

import { createLogger } from "../../util/logger";

const log = createLogger();

// GPUTextureUsage flags — numeric literals for environments without WebGPU globals (Bun test)
const TEXTURE_BINDING_USAGE = 0x04;   // GPUTextureUsage.TEXTURE_BINDING
const COPY_DST_USAGE = 0x02;          // GPUTextureUsage.COPY_DST
const COPY_SRC_USAGE = 0x01;          // GPUTextureUsage.COPY_SRC
const RENDER_ATTACHMENT_USAGE = 0x10; // GPUTextureUsage.RENDER_ATTACHMENT

export interface TextureBucketKey {
  format: GPUTextureFormat;
  width: number;
  height: number;
  mipCount: number;
  sampleCount: number;
}

export interface RegisteredTexture {
  /** Stable handle packing (globalArrayIndex << 16) | layerIndex. */
  handle: number;
  bucketKey: string;
  /** Global flat array index across all buckets (used in shader handles). */
  arrayIndex: number;
  /** Page index within the bucket (used for texture data copies). */
  pageIndex: number;
  layerIndex: number; // layer within the page
}

export interface TextureRegistryOptions {
  /** Max number of array pages per bucket. Each page is one texture_2d_array. */
  maxPagesPerBucket?: number;
  /** Layers per page. Clamped to device.limits.maxTextureArrayLayers. */
  layersPerPage?: number;
  /** Max array pages bound in the material bind group (per format slot). */
  maxArrayBindingsPerFormat?: number;
}

const DEFAULT_MAX_PAGES = 8;
const DEFAULT_LAYERS_PER_PAGE = 256;
const DEFAULT_MAX_ARRAY_BINDINGS = 8;

function bucketKey(k: TextureBucketKey): string {
  return `${k.format}|${k.width}x${k.height}|mip${k.mipCount}|ms${k.sampleCount}`;
}

interface Bucket {
  key: TextureBucketKey;
  keyStr: string;
  pages: GPUTexture[];
  /** globalArrayIndices[page] = permanent global binding index for that page. */
  globalArrayIndices: number[];
  /** layerCursor[page] = next free layer index in that page. */
  layerCursor: number[];
  /** Free list of (page, layer) pairs returned by unregister. */
  freeList: Array<{ page: number; layer: number }>;
  /** External source textures we copied from, keyed by a caller-provided id. */
  sources: Map<unknown, RegisteredTexture>;
}

export class BindlessTextureRegistry {
  private device: GPUDevice;
  private buckets: Map<string, Bucket> = new Map();
  private maxPagesPerBucket: number;
  private layersPerPage: number;
  private maxArrayBindingsPerFormat: number;
  /** Next global binding index for a new page (monotonic, never reused). */
  private nextGlobalArrayIndex = 0;
  /** Bumped whenever any bucket adds a page — used to invalidate bind groups. */
  private layoutVersion = 0;
  /** Default white 1x1 rgba8unorm handle (always layer 0 of the default bucket). */
  defaultWhiteHandle = 0;
  /** Default black 1x1 rgba8unorm handle. */
  defaultBlackHandle = 0;

  // ── Mipmap generation (in-place blit into bucket page mip levels) ──
  private mipPipelines: Map<GPUTextureFormat, GPURenderPipeline> = new Map();
  private mipBindGroupLayout: GPUBindGroupLayout | null = null;
  private mipSampler: GPUSampler | null = null;

  constructor(device: GPUDevice, options: TextureRegistryOptions = {}) {
    this.device = device;
    this.maxPagesPerBucket = options.maxPagesPerBucket ?? DEFAULT_MAX_PAGES;
    const devLayers = (device.limits?.maxTextureArrayLayers) ?? DEFAULT_LAYERS_PER_PAGE;
    this.layersPerPage = Math.min(options.layersPerPage ?? DEFAULT_LAYERS_PER_PAGE, devLayers);
    this.maxArrayBindingsPerFormat = options.maxArrayBindingsPerFormat ?? DEFAULT_MAX_ARRAY_BINDINGS;
    this.createDefaultTextures();
  }

  getLayoutVersion(): number {
    return this.layoutVersion;
  }

  getMaxArrayBindingsPerFormat(): number {
    return this.maxArrayBindingsPerFormat;
  }

  /**
   * Register a texture by copying an external GPUTexture into a bucket layer.
   * Returns a stable handle. If the same `sourceId` was registered before,
   * returns the existing handle (idempotent).
   */
  registerFromTexture(sourceId: unknown, src: GPUTexture, key: TextureBucketKey): RegisteredTexture {
    const b = this.getOrCreateBucket(key);
    const existing = b.sources.get(sourceId);
    if (existing) return existing;

    const slot = this.allocSlot(b);
    this.copyTextureIntoLayer(src, b, slot.page, slot.layer, key);
    const reg: RegisteredTexture = {
      handle: (slot.globalArrayIndex << 16) | slot.layer,
      bucketKey: b.keyStr,
      arrayIndex: slot.globalArrayIndex,
      pageIndex: slot.page,
      layerIndex: slot.layer,
    };
    b.sources.set(sourceId, reg);
    return reg;
  }

  /**
   * Register a texture by copying an ImageBitmap into a bucket layer.
   * The bucket is created with the bitmap's dimensions and rgba8unorm format
   * (or the provided key). Returns a stable handle.
   */
  registerFromImageBitmap(
    sourceId: unknown,
    bitmap: ImageBitmap,
    format: GPUTextureFormat = "rgba8unorm",
    mipCount = 1,
    generateMips = false,
  ): RegisteredTexture {
    // If generateMips is requested and mipCount wasn't explicitly set,
    // compute the full mip chain.
    const effectiveMipCount = generateMips && mipCount === 1
      ? Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1
      : mipCount;
    const key: TextureBucketKey = {
      format,
      width: bitmap.width,
      height: bitmap.height,
      mipCount: effectiveMipCount,
      sampleCount: 1,
    };
    const b = this.getOrCreateBucket(key);
    const existing = b.sources.get(sourceId);
    if (existing) return existing;

    const slot = this.allocSlot(b);
    this.copyImageBitmapIntoLayer(bitmap, b, slot.page, slot.layer, key);
    const reg: RegisteredTexture = {
      handle: (slot.globalArrayIndex << 16) | slot.layer,
      bucketKey: b.keyStr,
      arrayIndex: slot.globalArrayIndex,
      pageIndex: slot.page,
      layerIndex: slot.layer,
    };
    b.sources.set(sourceId, reg);
    // Generate mip levels 1..N in-place.
    if (generateMips && effectiveMipCount > 1) {
      this.generateMipmapsForSlot(b, slot.page, slot.layer);
    }
    return reg;
  }

  /** Update an existing registration's pixel data (e.g. async load completion). */
  updateFromImageBitmap(sourceId: unknown, bitmap: ImageBitmap): boolean {
    for (const b of this.buckets.values()) {
      const reg = b.sources.get(sourceId);
      if (!reg) continue;
      if (b.key.width !== bitmap.width || b.key.height !== bitmap.height) {
        log.warn("Bindless", `updateFromImageBitmap dimension mismatch for ${String(sourceId)}: bucket ${b.key.width}x${b.key.height} vs bitmap ${bitmap.width}x${bitmap.height}`);
        return false;
      }
      this.copyImageBitmapIntoLayer(bitmap, b, reg.pageIndex, reg.layerIndex, b.key);
      // Regenerate mips if the bucket has more than 1 mip level.
      if (b.key.mipCount > 1) this.generateMipmapsForSlot(b, reg.pageIndex, reg.layerIndex);
      return true;
    }
    return false;
  }

  /**
   * Generate mip levels 1..N for a registered texture by successively
   * downsampling mip N-1 → mip N with a 2×2 box filter. The bucket page must
   * have been created with mipLevelCount > 1 (i.e. the bucket key's mipCount).
   * Only rgba8unorm is supported (the common case for albedo/normal textures).
   */
  generateMipmaps(sourceId: unknown): boolean {
    for (const b of this.buckets.values()) {
      const reg = b.sources.get(sourceId);
      if (!reg) continue;
      if (b.key.mipCount <= 1) return false; // nothing to do
      this.generateMipmapsForSlot(b, reg.pageIndex, reg.layerIndex);
      return true;
    }
    return false;
  }

  private generateMipmapsForSlot(b: Bucket, page: number, layer: number): void {
    const format = b.key.format;
    const pipeline = this.getMipPipeline(format);
    if (!pipeline) return;
    const tex = b.pages[page];
    const mipCount = b.key.mipCount;
    const sampler = this.getMipSampler();
    const layout = this.mipBindGroupLayout!;

    const encoder = this.device.createCommandEncoder();
    for (let mip = 1; mip < mipCount; mip++) {
      const srcView = tex.createView({
        dimension: "2d-array",
        baseMipLevel: mip - 1,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      });
      const dstView = tex.createView({
        dimension: "2d-array",
        baseMipLevel: mip,
        mipLevelCount: 1,
        baseArrayLayer: layer,
        arrayLayerCount: 1,
      });
      const bg = this.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: sampler },
        ],
      });
      const mw = Math.max(1, b.key.width >> mip);
      const mh = Math.max(1, b.key.height >> mip);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: dstView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.setViewport(0, 0, mw, mh, 0, 1);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private getMipSampler(): GPUSampler {
    if (this.mipSampler) return this.mipSampler;
    this.mipSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    return this.mipSampler;
  }

  private getMipPipeline(format: GPUTextureFormat): GPURenderPipeline | null {
    const existing = this.mipPipelines.get(format);
    if (existing) return existing;
    // Only support color formats for mip generation.
    if (format === "depth32float" || format.startsWith("depth")) return null;
    if (!this.mipBindGroupLayout) {
      this.mipBindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        ],
      });
    }
    const shader = this.device.createShaderModule({
      label: "bindless-mip-blit",
      code: /* wgsl */ `
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@group(0) @binding(0) var srcTex: texture_2d_array<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(srcTex, 0).xy);
  let uv = (pos.xy + 0.5) / dim;
  // 2x2 box filter — sample 4 taps to downsample mip N-1 → mip N.
  let texel = 1.0 / dim;
  let c00 = textureSample(srcTex, srcSampler, uv + vec2f(-0.5, -0.5) * texel, 0u);
  let c10 = textureSample(srcTex, srcSampler, uv + vec2f( 0.5, -0.5) * texel, 0u);
  let c01 = textureSample(srcTex, srcSampler, uv + vec2f(-0.5,  0.5) * texel, 0u);
  let c11 = textureSample(srcTex, srcSampler, uv + vec2f( 0.5,  0.5) * texel, 0u);
  return (c00 + c10 + c01 + c11) * 0.25;
}
`,
    });
    const pipeline = this.device.createRenderPipeline({
      label: `bindless-mip-${format}`,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.mipBindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs" },
      fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.mipPipelines.set(format, pipeline);
    return pipeline;
  }

  /** Update an existing registration from an external GPUTexture. */
  updateFromTexture(sourceId: unknown, src: GPUTexture): boolean {
    for (const b of this.buckets.values()) {
      const reg = b.sources.get(sourceId);
      if (!reg) continue;
      this.copyTextureIntoLayer(src, b, reg.pageIndex, reg.layerIndex, b.key);
      return true;
    }
    return false;
  }

  /** Look up an existing registration by sourceId (returns undefined if absent). */
  getRegistration(sourceId: unknown): RegisteredTexture | undefined {
    for (const b of this.buckets.values()) {
      const reg = b.sources.get(sourceId);
      if (reg) return reg;
    }
    return undefined;
  }

  /** Convenience: return the packed handle for a sourceId, or undefined. */
  getHandle(sourceId: unknown): number | undefined {
    return this.getRegistration(sourceId)?.handle;
  }

  /** Unregister a texture by sourceId; returns its slot to the bucket free list. */
  unregister(sourceId: unknown): boolean {
    for (const b of this.buckets.values()) {
      const reg = b.sources.get(sourceId);
      if (!reg) continue;
      b.sources.delete(sourceId);
      b.freeList.push({ page: reg.pageIndex, layer: reg.layerIndex });
      return true;
    }
    return false;
  }

  /**
   * Get the array texture views for a bucket key, for bind-group construction.
   * Returns one GPUTextureView (dimension "2d-array") per page, padded with
   * null entries up to maxArrayBindingsPerFormat.
   */
  getArrayViews(key: TextureBucketKey): (GPUTextureView | null)[] {
    const b = this.buckets.get(bucketKey(key));
    const out: (GPUTextureView | null)[] = new Array(this.maxArrayBindingsPerFormat).fill(null);
    if (!b) return out;
    for (let i = 0; i < b.pages.length && i < this.maxArrayBindingsPerFormat; i++) {
      out[i] = b.pages[i].createView({ dimension: "2d-array" });
    }
    return out;
  }

  /** All bucket keys currently allocated (for bind-group construction). */
  getBucketKeys(): TextureBucketKey[] {
    return Array.from(this.buckets.values()).map((b) => b.key);
  }

  /**
   * Returns a flat list of all page views across ALL buckets, in bucket-then-page
   * order. Each view is dimension "2d-array". Padded with nulls up to
   * maxArrayBindingsPerFormat total entries. This is what the bind group binds:
   * binding 1 = flat[0], binding 2 = flat[1], etc.
   *
   * The handle's `arrayIndex` field is the global flat index (see allocSlot).
   */
  getAllArrayViewsFlat(): (GPUTextureView | null)[] {
    const out: (GPUTextureView | null)[] = new Array(this.maxArrayBindingsPerFormat).fill(null);
    for (const b of this.buckets.values()) {
      for (let i = 0; i < b.pages.length; i++) {
        const gidx = b.globalArrayIndices[i];
        if (gidx < this.maxArrayBindingsPerFormat) {
          out[gidx] = b.pages[i].createView({ dimension: "2d-array" });
        }
      }
    }
    return out;
  }

  /** Total layers in use across all buckets (telemetry / debugging). */
  getTotalLayersInUse(): number {
    let total = 0;
    for (const b of this.buckets.values()) {
      for (const c of b.layerCursor) total += c;
      total -= b.freeList.length;
    }
    return total;
  }

  destroy(): void {
    for (const b of this.buckets.values()) {
      for (const t of b.pages) t.destroy();
    }
    this.buckets.clear();
  }

  // ── internal ──────────────────────────────────────────────────────────

  private createDefaultTextures(): void {
    // Default white 1x1 rgba8unorm — layer 0 of the default bucket.
    const key: TextureBucketKey = {
      format: "rgba8unorm",
      width: 1,
      height: 1,
      mipCount: 1,
      sampleCount: 1,
    };
    const b = this.getOrCreateBucket(key);
    const whiteSlot = this.allocSlot(b);
    const whiteData = new Uint8Array([255, 255, 255, 255]);
    this.device.queue.writeTexture(
      { texture: b.pages[whiteSlot.page], origin: [0, 0, whiteSlot.layer], mipLevel: 0 },
      whiteData,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this.defaultWhiteHandle = (whiteSlot.globalArrayIndex << 16) | whiteSlot.layer;
    b.sources.set("__default_white__", {
      handle: this.defaultWhiteHandle,
      bucketKey: b.keyStr,
      arrayIndex: whiteSlot.globalArrayIndex,
      pageIndex: whiteSlot.page,
      layerIndex: whiteSlot.layer,
    });

    // Default black 1x1 rgba8unorm.
    const blackSlot = this.allocSlot(b);
    const blackData = new Uint8Array([0, 0, 0, 255]);
    this.device.queue.writeTexture(
      { texture: b.pages[blackSlot.page], origin: [0, 0, blackSlot.layer], mipLevel: 0 },
      blackData,
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this.defaultBlackHandle = (blackSlot.globalArrayIndex << 16) | blackSlot.layer;
    b.sources.set("__default_black__", {
      handle: this.defaultBlackHandle,
      bucketKey: b.keyStr,
      arrayIndex: blackSlot.globalArrayIndex,
      pageIndex: blackSlot.page,
      layerIndex: blackSlot.layer,
    });
  }

  private getOrCreateBucket(key: TextureBucketKey): Bucket {
    const keyStr = bucketKey(key);
    let b = this.buckets.get(keyStr);
    if (!b) {
      b = {
        key,
        keyStr,
        pages: [],
        globalArrayIndices: [],
        layerCursor: [],
        freeList: [],
        sources: new Map(),
      };
      this.buckets.set(keyStr, b);
      this.appendPage(b);
    }
    return b;
  }

  private appendPage(b: Bucket): void {
    if (b.pages.length >= this.maxPagesPerBucket) {
      log.error("Bindless", `bucket ${b.keyStr} exhausted maxPages=${this.maxPagesPerBucket}; texture registration failed`);
      throw new Error(`BindlessTextureRegistry: bucket ${b.keyStr} full (maxPages=${this.maxPagesPerBucket})`);
    }
    const tex = this.device.createTexture({
      size: [b.key.width, b.key.height, this.layersPerPage],
      format: b.key.format,
      usage: TEXTURE_BINDING_USAGE | COPY_DST_USAGE | COPY_SRC_USAGE | RENDER_ATTACHMENT_USAGE,
      mipLevelCount: b.key.mipCount,
      sampleCount: b.key.sampleCount,
      label: `bindless_${b.keyStr}_page${b.pages.length}`,
    });
    b.pages.push(tex);
    b.layerCursor.push(0);
    b.globalArrayIndices.push(this.nextGlobalArrayIndex++);
    this.layoutVersion++;
  }

  private allocSlot(b: Bucket): { page: number; layer: number; globalArrayIndex: number } {
    let slot!: { page: number; layer: number; globalArrayIndex: number };
    if (b.freeList.length > 0) {
      const free = b.freeList.pop()!;
      slot = { ...free, globalArrayIndex: b.globalArrayIndices[free.page] };
    } else {
      // Find a page with a free layer.
      let allocated = false;
      for (let p = 0; p < b.layerCursor.length; p++) {
        if (b.layerCursor[p] < this.layersPerPage) {
          const layer = b.layerCursor[p];
          b.layerCursor[p] = layer + 1;
          slot = { page: p, layer, globalArrayIndex: b.globalArrayIndices[p] };
          allocated = true;
          break;
        }
      }
      if (!allocated) {
        // All pages full — append a new one and allocate from it.
        this.appendPage(b);
        const page = b.layerCursor.length - 1;
        b.layerCursor[page] = 1;
        slot = { page, layer: 0, globalArrayIndex: b.globalArrayIndices[page] };
      }
    }
    // Validate that layer and globalArrayIndex fit in the 16-bit handle fields.
    // The handle packs (globalArrayIndex << 16) | layer; overflow corrupts sampling.
    const { layer, globalArrayIndex } = slot;
    if (layer < 0 || layer > 0xFFFF) {
      throw new Error(
        `BindlessTextureRegistry: layer index ${layer} exceeds 16-bit handle field (max 65535) for bucket ${b.keyStr}`,
      );
    }
    if (globalArrayIndex < 0 || globalArrayIndex > 0xFFFF) {
      throw new Error(
        `BindlessTextureRegistry: global array index ${globalArrayIndex} exceeds 16-bit handle field (max 65535) for bucket ${b.keyStr}`,
      );
    }
    return slot;
  }

  private copyTextureIntoLayer(
    src: GPUTexture,
    b: Bucket,
    page: number,
    layer: number,
    key: TextureBucketKey,
  ): void {
    const dst = b.pages[page];
    const encoder = this.device.createCommandEncoder();
    for (let mip = 0; mip < key.mipCount; mip++) {
      encoder.copyTextureToTexture(
        { texture: src, mipLevel: mip, origin: [0, 0, 0] },
        { texture: dst, mipLevel: mip, origin: [0, 0, layer] },
        { width: key.width >> mip, height: key.height >> mip, depthOrArrayLayers: 1 },
      );
    }
    this.device.queue.submit([encoder.finish()]);
  }

  private copyImageBitmapIntoLayer(
    bitmap: ImageBitmap,
    b: Bucket,
    page: number,
    layer: number,
    key: TextureBucketKey,
  ): void {
    const dst = b.pages[page];
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: dst, origin: [0, 0, layer], mipLevel: 0 },
      { width: key.width, height: key.height },
    );
    // NOTE: only mip 0 is uploaded from the bitmap; mip generation is the
    // caller's responsibility (most material textures are mip-less or
    // pre-mipped and copied via registerFromTexture).
  }
}

export { bucketKey as computeBucketKey };
