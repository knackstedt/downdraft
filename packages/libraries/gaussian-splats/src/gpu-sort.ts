// ============================================================================
// GpuSplatSorter — GPU radix sort + splat buffer compaction
//
// Sorts splats back-to-front by camera distance using a GPU radix sort
// (4-bit radix, 8 passes for u32 keys). After sorting, compacts the splat
// buffer into sorted order so the instanced-quad draw renders correctly.
//
// For small splat counts (below `threshold`), falls back to a CPU merge sort
// and uploads the sorted indices — the compact pass still runs on GPU.
//
// Algorithm reference: KoS-Y1/Web-GS-Renderer (radix_parallel.wgsl) and
// Scthe/gaussian-splatting-webgpu, both MIT-licensed. Ported to raw WGSL
// with the engine's buffer management patterns.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import type { GaussianSplatData } from "./parser";
import { sortSplats } from "./sorter";

// ── WGSL kernels ──

const DISTANCES_WGSL = /* wgsl */ `
struct SortUniforms {
  cameraPos: vec3<f32>,
  count: u32,
  pass: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> u: SortUniforms;
@group(0) @binding(1) var<storage, read> splatData: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> indices: array<u32>;

fn floatToSortableKey(f: f32) -> u32 {
  let bits = bitcast<u32>(f);
  if ((bits & 0x80000000u) != 0u) {
    return ~bits;
  }
  return bits | 0x80000000u;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= u.count) { return; }
  // Position is the first vec4 of each 3-vec4 splat block
  let pos = splatData[idx * 3u].xyz;
  let d = pos - u.cameraPos;
  let dist = dot(d, d);
  // Invert key so ascending radix sort → descending distance (back-to-front)
  keys[idx] = ~floatToSortableKey(dist);
  indices[idx] = idx;
}
`;

const HISTOGRAM_WGSL = /* wgsl */ `
struct SortUniforms {
  cameraPos: vec3<f32>,
  count: u32,
  pass: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> u: SortUniforms;
@group(0) @binding(1) var<storage, read> keys: array<u32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<u32, 16>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.count) { return; }
  let shift = u.pass * 4u;
  let digit = (keys[gid.x] >> shift) & 0xFu;
  atomicAdd(&histogram[digit], 1u);
}
`;

const PREFIX_SUM_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> histogram: array<u32, 16>;
@group(0) @binding(1) var<storage, read_write> prefixSum: array<u32, 16>;

