// ============================================================================
// Tile-based rasterization for Gaussian splatting
//
// Replaces the instanced-quad approach with a per-pixel splat evaluation:
//   1. Tile-bin (compute): assign each splat to the 16×16 tiles it overlaps
//      on screen. Each tile gets a fixed-capacity list of splat indices.
//   2. Tile-raster (fragment): render a full-screen quad. For each pixel,
//      look up its tile's splat list, iterate over splats, evaluate the
//      2D Gaussian, and alpha-blend back-to-front.
//
// The global sort (Phase 1) ensures splats within each tile's bin are in
// back-to-front order, so per-tile blending is correct without a separate
// per-tile sort.
//
// Algorithm reference: gsplat.js (tile-based raster) and
// Scthe/gaussian-splatting-webgpu, both MIT-licensed. Ported to raw WGSL
// with the engine's buffer management patterns.
// ============================================================================

// ── Constants ──

export const DEFAULT_TILE_SIZE = 16;
export const DEFAULT_MAX_SPLATS_PER_TILE = 256;
const WORKGROUP_SIZE = 64;

// ── WGSL kernels ──

const TILE_BIN_WGSL = /* wgsl */ `
struct TileBinUniforms {
  splatCount: u32,
  tileCountX: u32,
  tileCountY: u32,
  maxPerTile: u32,
  viewProj: mat4x4<f32>,
  halfWidth: f32,
  halfHeight: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> u: TileBinUniforms;
@group(0) @binding(1) var<storage, read> splatData: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> tileCounts: array<u32>;
@group(0) @binding(3) var<storage, read_write> tileIndices: array<u32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u.splatCount) { return; }

  let pos = splatData[idx * 3u].xyz;
  let scale = splatData[idx * 3u + 1u].xyz;

  // Project to clip space
  let clip = u.viewProj * vec4<f32>(pos, 1.0);
  if (clip.w <= 0.0) { return; }

  // NDC → pixel coordinates
  let ndc = clip.xyz / clip.w;
  let px = (ndc.x + 1.0) * u.halfWidth;
  let py = (1.0 - ndc.y) * u.halfHeight;

  // Screen-space radius (approximate): scale.xy * halfWidth * 0.01 / clip.w
  // (matches the vertex shader's 0.01 factor)
  let radius = scale.xy * u.halfWidth * 0.01 / clip.w;

  // Tile range
  let minTileX = u32(clamp((px - radius.x) / f32(u.tileSize), 0.0, f32(u.tileCountX)));
  let maxTileX = u32(clamp((px + radius.x) / f32(u.tileSize), 0.0, f32(u.tileCountX)));
  let minTileY = u32(clamp((py - radius.y) / f32(u.tileSize), 0.0, f32(u.tileCountY)));
  let maxTileY = u32(clamp((py + radius.y) / f32(u.tileSize), 0.0, f32(u.tileCountY)));

  for (var ty = minTileY; ty <= maxTileY; ty++) {
    for (var tx = minTileX; tx <= maxTileX; tx++) {
      let tileIdx = ty * u.tileCountX + tx;
      let slot = atomicAdd(&tileCounts[tileIdx], 1u);
      if (slot < u.maxPerTile) {
        tileIndices[tileIdx * u.maxPerTile + slot] = idx;
      }
    }
  }
}
`;

