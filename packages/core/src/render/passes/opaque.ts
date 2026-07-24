import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import type { MeshData } from "../../mesh/builder.ts";
import { mat4, type Mat4 } from "wgpu-matrix";

const GBUFFER_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
  prevModelMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
  @location(4) prevClipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = camera.modelMatrix * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.worldPos = worldPos.xyz;
  output.worldNormal = normalize((camera.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz);
  output.uv = input.uv;
  output.color = input.color;
  let prevWorldPos = camera.prevModelMatrix * vec4<f32>(input.position, 1.0);
  output.prevClipPosition = camera.prevViewProj * prevWorldPos;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32>,
                                    @location(1) vec4<f32>,
                                    @location(2) vec4<f32>,
                                    @location(3) vec2<f32> {
  // GBuffer0: albedo (RGB) + AO (A)
  let albedo = input.color.rgb;
  let ao = 1.0;
  // GBuffer1: normal (RGB) + roughness (A)
  let encodedNormal = normalize(input.worldNormal) * 0.5 + 0.5;
  let roughness = 0.5;
  // GBuffer2: metallic (R) + emissive (GBA)
  let metallic = 0.0;
  let emissive = vec3<f32>(0.0);
  // Velocity: screen-space motion (curr - prev)
  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  return vec4<f32>(albedo, ao),
         vec4<f32>(encodedNormal, roughness),
         vec4<f32>(metallic, emissive),
         velocity;
}
`;

const SIMPLE_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  modelMatrix: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = camera.modelMatrix * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.color = input.color;
  output.normal = input.normal;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.8, 0.3));
  let lambert = max(dot(normalize(input.normal), lightDir), 0.0);
  let ambient = 0.3;
  let intensity = ambient + lambert * 0.7;
  return vec4<f32>(input.color.rgb * intensity, input.color.a);
}
`;

export type OpaquePassMode = "gbuffer" | "simple";

export class OpaquePass extends RenderPass {
  name = "opaque";
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private mesh: MeshData | null = null;
  private depthTexture: GPUTexture | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private surfaceFormat: GPUTextureFormat;
  private mode: OpaquePassMode;
  private cameraBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private modelMatrix: Mat4 = mat4.identity();
  private prevModelMatrix: Mat4 = mat4.identity();
  private prevViewProj: Mat4 = mat4.identity();

  constructor(device: GPUDevice, surfaceFormat?: GPUTextureFormat, mode: OpaquePassMode = "gbuffer") {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat ?? (navigator.gpu ? navigator.gpu.getPreferredCanvasFormat() : "bgra8unorm");
    this.mode = mode;
  }

  setMesh(mesh: MeshData): void {
    this.mesh = mesh;
    this.vertexBuffer = this.device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, mesh.vertices.buffer);

    this.indexBuffer = this.device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices.buffer);
  }

  setShaderSource(wgsl: string): void {
    this.shaderModule = this.device.createShaderModule({ code: wgsl });
    this.pipeline = null;
  }

  setModelMatrix(model: Mat4): void {
    this.prevModelMatrix = this.modelMatrix;
    this.modelMatrix = model;
  }

  setPrevViewProj(prevViewProj: Mat4): void {
    this.prevViewProj = prevViewProj;
  }

  prepare(_device: GPUDevice): void {
    if (!this.mesh) return;

    if (!this.shaderModule) {
      this.shaderModule = this.device.createShaderModule({
        code: this.mode === "gbuffer" ? GBUFFER_SHADER : SIMPLE_SHADER,
      });
    }

    if (this.mode === "gbuffer") {
      this.cameraBuffer = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    } else {
      this.cameraBuffer = this.device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    if (this.mode === "gbuffer") {
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: this.mesh.layout.stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.shaderModule,
          entryPoint: "fs_main",
          targets: [
            { format: "rgba8unorm" },
            { format: "rgba8unorm" },
            { format: "rgba8unorm" },
            { format: "rg16float" },
          ],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "back",
        },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    } else {
      this.pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: this.mesh.layout.stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.shaderModule,
          entryPoint: "fs_main",
          targets: [{ format: this.surfaceFormat }],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "back",
        },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      });
    }

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer! } }],
    });
  }

  updateCamera(viewProj: Mat4): void {
    if (!this.cameraBuffer) return;
    if (this.mode === "gbuffer") {
      const data = new Float32Array(64);
      data.set(viewProj as Float32Array, 0);
      data.set(this.prevViewProj as Float32Array, 16);
      data.set(this.modelMatrix as Float32Array, 32);
      data.set(this.prevModelMatrix as Float32Array, 48);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
    } else {
      const data = new Float32Array(32);
      data.set(viewProj as Float32Array, 0);
      data.set(this.modelMatrix as Float32Array, 16);
      this.device.queue.writeBuffer(this.cameraBuffer, 0, data as unknown as BufferSource);
    }
  }

  execute(ctx: RenderPassContext): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.mesh || !this.bindGroup) return;

    const tracked = ctx.pass instanceof TrackedRenderPass
      ? ctx.pass
      : new TrackedRenderPass(ctx.pass);
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.setVertexBuffer(0, this.vertexBuffer);
    tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
    tracked.drawIndexed(this.mesh.indexCount);
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.pipeline?.getBindGroupLayout(0) ?? null;
  }

  ensureDepthTexture(width: number, height: number): GPUTexture {
    if (this.depthTexture) {
      if (this.depthTexture.width === width && this.depthTexture.height === height) {
        return this.depthTexture;
      }
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return this.depthTexture;
  }

  getDepthTextureView(): GPUTextureView | null {
    return this.depthTexture?.createView() ?? null;
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.depthTexture?.destroy();
    this.cameraBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.depthTexture = null;
    this.cameraBuffer = null;
  }
}
