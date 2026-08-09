import { type Mat4 } from "wgpu-matrix";
import type { FrameGraphBuilder, GraphRenderContext } from "../frame-graph";
import { PassType } from "../frame-graph";
import type { FrustumPlane } from "../frustum";
import { createStorageBuffer, createUniformBuffer } from "../gpu-utils";
import { RenderPass } from "../render-pass";
import type { GpuMeshTable } from "./mesh-table";

export interface CullBatchRecord {
  indexCount: number;
  firstIndex: number;
  baseVertex: number;
}

const DRAW_INDEXED_INDIRECT_ARGS_SIZE = 20; // 5 u32

export class GpuCullPass extends RenderPass {
  name = "gpu-cull";
  passType = PassType.Custom;

  private device: GPUDevice;
  private maxBatches: number;
  private perBatchCapacity: number;
  private maxInstances: number;

  private cullPipeline: GPUComputePipeline | null = null;
  private argsPipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private argsUniformBuffer: GPUBuffer | null = null;
  private perBatchCountBuffer: GPUBuffer | null = null;
  private drawArgsBuffer: GPUBuffer | null = null;
  private visibleBuffer: GPUBuffer | null = null;
  private meshTableBuffer: GPUBuffer | null = null;
  private hzbView: GPUTextureView | null = null;
  private hzbLevelCount = 1;

  private instanceBuffer: GPUBuffer | null = null;
  private instanceCount = 0;
  private meshTable: GpuMeshTable | null = null;
  private hzbSize = { width: 0, height: 0 };

  constructor(device: GPUDevice, maxBatches: number, maxInstances: number) {
    super();
    this.device = device;
    this.maxBatches = maxBatches;
    this.maxInstances = maxInstances;
    this.perBatchCapacity = Math.max(1, Math.ceil(maxInstances / maxBatches));
  }

  getDrawArgsBuffer(): GPUBuffer | null {
    return this.drawArgsBuffer;
  }

  getVisibleBuffer(): GPUBuffer | null {
    return this.visibleBuffer;
  }

  getPerBatchCapacity(): number {
    return this.perBatchCapacity;
  }

  setPerBatchCapacity(cap: number): void {
    this.perBatchCapacity = cap;
    this.createVisibleBuffer();
  }

  setInstanceBuffer(buffer: GPUBuffer, count: number): void {
    this.instanceBuffer = buffer;
    this.instanceCount = count;
  }

  setMeshTable(table: GpuMeshTable): void {
    this.meshTable = table;
    this.uploadMeshTable();
  }

