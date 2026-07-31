import { type Mat4 } from "wgpu-matrix";
import { RenderPass } from "../render-pass.ts";

const WIREFRAME_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) depth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.normal = input.normal;
  output.depth = output.clipPosition.z / output.clipPosition.w;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let n = normalize(input.normal);
  let color = (n * 0.5 + 0.5);
  return vec4<f32>(color, 1.0);
}
`;

const NORMALS_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let n = normalize(input.normal);
  return vec4<f32>(abs(n), 1.0);
}
`;

const OVERDRAW_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  return camera.viewProj * vec4<f32>(input.position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  // Each overdraw adds more red — accumulates via additive blend
  return vec4<f32>(0.1, 0.0, 0.0, 1.0);
}
`;

const DEPTH_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) depth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.depth = output.clipPosition.z / output.clipPosition.w;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let d = input.depth;
  return vec4<f32>(d, d, d, 1.0);
}
`;

const TANGENTS_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) tangent: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) vColor: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.vColor = abs(normalize(input.tangent));
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.vColor, 1.0);
}
`;

const LOD_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

struct LodUniforms {
  level: f32,
  _pad: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> lod: LodUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) vLevel: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = camera.viewProj * vec4<f32>(input.position, 1.0);
  output.vLevel = lod.level;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let l = input.vLevel;
  if (l < 0.5) { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }
  if (l < 1.5) { return vec4<f32>(1.0, 1.0, 0.0, 1.0); }
  if (l < 2.5) { return vec4<f32>(1.0, 0.5, 0.0, 1.0); }
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;

const AABB_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  _pad0: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  return camera.viewProj * vec4<f32>(input.position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 1.0, 0.0, 1.0);
}
`;

export type DebugVizMode = "wireframe" | "normals" | "overdraw" | "depth" | "tangents" | "lod" | "aabbs";

export interface DebugVizSettings {
  mode: DebugVizMode | null;
  wireframeColor: [number, number, number];
  lodRanges: number[];
}

export const DEFAULT_DEBUG_VIZ_SETTINGS: DebugVizSettings = {
  mode: null,
  wireframeColor: [0.5, 1.0, 0.8],
  lodRanges: [10, 25, 50, 100],
};

export class DebugVizPass extends RenderPass {
  name = "debug-viz";
  surfaceHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private pipelines: Map<DebugVizMode, GPURenderPipeline> = new Map();
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private settings: DebugVizSettings = DEFAULT_DEBUG_VIZ_SETTINGS;
  private lodBuffer: GPUBuffer | null = null;
  private lodBindGroup: GPUBindGroup | null = null;
  private aabbBuffer: GPUBuffer | null = null;
  private aabbPipeline: GPURenderPipeline | null = null;
  private aabbBindGroup: GPUBindGroup | null = null;

