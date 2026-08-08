import { type Mat4 } from "wgpu-matrix";
import type { FrameGraphBuilder, GraphRenderContext } from "../frame-graph";
import { PassType } from "../frame-graph";
import { RenderPass } from "../render-pass";
import { destroyMapValues } from "../resource-tracker";
import { TrackedRenderPass } from "../tracked-render-pass";
import type { GpuMeshTable, MeshTableGroup } from "./mesh-table";

export class IndirectDrawPass extends RenderPass {
  name = "indirect-draw";
  passType = PassType.Custom;

  private device: GPUDevice | null = null;
  private colorFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private sampleCount: number;

  private cameraBuffer: GPUBuffer | null = null;
  private cameraUniformData = new Float32Array(64); // 2 mat4x4 + cameraPos
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private pipelineLayout: GPUPipelineLayout | null = null;
  private cameraBindGroup: GPUBindGroup | null = null;
  private pipelines = new Map<number, GPURenderPipeline>();

  private meshTable: GpuMeshTable | null = null;
  private drawArgsBuffer: GPUBuffer | null = null;
  private visibleBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private colorAttachments: GPURenderPassColorAttachment[] | null = null;
  private depthAttachment: GPURenderPassDepthStencilAttachment | null = null;
  private width = 0;
  private height = 0;

  constructor(colorFormat: GPUTextureFormat = "bgra8unorm", depthFormat: GPUTextureFormat = "depth32float", sampleCount = 1) {
    super();
    this.colorFormat = colorFormat;
    this.depthFormat = depthFormat;
    this.sampleCount = sampleCount;
  }

  setMeshTable(table: GpuMeshTable): void {
    this.meshTable = table;
    destroyMapValues(this.pipelines);
  }

  setDrawArgsBuffer(buffer: GPUBuffer): void {
    this.drawArgsBuffer = buffer;
  }

  setVisibleBuffer(buffer: GPUBuffer): void {
    this.visibleBuffer = buffer;
    this.updateCameraBindGroup();
  }

  setInstanceBuffer(buffer: GPUBuffer): void {
    this.instanceBuffer = buffer;
    this.updateCameraBindGroup();
  }

  setCamera(viewProj: Mat4, prevViewProj: Mat4, cameraPos: [number, number, number]): void {
    for (let i = 0; i < 16; i++) this.cameraUniformData[i] = viewProj[i];
    for (let i = 0; i < 16; i++) this.cameraUniformData[16 + i] = prevViewProj[i];
    this.cameraUniformData[32] = cameraPos[0];
    this.cameraUniformData[33] = cameraPos[1];
    this.cameraUniformData[34] = cameraPos[2];
    this.device?.queue.writeBuffer(this.cameraBuffer!, 0, this.cameraUniformData as unknown as BufferSource);
  }

  setRenderTargets(width: number, height: number, colorAttachments: GPURenderPassColorAttachment[], depthAttachment: GPURenderPassDepthStencilAttachment): void {
    this.width = width;
    this.height = height;
    this.colorAttachments = colorAttachments;
    this.depthAttachment = depthAttachment;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.cameraBuffer = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });

    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });
  }

  setup(_builder: FrameGraphBuilder): void {
    // Custom pass: creates its own render pass; no graph attachment declarations here.
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.device || !this.meshTable || !this.drawArgsBuffer || !this.visibleBuffer || !this.instanceBuffer) return;
    if (!this.colorAttachments || !this.depthAttachment) return;

    const encoder = this.device.createCommandEncoder({ label: "indirect-draw" });
    const renderPass = encoder.beginRenderPass({
      colorAttachments: this.colorAttachments,
      depthStencilAttachment: this.depthAttachment,
    });
    const tracked = new TrackedRenderPass(renderPass);

    tracked.setBindGroup(0, this.cameraBindGroup!);

    const batches = this.meshTable.getBatches();
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!;
      const group = this.meshTable.getGroup(batch);
      if (!group.vertexBuffer || !group.indexBuffer) continue;

      const pipeline = this.getPipeline(group);
      tracked.setPipeline(pipeline);
      tracked.setVertexBuffer(0, group.vertexBuffer);
      tracked.setIndexBuffer(group.indexBuffer, batch.indexFormat);
      tracked.drawIndexedIndirect(this.drawArgsBuffer, batchIdx * 20);
    }

    tracked.end();
    ctx.addDrawCalls(tracked.drawCalls);
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    destroyMapValues(this.pipelines);
    this.cameraBuffer = null;
    this.bindGroupLayout = null;
    this.pipelineLayout = null;
    this.cameraBindGroup = null;
  }

  private updateCameraBindGroup(): void {
    if (!this.device || !this.bindGroupLayout || !this.cameraBuffer || !this.visibleBuffer || !this.instanceBuffer) return;
    this.cameraBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
        { binding: 2, resource: { buffer: this.visibleBuffer } },
      ],
    });
  }

  private getPipeline(group: MeshTableGroup): GPURenderPipeline {
    const key = group.layoutStride;
    let pipeline = this.pipelines.get(key);
    if (pipeline) return pipeline;

    const vertexAttributes: GPUVertexAttribute[] = [];
    const mesh = group.meshes[0]!;
    const layout = mesh.layout;
    for (let i = 0; i < layout.attributes.length; i++) {
        const a = layout.attributes[i]!;
        vertexAttributes.push({
          shaderLocation: i,
          offset: a.offset,
          format: a.format as GPUVertexFormat,
        });
      }

    const desc: GPURenderPipelineDescriptor = {
      layout: this.pipelineLayout ?? "auto",
      vertex: {
        module: this.device!.createShaderModule({ code: INDIRECT_DRAW_WGSL }),
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: group.layoutStride,
          attributes: vertexAttributes,
        }],
      },
      fragment: {
        module: this.device!.createShaderModule({ code: INDIRECT_DRAW_WGSL }),
        entryPoint: "fs_main",
        targets: [
          { format: this.colorFormat },
          { format: this.colorFormat },
          { format: this.colorFormat },
          { format: this.colorFormat },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
      multisample: { count: this.sampleCount },
    };

    pipeline = this.device!.createRenderPipeline(desc);
    this.pipelines.set(key, pipeline);
    return pipeline;
  }
}

