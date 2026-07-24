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

const PBR_GBUFFER_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  prevViewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;
@group(0) @binding(2) var prevModelUniform: mat4x4<f32>;

struct MaterialUniforms {
  baseColor: vec4<f32>,
  roughness: f32,
  metallic: f32,
  emissiveIntensity: f32,
  _pad0: f32,
};

@group(1) @binding(0) var<uniform> material: MaterialUniforms;
@group(1) @binding(1) var albedoMap: texture_2d<f32>;
@group(1) @binding(2) var albedoSampler: sampler;
@group(1) @binding(3) var normalMap: texture_2d<f32>;
@group(1) @binding(4) var normalSampler: sampler;
@group(1) @binding(5) var metallicRoughnessMap: texture_2d<f32>;
@group(1) @binding(6) var mrSampler: sampler;
@group(1) @binding(7) var aoMap: texture_2d<f32>;
@group(1) @binding(8) var aoSampler: sampler;
@group(1) @binding(9) var emissiveMap: texture_2d<f32>;
@group(1) @binding(10) var emissiveSampler: sampler;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) worldNormal: vec3<f32>,
  @location(3) worldTangent: vec3<f32>,
  @location(4) worldBitangent: vec3<f32>,
  @location(5) prevClipPosition: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.worldPosition = worldPos.xyz;
  output.uv = input.uv;

  let normalMatrix = mat3x3<f32>(
    modelUniform[0].xyz,
    modelUniform[1].xyz,
    modelUniform[2].xyz,
  );
  output.worldNormal = normalize(normalMatrix * input.normal);
  output.worldTangent = normalize(normalMatrix * input.tangent.xyz);
  output.worldBitangent = cross(output.worldNormal, output.worldTangent) * input.tangent.w;

  let prevWorldPos = prevModelUniform * vec4<f32>(input.position, 1.0);
  output.prevClipPosition = camera.prevViewProj * prevWorldPos;

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> (
  @location(0) vec4<f32>,
  @location(1) vec4<f32>,
  @location(2) vec4<f32>,
  @location(3) vec2<f32>,
) {
  let albedo = textureSample(albedoMap, albedoSampler, input.uv) * material.baseColor;
  let mr = textureSample(metallicRoughnessMap, mrSampler, input.uv);
  let metallic = mr.b * material.metallic;
  let roughness = mr.g * material.roughness;
  let ao = textureSample(aoMap, aoSampler, input.uv).r;
  let emissive = textureSample(emissiveMap, emissiveSampler, input.uv).rgb * material.emissiveIntensity;

  let tangentNormal = textureSample(normalMap, normalSampler, input.uv).xyz * 2.0 - 1.0;
  let TBN = mat3x3<f32>(
    input.worldTangent,
    input.worldBitangent,
    input.worldNormal,
  );
  let worldNormal = normalize(TBN * tangentNormal);
  let encodedNormal = (worldNormal * 0.5 + 0.5);

  let currNDC = input.clipPosition.xy / input.clipPosition.w;
  let prevNDC = input.prevClipPosition.xy / input.prevClipPosition.w;
  let velocity = (currNDC - prevNDC) * 0.5;

  return (
    vec4<f32>(albedo.rgb, ao),
    vec4<f32>(encodedNormal, roughness),
    vec4<f32>(metallic, emissive.r, emissive.g, emissive.b),
    velocity,
  );
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

export interface PBRMaterialResources {
  albedoTexture: GPUTextureView;
  normalTexture: GPUTextureView;
  metallicRoughnessTexture: GPUTextureView;
  aoTexture: GPUTextureView;
  emissiveTexture: GPUTextureView;
  sampler: GPUSampler;
  baseColor: [number, number, number, number];
  roughness: number;
  metallic: number;
  emissiveIntensity: number;
}

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
  private pbrPipeline: GPURenderPipeline | null = null;
  private pbrShaderModule: GPUShaderModule | null = null;
  private pbrCameraBuffer: GPUBuffer | null = null;
  private pbrModelBuffer: GPUBuffer | null = null;
  private pbrPrevModelBuffer: GPUBuffer | null = null;
  private pbrMaterialBuffer: GPUBuffer | null = null;
  private pbrCameraBindGroup: GPUBindGroup | null = null;
  private pbrMaterialBindGroup: GPUBindGroup | null = null;
  private pbrMaterial: PBRMaterialResources | null = null;
  private lastViewProj: Mat4 = mat4.identity();

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

  setPBRMaterial(resources: PBRMaterialResources): void {
    this.pbrMaterial = resources;
    this.pbrPipeline = null;
    this.pbrMaterialBindGroup = null;
  }

  private ensurePBRPipeline(): void {
    if (this.pbrPipeline || !this.mesh) return;

    if (!this.pbrShaderModule) {
      this.pbrShaderModule = this.device.createShaderModule({ code: PBR_GBUFFER_SHADER });
    }

    this.pbrCameraBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrModelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrPrevModelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pbrMaterialBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pbrPipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.pbrShaderModule,
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
        module: this.pbrShaderModule,
        entryPoint: "fs_main",
        targets: [
          { format: "rgba8unorm" },
          { format: "rgba8unorm" },
          { format: "rgba8unorm" },
          { format: "rg16float" },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    this.pbrCameraBindGroup = this.device.createBindGroup({
      layout: this.pbrPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pbrCameraBuffer } },
        { binding: 1, resource: { buffer: this.pbrModelBuffer } },
        { binding: 2, resource: { buffer: this.pbrPrevModelBuffer } },
      ],
    });
  }

  private ensurePBRMaterialBindGroup(): void {
    if (this.pbrMaterialBindGroup || !this.pbrPipeline || !this.pbrMaterial || !this.pbrMaterialBuffer) return;

    const mat = this.pbrMaterial;
    const matData = new Float32Array(8);
    matData[0] = mat.baseColor[0];
    matData[1] = mat.baseColor[1];
    matData[2] = mat.baseColor[2];
    matData[3] = mat.baseColor[3];
    matData[4] = mat.roughness;
    matData[5] = mat.metallic;
    matData[6] = mat.emissiveIntensity;
    matData[7] = 0;
    this.device.queue.writeBuffer(this.pbrMaterialBuffer, 0, matData as unknown as BufferSource);

    this.pbrMaterialBindGroup = this.device.createBindGroup({
      layout: this.pbrPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.pbrMaterialBuffer } },
        { binding: 1, resource: mat.albedoTexture },
        { binding: 2, resource: mat.sampler },
        { binding: 3, resource: mat.normalTexture },
        { binding: 4, resource: mat.sampler },
        { binding: 5, resource: mat.metallicRoughnessTexture },
        { binding: 6, resource: mat.sampler },
        { binding: 7, resource: mat.aoTexture },
        { binding: 8, resource: mat.sampler },
        { binding: 9, resource: mat.emissiveTexture },
        { binding: 10, resource: mat.sampler },
      ],
    });
  }

  private updatePBRCamera(viewProj: Mat4): void {
    if (!this.pbrCameraBuffer || !this.pbrModelBuffer || !this.pbrPrevModelBuffer) return;
    const camData = new Float32Array(32);
    camData.set(viewProj as Float32Array, 0);
    camData.set(this.prevViewProj as Float32Array, 16);
    this.device.queue.writeBuffer(this.pbrCameraBuffer, 0, camData as unknown as BufferSource);
    this.device.queue.writeBuffer(this.pbrModelBuffer, 0, this.modelMatrix as unknown as BufferSource);
    this.device.queue.writeBuffer(this.pbrPrevModelBuffer, 0, this.prevModelMatrix as unknown as BufferSource);
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
    this.lastViewProj = viewProj;
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
    if (!this.vertexBuffer || !this.indexBuffer || !this.mesh) return;

    const tracked = ctx.pass instanceof TrackedRenderPass
      ? ctx.pass
      : new TrackedRenderPass(ctx.pass);

    if (this.pbrMaterial && this.mode === "gbuffer") {
      this.ensurePBRPipeline();
      this.ensurePBRMaterialBindGroup();
      if (!this.pbrPipeline || !this.pbrCameraBindGroup || !this.pbrMaterialBindGroup) return;
      this.updatePBRCamera(this.lastViewProj);
      tracked.setPipeline(this.pbrPipeline);
      tracked.setBindGroup(0, this.pbrCameraBindGroup);
      tracked.setBindGroup(1, this.pbrMaterialBindGroup);
      tracked.setVertexBuffer(0, this.vertexBuffer);
      tracked.setIndexBuffer(this.indexBuffer, this.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(this.mesh.indexCount);
      return;
    }

    if (!this.pipeline || !this.bindGroup) return;
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
    this.pbrCameraBuffer?.destroy();
    this.pbrModelBuffer?.destroy();
    this.pbrPrevModelBuffer?.destroy();
    this.pbrMaterialBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.depthTexture = null;
    this.cameraBuffer = null;
    this.pbrPipeline = null;
    this.pbrCameraBuffer = null;
    this.pbrModelBuffer = null;
    this.pbrPrevModelBuffer = null;
    this.pbrMaterialBuffer = null;
    this.pbrMaterialBindGroup = null;
    this.pbrMaterial = null;
  }
}