  setFrustum(viewProj: Mat4, frustumPlanes: readonly FrustumPlane[]): void {
    const u = new Float32Array(256 / 4);
    for (let i = 0; i < 16; i++) u[i] = viewProj[i];
    for (let i = 0; i < 6; i++) {
      const p = frustumPlanes[i]!;
      const off = 16 + i * 4;
      u[off + 0] = p.normal[0];
      u[off + 1] = p.normal[1];
      u[off + 2] = p.normal[2];
      u[off + 3] = p.distance;
    }
    const u32 = new Uint32Array(u.buffer);
    u32[40] = this.hzbSize.width;
    u32[41] = this.hzbSize.height;
    u32[42] = this.perBatchCapacity;
    u32[43] = this.hzbLevelCount;
    u32[44] = this.instanceCount;
    u[45] = viewProj[0]; // pad to keep uniform size
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, u as unknown as BufferSource);
  }

  setHzb(view: GPUTextureView | null, width: number, height: number, levelCount: number): void {
    this.hzbView = view;
    this.hzbSize = { width, height };
    this.hzbLevelCount = levelCount;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    if (!this.cullPipeline) {
      this.cullPipeline = device.createComputePipeline({
        label: "gpu-cull",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: CULL_WGSL }), entryPoint: "cs_main" },
      });
    }
    if (!this.argsPipeline) {
      this.argsPipeline = device.createComputePipeline({
        label: "gpu-cull-args",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: ARGS_FILL_WGSL }), entryPoint: "cs_main" },
      });
    }

    this.uniformBuffer = createUniformBuffer(device, 256);

    this.argsUniformBuffer = createUniformBuffer(device, 16);

    this.perBatchCountBuffer = createStorageBuffer(device, this.maxBatches * 4, false);

    this.drawArgsBuffer = device.createBuffer({
      size: this.maxBatches * DRAW_INDEXED_INDIRECT_ARGS_SIZE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });

    this.createVisibleBuffer();
    this.createMeshTableBuffer();
  }

  setup(_builder: FrameGraphBuilder): void {
    // Cull pass is an internal compute pass; no outputs declared to the graph yet.
  }

  execute(_ctx: GraphRenderContext): void {
    if (!this.instanceBuffer || !this.cullPipeline || !this.argsPipeline) return;
    if (!this.meshTable) return;

    // Clear per-batch counters to 0
    this.device.queue.writeBuffer(this.perBatchCountBuffer!, 0, new Uint32Array(this.maxBatches) as unknown as BufferSource);

    const batchCount = this.meshTable.getBatches().length;
    const argsU = new Uint32Array(4);
    argsU[0] = this.perBatchCapacity;
    argsU[1] = batchCount;
    this.device.queue.writeBuffer(this.argsUniformBuffer!, 0, argsU as unknown as BufferSource);

    // DEVIATION: This pass creates its own command encoder and submits directly
    // instead of using the frame graph's shared encoder. The cull pass is a
    // compute-only pass whose output (indirect draw args buffer) is consumed by
    // a later draw pass via drawIndexedIndirect — it does not produce graph
    // textures. Refactoring to the frame graph is tracked as a future task.
    const encoder = this.device.createCommandEncoder({ label: "gpu-cull" });
    const pass = encoder.beginComputePass({ label: "gpu-cull" });

    pass.setPipeline(this.cullPipeline);
    pass.setBindGroup(0, this.createCullBindGroup());
    pass.dispatchWorkgroups(Math.ceil(this.instanceCount / 64));

    pass.setPipeline(this.argsPipeline);
    pass.setBindGroup(0, this.createArgsBindGroup());
    pass.dispatchWorkgroups(Math.ceil(batchCount / 64));

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.argsUniformBuffer?.destroy();
    this.perBatchCountBuffer?.destroy();
    this.drawArgsBuffer?.destroy();
    this.visibleBuffer?.destroy();
    this.meshTableBuffer?.destroy();
    this.uniformBuffer = null;
    this.argsUniformBuffer = null;
    this.perBatchCountBuffer = null;
    this.drawArgsBuffer = null;
    this.visibleBuffer = null;
    this.meshTableBuffer = null;
    this.cullPipeline = null;
    this.argsPipeline = null;
  }

  private createVisibleBuffer(): void {
    this.visibleBuffer?.destroy();
    const capacity = this.maxBatches * this.perBatchCapacity;
    this.visibleBuffer = this.device.createBuffer({
      size: Math.max(4, capacity * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private createMeshTableBuffer(): void {
    this.meshTableBuffer = this.device.createBuffer({
      size: Math.max(4, this.maxBatches * 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private uploadMeshTable(): void {
    if (!this.meshTable) return;
    const batches = this.meshTable.getBatches();
    const data = new Uint32Array(this.maxBatches * 4);
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      data[i * 4 + 0] = b.indexCount;
      data[i * 4 + 1] = b.indexOffset;
      data[i * 4 + 2] = b.baseVertex;
      // data[i * 4 + 3] is padding
    }
    this.device.queue.writeBuffer(this.meshTableBuffer!, 0, data as unknown as BufferSource);
  }

  private createCullBindGroup(): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.uniformBuffer! } },
      { binding: 1, resource: { buffer: this.instanceBuffer! } },
      { binding: 2, resource: { buffer: this.perBatchCountBuffer! } },
      { binding: 3, resource: { buffer: this.visibleBuffer! } },
      { binding: 4, resource: { buffer: this.meshTableBuffer! } },
    ];
    if (this.hzbView) {
      entries.push({ binding: 5, resource: this.hzbView });
    }
    return this.device.createBindGroup({
      layout: this.cullPipeline!.getBindGroupLayout(0),
      entries,
    });
  }

  private createArgsBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.argsPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.perBatchCountBuffer! } },
        { binding: 1, resource: { buffer: this.drawArgsBuffer! } },
        { binding: 2, resource: { buffer: this.meshTableBuffer! } },
        { binding: 3, resource: { buffer: this.argsUniformBuffer! } },
      ],
    });
  }
}