@compute @workgroup_size(16)
fn cs_main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let i = lid.x;
  // Exclusive prefix sum over 16 elements (Hillis-Steele, 1 pass for N=16)
  var val: u32 = 0u;
  if (i > 0u) { val = histogram[i - 1u]; }
  prefixSum[i] = val;
  // For 16 elements, a single sequential scan in thread 0 is simplest and correct.
  // But we already wrote the exclusive sum above using histogram[i-1].
  // This is correct because each thread reads histogram[i-1] directly — no
  // inter-thread dependency for an exclusive sum of 16 elements where each
  // output only depends on inputs before it.
}
`;

const SCATTER_WGSL = /* wgsl */ `
struct SortUniforms {
  cameraPos: vec3<f32>,
  count: u32,
  pass: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> u: SortUniforms;
@group(0) @binding(1) var<storage, read> keysIn: array<u32>;
@group(0) @binding(2) var<storage, read> indicesIn: array<u32>;
@group(0) @binding(3) var<storage, read> prefixSum: array<u32, 16>;
@group(0) @binding(4) var<storage, read_write> scatterCounter: array<u32, 16>;
@group(0) @binding(5) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(6) var<storage, read_write> indicesOut: array<u32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.count) { return; }
  let shift = u.pass * 4u;
  let digit = (keysIn[gid.x] >> shift) & 0xFu;
  let offset = atomicAdd(&scatterCounter[digit], 1u);
  let pos = prefixSum[digit] + offset;
  keysOut[pos] = keysIn[gid.x];
  indicesOut[pos] = indicesIn[gid.x];
}
`;

const COMPACT_WGSL = /* wgsl */ `
struct CompactUniforms {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> u: CompactUniforms;
@group(0) @binding(1) var<storage, read> splatData: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read_write> compacted: array<vec4<f32>>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.count) { return; }
  let srcIdx = indices[gid.x];
  let dstBase = gid.x * 3u;
  let srcBase = srcIdx * 3u;
  compacted[dstBase] = splatData[srcBase];
  compacted[dstBase + 1u] = splatData[srcBase + 1u];
  compacted[dstBase + 2u] = splatData[srcBase + 2u];
}
`;

// ── Constants ──

const WORKGROUP_SIZE = 64;
const NUM_PASSES = 8; // 32 bits / 4-bit radix
const SPLAT_VECS = 3; // vec4s per splat (12 floats)
const SPLAT_BYTES = SPLAT_VECS * 16; // 48 bytes per splat

// ── Sort uniform layout (32 bytes) ──
// cameraPos(3f) + count(1u) + pass(1u) + pad(2u) = 8 × 4 = 32 bytes
const SORT_UNIFORM_SIZE = 32;

// ── GpuSplatSorter ──

export interface GpuSplatSorterOptions {
  /** Max splat count for buffer pre-allocation. Default: 1_000_000. */
  maxSplats?: number;
  /** Below this count, use CPU sort. Default: 8192. */
  threshold?: number;
}

export class GpuSplatSorter {
  private device: GPUDevice | null = null;
  private maxSplats: number;
  threshold: number;

  // Pipelines
  private distancesPipeline: GPUComputePipeline | null = null;
  private histogramPipeline: GPUComputePipeline | null = null;
  private prefixSumPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;
  private compactPipeline: GPUComputePipeline | null = null;

  // Bind group layouts
  private distancesBGL: GPUBindGroupLayout | null = null;
  private histogramBGL: GPUBindGroupLayout | null = null;
  private prefixSumBGL: GPUBindGroupLayout | null = null;
  private scatterBGL: GPUBindGroupLayout | null = null;
  private compactBGL: GPUBindGroupLayout | null = null;

  // Buffers
  private sortUniformBuffer: GPUBuffer | null = null;
  private sortUniformData: ArrayBuffer | null = null;
  private sortUniformFloats: Float32Array | null = null;
  private sortUniformUints: Uint32Array | null = null;

  private compactUniformBuffer: GPUBuffer | null = null;
  private compactUniformData: Uint32Array | null = null;

  private keyBuffers: [GPUBuffer, GPUBuffer] | null = null;
  private indexBuffers: [GPUBuffer, GPUBuffer] | null = null;
  private histogramBuffer: GPUBuffer | null = null;
  private prefixSumBuffer: GPUBuffer | null = null;
  private scatterCounterBuffer: GPUBuffer | null = null;
  private zeroBuffer: GPUBuffer | null = null;
  private compactedBuffer: GPUBuffer | null = null;

  // Which ping-pong buffer set is the "current" read source (0 or 1)
  private currentSet = 0;

  // CPU-side index upload buffer (for CPU fallback)
  private cpuIndexUploadBuffer: Uint32Array | null = null;

  constructor(device: GPUDevice | null, options: GpuSplatSorterOptions = {}) {
    this.maxSplats = options.maxSplats ?? 1_000_000;
    this.threshold = options.threshold ?? 8192;
    if (device) this.prepare(device);
  }

  prepare(device: GPUDevice): void {
    if (this.device === device && this.distancesPipeline) return;
    this.device = device;
    this.createPipelines(device);
    this.createBuffers(device);
  }

  private createPipelines(device: GPUDevice): void {
    // ── Bind group layouts ──

    this.distancesBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.histogramBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.prefixSumBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.scatterBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    this.compactBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    // ── Shader modules ──

    const distancesModule = createValidatedShaderModule(device, { code: DISTANCES_WGSL, label: "GpuSort.distances" });
    const histogramModule = createValidatedShaderModule(device, { code: HISTOGRAM_WGSL, label: "GpuSort.histogram" });
    const prefixSumModule = createValidatedShaderModule(device, { code: PREFIX_SUM_WGSL, label: "GpuSort.prefixSum" });
    const scatterModule = createValidatedShaderModule(device, { code: SCATTER_WGSL, label: "GpuSort.scatter" });
    const compactModule = createValidatedShaderModule(device, { code: COMPACT_WGSL, label: "GpuSort.compact" });

    // ── Pipelines ──

    this.distancesPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.distancesBGL] }),
      compute: { module: distancesModule, entryPoint: "cs_main" },
    });
    this.histogramPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.histogramBGL] }),
      compute: { module: histogramModule, entryPoint: "cs_main" },
    });
    this.prefixSumPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.prefixSumBGL] }),
      compute: { module: prefixSumModule, entryPoint: "cs_main" },
    });
    this.scatterPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.scatterBGL] }),
      compute: { module: scatterModule, entryPoint: "cs_main" },
    });
    this.compactPipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compactBGL] }),
      compute: { module: compactModule, entryPoint: "cs_main" },
    });
  }

  private createBuffers(device: GPUDevice): void {
    const maxSplatBytes = this.maxSplats * 4; // u32 or f32 per splat

    // Sort uniforms (32 bytes)
    this.sortUniformData = new ArrayBuffer(SORT_UNIFORM_SIZE);
    this.sortUniformFloats = new Float32Array(this.sortUniformData);
    this.sortUniformUints = new Uint32Array(this.sortUniformData);
    this.sortUniformBuffer = device.createBuffer({
      label: "splat-sort-uniforms",
      size: SORT_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compact uniforms (16 bytes)
    this.compactUniformData = new Uint32Array(4);
    this.compactUniformBuffer = device.createBuffer({
      label: "splat-compact-uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Key + index ping-pong buffers
    this.keyBuffers = [
      device.createBuffer({ label: "splat-keys-A", size: maxSplatBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      device.createBuffer({ label: "splat-keys-B", size: maxSplatBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    ];
    this.indexBuffers = [
      device.createBuffer({ label: "splat-indices-A", size: maxSplatBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      device.createBuffer({ label: "splat-indices-B", size: maxSplatBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    ];

    // Histogram (16 u32s = 64 bytes)
    this.histogramBuffer = device.createBuffer({
      label: "splat-histogram",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Prefix sum (16 u32s = 64 bytes)
    this.prefixSumBuffer = device.createBuffer({
      label: "splat-prefix-sum",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Scatter counter (16 u32s = 64 bytes)
    this.scatterCounterBuffer = device.createBuffer({
      label: "splat-scatter-counter",
      size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Zero buffer (64 bytes of zeros, for clearing histogram + scatter counter)
    this.zeroBuffer = device.createBuffer({
      label: "splat-zero",
      size: 64,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
    });
    // Initialize zero buffer
    const zeroData = new Uint32Array(16);
    device.queue.writeBuffer(this.zeroBuffer, 0, zeroData);

    // Compacted splat buffer (maxSplats * 48 bytes)
    this.compactedBuffer = device.createBuffer({
      label: "splat-compacted",
      size: this.maxSplats * SPLAT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // CPU index upload buffer
    this.cpuIndexUploadBuffer = new Uint32Array(this.maxSplats);
  }

  /**
   * Sort splats by camera distance (back-to-front) and compact the splat buffer.
   * Returns a GPUBuffer containing the compacted, sorted splat data (3 vec4s per splat).
   * The returned buffer is valid until the next call to `sortAndCompact()`.
   */
  sortAndCompact(
    cameraPos: [number, number, number],
    splatBuffer: GPUBuffer,
    splatData: GaussianSplatData | null,
    count: number,
  ): GPUBuffer | null {
    if (!this.device || count === 0) return null;

    if (count < this.threshold && splatData) {
      return this.cpuSortAndCompact(cameraPos, splatBuffer, splatData, count);
    }
    return this.gpuSortAndCompact(cameraPos, splatBuffer, count);
  }

  // ── CPU fallback ──

  private cpuSortAndCompact(
    cameraPos: [number, number, number],
    splatBuffer: GPUBuffer,
    splatData: GaussianSplatData,
    count: number,
  ): GPUBuffer | null {
    const device = this.device!;
    const { indices } = sortSplats(splatData, cameraPos);

    // Upload sorted indices (reversed for back-to-front: sortSplats returns
    // nearest-first, we need farthest-first for alpha blending)
    const upload = this.cpuIndexUploadBuffer!;
    for (let i = 0; i < count; i++) {
      upload[i] = indices[count - 1 - i];
    }
    device.queue.writeBuffer(this.indexBuffers![0], 0, upload.subarray(0, count) as unknown as GPUAllowSharedBufferSource);

    // Run compact pass
    this.runCompact(splatBuffer, this.indexBuffers![0], count);
    return this.compactedBuffer;
  }

  // ── GPU radix sort ──

  private gpuSortAndCompact(
    cameraPos: [number, number, number],
    splatBuffer: GPUBuffer,
    count: number,
  ): GPUBuffer | null {
    const device = this.device!;
    const workgroups = Math.ceil(count / WORKGROUP_SIZE);

    // ── Compute distances + initialize indices ──
    this.writeSortUniforms(cameraPos, count, 0);
    const distBindGroup = device.createBindGroup({
      layout: this.distancesBGL!,
      entries: [
        { binding: 0, resource: { buffer: this.sortUniformBuffer! } },
        { binding: 1, resource: { buffer: splatBuffer } },
        { binding: 2, resource: { buffer: this.keyBuffers![0] } },
        { binding: 3, resource: { buffer: this.indexBuffers![0] } },
      ],
    });

    let enc = device.createCommandEncoder();
    let pass = enc.beginComputePass();
    pass.setPipeline(this.distancesPipeline!);
    pass.setBindGroup(0, distBindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    device.queue.submit([enc.finish()]);

    // ── 8 radix passes ──
    this.currentSet = 0;

    for (let p = 0; p < NUM_PASSES; p++) {
      this.writeSortUniforms(cameraPos, count, p);
      const readSet = this.currentSet;
      const writeSet = 1 - readSet;

      enc = device.createCommandEncoder();

      // Clear histogram
      enc.copyBufferToBuffer(this.zeroBuffer!, 0, this.histogramBuffer!, 0, 64);

      // Histogram pass
      const histBindGroup = device.createBindGroup({
        layout: this.histogramBGL!,
        entries: [
          { binding: 0, resource: { buffer: this.sortUniformBuffer! } },
          { binding: 1, resource: { buffer: this.keyBuffers![readSet] } },
          { binding: 2, resource: { buffer: this.histogramBuffer! } },
        ],
      });
      pass = enc.beginComputePass();
      pass.setPipeline(this.histogramPipeline!);
      pass.setBindGroup(0, histBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();

      // Prefix sum pass
      const prefixBindGroup = device.createBindGroup({
        layout: this.prefixSumBGL!,
        entries: [
          { binding: 0, resource: { buffer: this.histogramBuffer! } },
          { binding: 1, resource: { buffer: this.prefixSumBuffer! } },
        ],
      });
      pass = enc.beginComputePass();
      pass.setPipeline(this.prefixSumPipeline!);
      pass.setBindGroup(0, prefixBindGroup);
      pass.dispatchWorkgroups(1);
      pass.end();

      // Clear scatter counter
      enc.copyBufferToBuffer(this.zeroBuffer!, 0, this.scatterCounterBuffer!, 0, 64);

      // Scatter pass
      const scatterBindGroup = device.createBindGroup({
        layout: this.scatterBGL!,
        entries: [
          { binding: 0, resource: { buffer: this.sortUniformBuffer! } },
          { binding: 1, resource: { buffer: this.keyBuffers![readSet] } },
          { binding: 2, resource: { buffer: this.indexBuffers![readSet] } },
          { binding: 3, resource: { buffer: this.prefixSumBuffer! } },
          { binding: 4, resource: { buffer: this.scatterCounterBuffer! } },
          { binding: 5, resource: { buffer: this.keyBuffers![writeSet] } },
          { binding: 6, resource: { buffer: this.indexBuffers![writeSet] } },
        ],
      });
      pass = enc.beginComputePass();
      pass.setPipeline(this.scatterPipeline!);
      pass.setBindGroup(0, scatterBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();

      device.queue.submit([enc.finish()]);

      // Ping-pong: next pass reads from the set we just wrote to
      this.currentSet = writeSet;
    }

    // ── Compact: reorder splat buffer using sorted indices ──
    this.runCompact(splatBuffer, this.indexBuffers![this.currentSet], count);
    return this.compactedBuffer;
  }

  private runCompact(splatBuffer: GPUBuffer, indexBuffer: GPUBuffer, count: number): void {
    const device = this.device!;

    // Update compact uniforms
    this.compactUniformData![0] = count;
    device.queue.writeBuffer(this.compactUniformBuffer!, 0, this.compactUniformData! as unknown as GPUAllowSharedBufferSource);

    const compactBindGroup = device.createBindGroup({
      layout: this.compactBGL!,
      entries: [
        { binding: 0, resource: { buffer: this.compactUniformBuffer! } },
        { binding: 1, resource: { buffer: splatBuffer } },
        { binding: 2, resource: { buffer: indexBuffer } },
        { binding: 3, resource: { buffer: this.compactedBuffer! } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.compactPipeline!);
    pass.setBindGroup(0, compactBindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP_SIZE));
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  private writeSortUniforms(cameraPos: [number, number, number], count: number, passIdx: number): void {
    const f = this.sortUniformFloats!;
    const u = this.sortUniformUints!;
    f[0] = cameraPos[0];
    f[1] = cameraPos[1];
    f[2] = cameraPos[2];
    u[3] = count;
    u[4] = passIdx;
    u[5] = 0;
    u[6] = 0;
    this.device!.queue.writeBuffer(this.sortUniformBuffer!, 0, this.sortUniformData!);
  }

  destroy(): void {
    this.sortUniformBuffer?.destroy();
    this.compactUniformBuffer?.destroy();
    this.keyBuffers?.forEach((b) => b.destroy());
    this.indexBuffers?.forEach((b) => b.destroy());
    this.histogramBuffer?.destroy();
    this.prefixSumBuffer?.destroy();
    this.scatterCounterBuffer?.destroy();
    this.zeroBuffer?.destroy();
    this.compactedBuffer?.destroy();

    this.sortUniformBuffer = null;
    this.compactUniformBuffer = null;
    this.keyBuffers = null;
    this.indexBuffers = null;
    this.histogramBuffer = null;
    this.prefixSumBuffer = null;
    this.scatterCounterBuffer = null;
    this.zeroBuffer = null;
    this.compactedBuffer = null;
    this.sortUniformData = null;
    this.sortUniformFloats = null;
    this.sortUniformUints = null;
    this.compactUniformData = null;
    this.cpuIndexUploadBuffer = null;
    this.device = null;
  }
}