const INDIRECT_DRAW_WGSL = /* wgsl */ `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad: f32,
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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceRecord>;
@group(0) @binding(2) var<storage, read> visibleBuffer: array<u32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) aux: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(5) prevClipPosition: vec4<f32>,
};

fn quatToMat(q: vec4<f32>) -> mat4x4<f32> {
  let c0 = vec4<f32>(
    1.0 - 2.0 * (q.y * q.y + q.z * q.z),
    2.0 * (q.x * q.y + q.w * q.z),
    2.0 * (q.x * q.z - q.w * q.y),
    0.0,
  );
  let c1 = vec4<f32>(
    2.0 * (q.x * q.y - q.w * q.z),
    1.0 - 2.0 * (q.x * q.x + q.z * q.z),
    2.0 * (q.y * q.z + q.w * q.x),
    0.0,
  );
  let c2 = vec4<f32>(
    2.0 * (q.x * q.z + q.w * q.y),
    2.0 * (q.y * q.z - q.w * q.x),
    1.0 - 2.0 * (q.x * q.x + q.y * q.y),
    0.0,
  );
  let c3 = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  return mat4x4<f32>(c0, c1, c2, c3);
}

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
  var out: VertexOutput;
  let srcIdx = visibleBuffer[instanceIdx];
  let inst = instances[srcIdx];

  let s = mat4x4<f32>(
    vec4<f32>(inst.scale, 0.0, 0.0, 0.0),
    vec4<f32>(0.0, inst.scale, 0.0, 0.0),
    vec4<f32>(0.0, 0.0, inst.scale, 0.0),
    vec4<f32>(0.0, 0.0, 0.0, 1.0),
  );

  let r = quatToMat(inst.rot);
  let t = mat4x4<f32>(
    vec4<f32>(1.0, 0.0, 0.0, 0.0),
    vec4<f32>(0.0, 1.0, 0.0, 0.0),
    vec4<f32>(0.0, 0.0, 1.0, 0.0),
    vec4<f32>(inst.pos, 1.0),
  );

  let model = t * r * s;
  let worldPos = (model * vec4<f32>(input.position, 1.0)).xyz;
  out.clipPosition = camera.viewProj * vec4<f32>(worldPos, 1.0);
  out.worldPos = worldPos;
  out.worldNormal = normalize((model * vec4<f32>(input.normal, 0.0)).xyz);
  out.uv = input.uv;
  out.color = input.aux;
  out.prevClipPosition = out.clipPosition; // velocity = 0 for v1
  return out;
}

@fragment
fn fs_main(input: VertexOutput) ->
  @location(0) vec4<f32>,
  @location(1) vec4<f32>,
  @location(2) vec4<f32>,
  @location(3) vec2<f32> {
  let albedo = input.color.rgb;
  let ao = 1.0;
  let N = normalize(input.worldNormal);
  let encodedN = N * 0.5 + 0.5;
  let roughness = 0.5;
  let metallic = 0.0;
  let emissive = vec3<f32>(0.0);
  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  return vec4<f32>(albedo, ao),
         vec4<f32>(encodedN, roughness),
         vec4<f32>(metallic, emissive),
         velocity;
}
`;