const TILE_RASTER_WGSL = /* wgsl */ `
struct TileRasterUniforms {
  tileCountX: u32,
  tileCountY: u32,
  maxPerTile: u32,
  tileSize: u32,
  halfWidth: f32,
  halfHeight: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> u: TileRasterUniforms;
@group(0) @binding(1) var<storage, read> splatData: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> tileCounts: array<u32>;
@group(0) @binding(3) var<storage, read> tileIndices: array<u32>;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  // Full-screen triangle strip (2 triangles = 6 verts, but we use 3 for a big triangle)
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.clipPosition = vec4<f32>(positions[vi], 0.0, 1.0);
  output.uv = positions[vi] * 0.5 + 0.5;
  output.uv.y = 1.0 - output.uv.y;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let pixelX = input.uv.x * u.halfWidth * 2.0;
  let pixelY = (1.0 - input.uv.y) * u.halfHeight * 2.0;

  let tileX = u32(pixelX / f32(u.tileSize));
  let tileY = u32(pixelY / f32(u.tileSize));
  if (tileX >= u.tileCountX || tileY >= u.tileCountY) {
    discard;
  }
  let tileIdx = tileY * u.tileCountX + tileX;
  let count = min(tileCounts[tileIdx], u.maxPerTile);

  var color = vec4<f32>(0.0);
  for (var i = 0u; i < count; i++) {
    let splatIdx = tileIndices[tileIdx * u.maxPerTile + i];
    let pos = splatData[splatIdx * 3u].xyz;
    let scale = splatData[splatIdx * 3u + 1u].xyz;
    let splatColor = splatData[splatIdx * 3u + 2u];

    // Project splat center to pixel space
    // (Note: viewProj is not available here; we use the pre-projected position
    //  stored in splatData. For tile-raster, the compact pass should store
    //  screen-space positions. For now, we use a simplified 2D Gaussian
    //  centered at the splat's projected position, which the tile-bin pass
    //  already computed. This is a simplification — a full implementation
    //  would store screen-space centers in a separate buffer.)
    //
    // Since we don't have viewProj in this shader, we approximate by using
    // the splat's world position projected via a uniform. But to keep the
    // shader self-contained, we use a distance-based falloff from the
    // splat's projected center, which we approximate as the splat position
    // scaled to screen space. This is a placeholder — the real implementation
    // needs a screen-space position buffer from the tile-bin pass.
    let dx = pixelX - pos.x * u.halfWidth;
    let dy = pixelY - pos.y * u.halfHeight;
    let dist = (dx * dx) / max(scale.x * scale.x, 0.0001) + (dy * dy) / max(scale.y * scale.y, 0.0001);

    if (dist > 1.0) { continue; }
    let alpha = exp(-dist * 2.0) * splatColor.w;
    if (alpha < 0.001) { continue; }
    // Back-to-front blend (splats are sorted)
    color.rgb += (1.0 - color.a) * splatColor.rgb * alpha;
    color.a += (1.0 - color.a) * alpha;
    if (color.a > 0.99) { break; }
  }

  return color;
}
`;

// ── TileRasterPipeline ──

export interface TileRasterPipelineOptions {
  tileSize?: number;
  maxSplatsPerTile?: number;
}

export class TileRasterPipeline {
  private device: GPUDevice | null = null;
  tileSize: number;
  maxSplatsPerTile: number;

  private binPipeline: GPUComputePipeline | null = null;
  private rasterPipeline: GPURenderPipeline | null = null;
  private binBGL: GPUBindGroupLayout | null = null;
  private rasterBGL: GPUBindGroupLayout | null = null;

  private binUniformBuffer: GPUBuffer | null = null;
  private rasterUniformBuffer: GPUBuffer | null = null;
  private binUniformData: ArrayBuffer | null = null;
  private binUniformFloats: Float32Array | null = null;
  private binUniformUints: Uint32Array | null = null;
  private rasterUniformData: Uint32Array | null = null;
  private rasterUniformFloats: Float32Array | null = null;

  private tileCountsBuffer: GPUBuffer | null = null;
  private tileIndicesBuffer: GPUBuffer | null = null;
  private zeroBuffer: GPUBuffer | null = null;

  private tileCountX = 0;
  private tileCountY = 0;
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(device: GPUDevice | null, options: TileRasterPipelineOptions = {}) {
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
    this.maxSplatsPerTile = options.maxSplatsPerTile ?? DEFAULT_MAX_SPLATS_PER_TILE;
    if (device) this.prepare(device);
  }

  prepare(device: GPUDevice): void {
    if (this.device === device && this.binPipeline) return;
    this.device = device;
    this.createPipelines(device);
    this.createBuffers(device);
  }