  constructor(surfaceFormat: GPUTextureFormat = "rgba16float") {
    super();
    this.surfaceFormat = surfaceFormat;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.cameraBuffer = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lodBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // AABB line buffer: 24 vertices (12 edges × 2 endpoints) × 3 floats
    this.aabbBuffer = device.createBuffer({
      size: 24 * 3 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const meshShaders: Array<[DebugVizMode, string]> = [
      ["wireframe", WIREFRAME_SHADER],
      ["normals", NORMALS_SHADER],
      ["overdraw", OVERDRAW_SHADER],
      ["depth", DEPTH_SHADER],
      ["tangents", TANGENTS_SHADER],
      ["lod", LOD_SHADER],
    ];

    for (const [mode, code] of meshShaders) {
      const module = device.createShaderModule({ code });
      const primitive: GPUPrimitiveState = mode === "wireframe"
        ? { topology: "line-list" }
        : { topology: "triangle-list" };

      const blend: GPUBlendState | undefined = mode === "overdraw"
        ? {
            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
          }
        : undefined;

      const targets: Array<GPUColorTargetState> = [{
        format: this.surfaceFormat,
        ...(blend ? { blend } : {}),
      }];

      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
            ],
          }],
        },
        fragment: { module, entryPoint: "fs_main", targets },
        primitive,
      });
      this.pipelines.set(mode, pipeline);
    }

    // LOD bind group (needs lod uniform in addition to camera)
    const lodPipeline = this.pipelines.get("lod");
    if (lodPipeline) {
      this.lodBindGroup = device.createBindGroup({
        layout: lodPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer } },
          { binding: 1, resource: { buffer: this.lodBuffer } },
        ],
      });
    }

    // AABB pipeline (line-list, position-only vertices)
    const aabbModule = device.createShaderModule({ code: AABB_SHADER });
    this.aabbPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: aabbModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 12,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: aabbModule, entryPoint: "fs_main", targets: [{ format: this.surfaceFormat }] },
      primitive: { topology: "line-list" },
    });
    this.aabbBindGroup = device.createBindGroup({
      layout: this.aabbPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    // Use first pipeline's layout for bind group
    const firstPipeline = this.pipelines.values().next().value;
    if (firstPipeline) {
      this.bindGroup = device.createBindGroup({
        layout: firstPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
      });
    }
  }

  setCamera(viewProj: Mat4): void {
    if (!this.device || !this.cameraBuffer) return;
    const data = new Float32Array(20);
    data.set(viewProj as Float32Array, 0);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
  }

  setSettings(settings: Partial<DebugVizSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  getMode(): DebugVizMode | null {
    return this.settings.mode;
  }

  setMode(mode: DebugVizMode | null): void {
    this.settings = { ...this.settings, mode };
  }

  renderMesh(ctx: GraphRenderContext, vertexBuffer: GPUBuffer, indexBuffer: GPUBuffer | null, indexCount: number): void {
    if (!this.settings.mode || !this.bindGroup || !ctx.pass) return;

    if (this.settings.mode === "lod") {
      const pipeline = this.pipelines.get("lod");
      if (!pipeline || !this.lodBindGroup) return;
      const pass = ctx.pass;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.lodBindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      if (indexBuffer) {
        pass.setIndexBuffer(indexBuffer, "uint16");
        pass.drawIndexed(indexCount);
      } else {
        pass.draw(indexCount);
      }
      return;
    }

    const pipeline = this.pipelines.get(this.settings.mode);
    if (!pipeline) return;

    const pass = ctx.pass;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    if (indexBuffer) {
      pass.setIndexBuffer(indexBuffer, "uint16");
      pass.drawIndexed(indexCount);
    } else {
      pass.draw(indexCount);
    }
  }

  renderAABB(ctx: GraphRenderContext, min: [number, number, number], max: [number, number, number]): void {
    if (!this.device || !this.aabbPipeline || !this.aabbBindGroup || !this.aabbBuffer) return;

    const [minX, minY, minZ] = min;
    const [maxX, maxY, maxZ] = max;

    const vertices = new Float32Array([
      minX, minY, minZ,  maxX, minY, minZ,
      maxX, minY, minZ,  maxX, maxY, minZ,
      maxX, maxY, minZ,  minX, maxY, minZ,
      minX, maxY, minZ,  minX, minY, minZ,
      minX, minY, maxZ,  maxX, minY, maxZ,
      maxX, minY, maxZ,  maxX, maxY, maxZ,
      maxX, maxY, maxZ,  minX, maxY, maxZ,
      minX, maxY, maxZ,  minX, minY, maxZ,
      minX, minY, minZ,  minX, minY, maxZ,
      maxX, minY, minZ,  maxX, minY, maxZ,
      maxX, maxY, minZ,  maxX, maxY, maxZ,
      minX, maxY, minZ,  minX, maxY, maxZ,
    ]);

    this.device.queue.writeBuffer(this.aabbBuffer, 0, vertices as unknown as BufferSource);

    const pass = ctx.pass;
    pass.setPipeline(this.aabbPipeline);
    pass.setBindGroup(0, this.aabbBindGroup);
    pass.setVertexBuffer(0, this.aabbBuffer);
    pass.draw(24);
  }

  setLodLevel(level: number): void {
    if (!this.device || !this.lodBuffer) return;
    const data = new Float32Array(4);
    data[0] = level;
    this.device.queue.writeBuffer(this.lodBuffer, 0, data as unknown as BufferSource);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.surfaceHandle) builder.colorAttachment({ handle: this.surfaceHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!ctx.pass) return;
    this.setCamera(ctx.viewProj);
    if (!this.settings.mode) return;

    const vb = ctx.opaqueVertexBuffer;
    const ib = ctx.opaqueIndexBuffer;
    const indexCount = ctx.opaqueIndexCount;
    if (vb && ib && indexCount > 0) {
      this.renderMesh(ctx, vb, ib, indexCount);
    }
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.cameraBuffer = null;
    this.lodBuffer?.destroy();
    this.lodBuffer = null;
    this.aabbBuffer?.destroy();
    this.aabbBuffer = null;
    this.pipelines.clear();
    this.aabbPipeline = null;
  }
}
