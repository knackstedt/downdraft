import { RenderPass, type RenderPassContext } from "../render-pass.ts";
import { mat4, type Mat4 } from "wgpu-matrix";

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

export type DebugVizMode = "wireframe" | "normals" | "overdraw" | "depth" | "tangents" | "lod";

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
  private device: GPUDevice | null = null;
  private surfaceFormat: GPUTextureFormat;
  private pipelines: Map<DebugVizMode, GPURenderPipeline> = new Map();
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private settings: DebugVizSettings = DEFAULT_DEBUG_VIZ_SETTINGS;

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

    const shaders: Array<[DebugVizMode, string]> = [
      ["wireframe", WIREFRAME_SHADER],
      ["normals", NORMALS_SHADER],
      ["overdraw", OVERDRAW_SHADER],
      ["depth", DEPTH_SHADER],
    ];

    for (const [mode, code] of shaders) {
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

  renderMesh(ctx: RenderPassContext, vertexBuffer: GPUBuffer, indexBuffer: GPUBuffer | null, indexCount: number): void {
    if (!this.settings.mode || !this.bindGroup) return;
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

  execute(_ctx: RenderPassContext): void {
    // Rendering is done via renderMesh() calls from the render loop
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.cameraBuffer = null;
    this.pipelines.clear();
  }
}