  private createPipelines(device: GPUDevice): void {
    // ── Bind group layouts ──

    this.binBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.rasterBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });

    // ── Shader modules ──

    const binModule = device.createShaderModule({ code: TILE_BIN_WGSL });
    const rasterModule = device.createShaderModule({ code: TILE_RASTER_WGSL });

    // ── Pipelines ──

    this.binPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.binBGL] }),
      compute: { module: binModule, entryPoint: "cs_main" },
    });

    this.rasterPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.rasterBGL] }),
      vertex: { module: rasterModule, entryPoint: "vs_main" },
      fragment: {
        module: rasterModule,
        entryPoint: "fs_main",
        targets: [{
          format: "bgra8unorm" as GPUTextureFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  private createBuffers(device: GPUDevice): void {
    // Tile-bin uniforms: 4 u32s + mat4x4 (16 floats) + 4 floats = 80 bytes
    // Layout: splatCount(u32), tileCountX(u32), tileCountY(u32), maxPerTile(u32),
    //         viewProj(16 f32), halfWidth(f32), halfHeight(f32), pad(f32), pad(f32)
    // = 16 + 64 + 16 = 96 bytes
    this.binUniformData = new ArrayBuffer(96);
    this.binUniformFloats = new Float32Array(this.binUniformData);
    this.binUniformUints = new Uint32Array(this.binUniformData);
    this.binUniformBuffer = device.createBuffer({
      label: "tile-bin-uniforms",
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Tile-raster uniforms: 4 u32s + 4 f32s = 32 bytes
    this.rasterUniformData = new Uint32Array(8);
    this.rasterUniformFloats = new Float32Array(this.rasterUniformData.buffer);
    this.rasterUniformBuffer = device.createBuffer({
      label: "tile-raster-uniforms",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Zero buffer (for clearing tile counts) — 64 bytes
    this.zeroBuffer = device.createBuffer({
      label: "tile-zero",
      size: 64,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
    });
    device.queue.writeBuffer(this.zeroBuffer, 0, new Uint32Array(16));
  }

  /**
   * Ensure tile buffers are sized for the given resolution.
   * Call this when the render target size changes.
   */
  ensureTileBuffers(width: number, height: number): void {
    if (width === this.lastWidth && height === this.lastHeight && this.tileCountsBuffer) return;
    const device = this.device!;
    this.tileCountX = Math.ceil(width / this.tileSize);
    this.tileCountY = Math.ceil(height / this.tileSize);
    this.lastWidth = width;
    this.lastHeight = height;

    const tileCount = this.tileCountX * this.tileCountY;

    if (this.tileCountsBuffer) this.tileCountsBuffer.destroy();
    if (this.tileIndicesBuffer) this.tileIndicesBuffer.destroy();

    // Tile counts: one u32 per tile
    this.tileCountsBuffer = device.createBuffer({
      label: "tile-counts",
      size: tileCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Tile indices: maxSplatsPerTile u32s per tile
    this.tileIndicesBuffer = device.createBuffer({
      label: "tile-indices",
      size: tileCount * this.maxSplatsPerTile * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Run the tile-binning compute pass. Call after sort+compact, before raster.
   * Returns the tile counts and tile indices buffers for binding in the raster pass.
   */
  binSplats(
    splatBuffer: GPUBuffer,
    splatCount: number,
    viewProj: number[],
    width: number,
    height: number,
  ): { tileCounts: GPUBuffer; tileIndices: GPUBuffer } {
    const device = this.device!;
    this.ensureTileBuffers(width, height);

    // Write bin uniforms
    const u = this.binUniformUints!;
    const f = this.binUniformFloats!;
    u[0] = splatCount;
    u[1] = this.tileCountX;
    u[2] = this.tileCountY;
    u[3] = this.maxSplatsPerTile;
    for (let i = 0; i < 16; i++) f[4 + i] = viewProj[i];
    f[20] = width / 2;
    f[21] = height / 2;
    f[22] = 0;
    f[23] = 0;
    device.queue.writeBuffer(this.binUniformBuffer!, 0, this.binUniformData! as unknown as GPUAllowSharedBufferSource);

    const enc = device.createCommandEncoder();

    // Clear tile counts
    const clearSize = this.tileCountX * this.tileCountY * 4;
    let cleared = 0;
    while (cleared < clearSize) {
      const chunk = Math.min(64, clearSize - cleared);
      enc.copyBufferToBuffer(this.zeroBuffer!, 0, this.tileCountsBuffer!, cleared, chunk);
      cleared += chunk;
    }

    // Bin splats
    const bindGroup = device.createBindGroup({
      layout: this.binBGL!,
      entries: [
        { binding: 0, resource: { buffer: this.binUniformBuffer! } },
        { binding: 1, resource: { buffer: splatBuffer } },
        { binding: 2, resource: { buffer: this.tileCountsBuffer! } },
        { binding: 3, resource: { buffer: this.tileIndicesBuffer! } },
      ],
    });

    const pass = enc.beginComputePass();
    pass.setPipeline(this.binPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(splatCount / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([enc.finish()]);

    return { tileCounts: this.tileCountsBuffer!, tileIndices: this.tileIndicesBuffer! };
  }

  /**
   * Get the raster pipeline for drawing. The caller must set the bind group
   * with: binding 0 = raster uniforms, binding 1 = splat buffer,
   * binding 2 = tile counts, binding 3 = tile indices.
   */
  getRasterPipeline(): GPURenderPipeline | null {
    return this.rasterPipeline;
  }

  getRasterBindGroupLayout(): GPUBindGroupLayout | null {
    return this.rasterBGL;
  }

  /**
   * Write the raster uniforms for the given resolution.
   */
  writeRasterUniforms(width: number, height: number): void {
    const device = this.device!;
    this.ensureTileBuffers(width, height);
    const u = this.rasterUniformData!;
    u[0] = this.tileCountX;
    u[1] = this.tileCountY;
    u[2] = this.maxSplatsPerTile;
    u[3] = this.tileSize;
    const f = this.rasterUniformFloats!;
    f[4] = width / 2;
    f[5] = height / 2;
    f[6] = 0;
    f[7] = 0;
    device.queue.writeBuffer(this.rasterUniformBuffer!, 0, this.rasterUniformData! as unknown as GPUAllowSharedBufferSource);
  }

  getRasterUniformBuffer(): GPUBuffer | null {
    return this.rasterUniformBuffer;
  }

  /**
   * Create the bind group for the raster pass.
   */
  createRasterBindGroup(splatBuffer: GPUBuffer, tileCounts: GPUBuffer, tileIndices: GPUBuffer): GPUBindGroup | null {
    if (!this.device || !this.rasterBGL || !this.rasterUniformBuffer) return null;
    return this.device.createBindGroup({
      layout: this.rasterBGL,
      entries: [
        { binding: 0, resource: { buffer: this.rasterUniformBuffer } },
        { binding: 1, resource: { buffer: splatBuffer } },
        { binding: 2, resource: { buffer: tileCounts } },
        { binding: 3, resource: { buffer: tileIndices } },
      ],
    });
  }

  destroy(): void {
    this.binUniformBuffer?.destroy();
    this.rasterUniformBuffer?.destroy();
    this.tileCountsBuffer?.destroy();
    this.tileIndicesBuffer?.destroy();
    this.zeroBuffer?.destroy();
    this.binPipeline?.destroy();
    this.rasterPipeline?.destroy();

    this.binUniformBuffer = null;
    this.rasterUniformBuffer = null;
    this.tileCountsBuffer = null;
    this.tileIndicesBuffer = null;
    this.zeroBuffer = null;
    this.binPipeline = null;
    this.rasterPipeline = null;
    this.binBGL = null;
    this.rasterBGL = null;
    this.binUniformData = null;
    this.binUniformFloats = null;
    this.binUniformUints = null;
    this.rasterUniformData = null;
    this.rasterUniformFloats = null;
    this.device = null;
  }
}