const CULL_WGSL = /* wgsl */ `
struct CullUniforms {
  viewProj: mat4x4<f32>,
  frustum: array<vec4<f32>, 6>,
  screenSize: vec2<u32>,
  perBatchCapacity: u32,
  hzbMaxLevel: u32,
  instanceCount: u32,
};

struct InstanceRecord {
  pos: vec3<f32>,
  scale: f32,
  rot: vec4<f32>,
  aabbMin: vec3<f32>,
  _pad0: f32,
  aabbMax: vec3<f32>,
  _pad1: f32,
  meshIdx: u32,
  materialIdx: u32,
  flags: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<uniform> u: CullUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;
@group(0) @binding(2) var<storage, read_write> perBatchCount: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> visibleBuffer: array<u32>;
@group(0) @binding(4) var<storage, read> meshTable: array<vec4<u32>>;
@group(0) @binding(5) var hzbTex: texture_2d<f32>;

var<workgroup> planes: array<vec4<f32>, 6>;

fn aabbFrustumVisible(aabbMin: vec3<f32>, aabbMax: vec3<f32>) -> bool {
  for (var i: i32 = 0; i < 6; i = i + 1) {
    let plane = planes[i];
    let px = select(aabbMin.x, aabbMax.x, plane.x > 0.0);
    let py = select(aabbMin.y, aabbMax.y, plane.y > 0.0);
    let pz = select(aabbMin.z, aabbMax.z, plane.z > 0.0);
    let d = dot(plane.xyz, vec3<f32>(px, py, pz)) + plane.w;
    if (d < 0.0) { return false; }
  }
  return true;
}

fn hzbOccluded(aabbMin: vec3<f32>, aabbMax: vec3<f32>) -> bool {
  if (u.hzbMaxLevel <= 0u) { return false; }

  var ndcMin = vec3<f32>(1.0, 1.0, 1.0);
  var ndcMax = vec3<f32>(-1.0, -1.0, -1.0);
  for (var i: i32 = 0; i < 8; i = i + 1) {
    let c = vec3<f32>(
      select(aabbMin.x, aabbMax.x, (i & 1) != 0),
      select(aabbMin.y, aabbMax.y, (i & 2) != 0),
      select(aabbMin.z, aabbMax.z, (i & 4) != 0),
    );
    let clip = u.viewProj * vec4<f32>(c, 1.0);
    let ndc = clip.xyz / clip.w;
    ndcMin = min(ndcMin, ndc);
    ndcMax = max(ndcMax, ndc);
  }

  let uvMin = ndcMin.xy * 0.5 + 0.5;
  let uvMax = ndcMax.xy * 0.5 + 0.5;
  if (uvMax.x < 0.0 || uvMin.x > 1.0 || uvMax.y < 0.0 || uvMin.y > 1.0) {
    return false; // off screen; frustum already handled it
  }

  let boxUV = max(uvMax.x - uvMin.x, uvMax.y - uvMin.y);
  if (boxUV <= 0.0) { return false; }

  var level = i32(floor(log2(1.0 / boxUV)));
  level = clamp(level, 0, i32(u.hzbMaxLevel) - 1);
  let topSize = vec2<f32>(f32(u.screenSize.x), f32(u.screenSize.y));
  let mipSize = vec2<f32>(textureDimensions(hzbTex, level));
  let center = clamp((uvMin + uvMax) * 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  let texel = vec2<i32>(center * (mipSize - 1.0));
  let hzbDepth = textureLoad(hzbTex, texel, level).r;

  return ndcMin.z > hzbDepth;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let li = gid.x % 64u;
  if (li < 6u) {
    planes[li] = u.frustum[li];
  }
  workgroupBarrier();

  let instanceIdx = gid.x;
  if (instanceIdx >= u.instanceCount) { return; }

  let inst = instances[instanceIdx];
  let batch = inst.meshIdx;
  if (batch >= arrayLength(&meshTable)) { return; }

  let visible = aabbFrustumVisible(inst.aabbMin, inst.aabbMax) && !hzbOccluded(inst.aabbMin, inst.aabbMax);
  if (!visible) { return; }

  let slot = atomicAdd(&perBatchCount[batch], 1u);
  if (slot < u.perBatchCapacity) {
    visibleBuffer[batch * u.perBatchCapacity + slot] = instanceIdx;
  } else {
    // Overflow — decrement to keep count accurate. This is a known per-batch capacity limitation.
    atomicSub(&perBatchCount[batch], 1u);
  }
}
`;

const ARGS_FILL_WGSL = /* wgsl */ `
struct ArgsUniforms {
  perBatchCapacity: u32,
  batchCount: u32,
};

struct DrawIndexedIndirectArgs {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
};

@group(0) @binding(0) var<storage, read> perBatchCount: array<u32>;
@group(0) @binding(1) var<storage, read_write> drawArgs: array<DrawIndexedIndirectArgs>;
@group(0) @binding(2) var<storage, read> meshTable: array<vec4<u32>>; // indexCount, firstIndex, baseVertex, pad
@group(0) @binding(3) var<uniform> u: ArgsUniforms;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let batch = gid.x;
  if (batch >= u.batchCount || batch >= arrayLength(&meshTable)) { return; }
  let count = perBatchCount[batch];
  let mesh = meshTable[batch];
  drawArgs[batch] = DrawIndexedIndirectArgs(
    mesh.x,
    count,
    mesh.y,
    i32(mesh.z),
    batch * u.perBatchCapacity,
  );
}
`;
