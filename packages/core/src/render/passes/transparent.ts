import { createValidatedShaderModule } from "../shader-validator";
import { type Mat4 } from "wgpu-matrix";
import type { MeshData } from "../../mesh/builder";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, packLightUniform, packPointLights, packSpotLightsExtended, type LightUniformData } from "../lighting";
import { RenderPass } from "../render-pass";
import { destroyMapValues } from "../resource-tracker";

const TRANSPARENT_SHADER = `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var modelUniform: mat4x4<f32>;

struct LightUniforms {
  dirDirection: vec4<f32>,
  dirColor: vec4<f32>,
  hemiDirIntensity: vec4<f32>,
  hemiSkyColor: vec4<f32>,
  hemiGroundColor: vec4<f32>,
  ambient: vec4<f32>,
  lightCount: vec4<f32>,
};

@group(0) @binding(2) var<uniform> lights: LightUniforms;
@group(0) @binding(3) var<storage> pointLights: array<vec4<f32>>;
@group(0) @binding(4) var<storage> spotLights: array<vec4<f32>>;

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
  @location(2) worldPos: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = modelUniform * vec4<f32>(input.position, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.color = input.color;
  output.normal = normalize((modelUniform * vec4<f32>(input.normal, 0.0)).xyz);
  output.worldPos = worldPos.xyz;
  return output;
}

fn pointLightContribution(
  albedo: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  worldPos: vec3<f32>,
) -> vec3<f32> {
  var result = vec3<f32>(0.0);
  let count = u32(lights.lightCount.x);
  for (var i = 0u; i < ${MAX_POINT_LIGHTS}u; i = i + 1u) {
    if (i >= count) { break; }
    let pos = pointLights[i * 2u].xyz;
    let intensity = pointLights[i * 2u].w;
    let lightColor = pointLights[i * 2u + 1u].xyz;
    let range = pointLights[i * 2u + 1u].w;
    let toLight = pos - worldPos;
    let dist = length(toLight);
    if (dist > range) { continue; }
    let L = toLight / dist;
    let NdotL = max(dot(N, L), 0.0);
    let attenuation = 1.0 / (1.0 + 0.5 * dist * dist);
    result += albedo * lightColor * intensity * NdotL * attenuation;
  }
  return result;
}

fn spotLightContribution(
  albedo: vec3<f32>,
  N: vec3<f32>,
  V: vec3<f32>,
  worldPos: vec3<f32>,
) -> vec3<f32> {
  var result = vec3<f32>(0.0);
  let count = u32(lights.lightCount.y);
  for (var i = 0u; i < ${MAX_SPOT_LIGHTS}u; i = i + 1u) {
    if (i >= count) { break; }
    let base = i * 4u;
    let pos = spotLights[base].xyz;
    let intensity = spotLights[base].w;
    let dir = spotLights[base + 1u].xyz;
    let range = spotLights[base + 1u].w;
    let lightColor = spotLights[base + 2u].xyz;
    let innerCos = spotLights[base + 2u].w;
    let outerCos = spotLights[base + 3u].x;
    let toLight = pos - worldPos;
    let dist = length(toLight);
    if (dist > range) { continue; }
    let L = toLight / dist;
    let spotCos = dot(-L, dir);
    if (spotCos < outerCos) { continue; }
    let spotAtten = smoothstep(outerCos, innerCos, spotCos);
    let attenuation = (1.0 / (1.0 + 0.5 * dist * dist)) * spotAtten;
    let NdotL = max(dot(N, L), 0.0);
    result += albedo * lightColor * intensity * NdotL * attenuation;
  }
  return result;
}

fn hemisphereAmbient(N: vec3<f32>) -> vec3<f32> {
  if (lights.hemiDirIntensity.w < 0.5) {
    return lights.ambient.rgb * lights.ambient.w;
  }
  let up = normalize(lights.hemiDirIntensity.xyz);
  let hemiMix = max(dot(N, up), 0.0);
  return mix(lights.hemiGroundColor.rgb, lights.hemiSkyColor.rgb, hemiMix) * lights.hemiDirIntensity.w;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let V = normalize(camera.cameraPos - input.worldPos);
  let L = normalize(-lights.dirDirection.xyz);
  let NdotL = max(dot(N, L), 0.0);
  let ambient = hemisphereAmbient(N);
  let directional = input.color.rgb * lights.dirColor.rgb * lights.dirDirection.w * NdotL;
  let pointLights = pointLightContribution(input.color.rgb, N, V, input.worldPos);
  let spotLights = spotLightContribution(input.color.rgb, N, V, input.worldPos);
  let color = input.color.rgb * ambient + directional + pointLights + spotLights;
  return vec4<f32>(color, input.color.a);
}
`;

export interface TransparentRenderItem {
  mesh: MeshData;
  modelMatrix: Mat4;
  distance: number;
}

export class TransparentPass extends RenderPass {
  name = "transparent";
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipelines: Map<number, GPURenderPipeline> = new Map();
  private bindGroups: Map<number, GPUBindGroup> = new Map();
  private shaderModule: GPUShaderModule | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private modelBuffer: GPUBuffer | null = null;
  private lightBuffer: GPUBuffer | null = null;
  private pointLightBuffer: GPUBuffer | null = null;
  private spotLightBuffer: GPUBuffer | null = null;
  private renderItems: TransparentRenderItem[] = [];
  private vertexBuffers: Map<MeshData, GPUBuffer> = new Map();
  private indexBuffers: Map<MeshData, GPUBuffer> = new Map();

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
  }

  private surfaceFormat: GPUTextureFormat;

  prepare(_device: GPUDevice): void {
    if (!this.shaderModule) {
      this.shaderModule = createValidatedShaderModule(this.device, { code: TRANSPARENT_SHADER, label: "TransparentPass" });
    }

    this.cameraBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.lightBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pointLightBuffer = this.device.createBuffer({
      size: MAX_POINT_LIGHTS * 32,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.spotLightBuffer = this.device.createBuffer({
      size: MAX_SPOT_LIGHTS * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private getPipeline(stride: number): GPURenderPipeline {
    let pipeline = this.pipelines.get(stride);
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.shaderModule!,
          entryPoint: "vs_main",
          buffers: [{
            arrayStride: stride,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x4" },
            ],
          }],
        },
        fragment: {
          module: this.shaderModule!,
          entryPoint: "fs_main",
          targets: [{
            format: this.surfaceFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          }],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: "depth32float",
          depthWriteEnabled: false,
          depthCompare: "less",
        },
      });
      this.pipelines.set(stride, pipeline);
      this.bindGroups.set(stride, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer! } },
          { binding: 1, resource: { buffer: this.modelBuffer! } },
          { binding: 2, resource: { buffer: this.lightBuffer! } },
          { binding: 3, resource: { buffer: this.pointLightBuffer! } },
          { binding: 4, resource: { buffer: this.spotLightBuffer! } },
        ],
      }));
    }
    return pipeline;
  }

  setCameraViewProj(viewProj: Mat4, cameraPos?: [number, number, number]): void {
    const data = new Float32Array(20);
    data.set(viewProj as Float32Array, 0);
    if (cameraPos) {
      data[16] = cameraPos[0];
      data[17] = cameraPos[1];
      data[18] = cameraPos[2];
    }
    this.device.queue.writeBuffer(this.cameraBuffer!, 0, data as unknown as BufferSource);
  }

  setLightData(lightData: LightUniformData): void {
    const packed = packLightUniform(lightData);
    this.device.queue.writeBuffer(this.lightBuffer!, 0, packed as unknown as BufferSource);
    const pointPacked = packPointLights(lightData);
    this.device.queue.writeBuffer(this.pointLightBuffer!, 0, pointPacked as unknown as BufferSource);
    const spotPacked = packSpotLightsExtended(lightData);
    this.device.queue.writeBuffer(this.spotLightBuffer!, 0, spotPacked as unknown as BufferSource);
  }

  addItem(mesh: MeshData, modelMatrix: Mat4, distance: number): void {
    this.renderItems.push({ mesh, modelMatrix, distance });
  }

  clearItems(): void {
    this.renderItems.length = 0;
  }

  hasItems(): boolean {
    return this.renderItems.length > 0;
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.shaderModule || this.renderItems.length === 0 || !ctx.pass) return;

    this.setCameraViewProj(ctx.viewProj, ctx.cameraPos);
    this.setLightData(ctx.lightData);

    this.renderItems.sort((a, b) => b.distance - a.distance);

    const firstStride = this.renderItems[0].mesh.layout.stride;
    const pipeline = this.getPipeline(firstStride);
    const bindGroup = this.bindGroups.get(firstStride)!;

    const tracked = ctx.pass;
    tracked.setPipeline(pipeline);
    tracked.setBindGroup(0, bindGroup);

    for (let i = 0; i < this.renderItems.length; i++) {
      const item = this.renderItems[i];
      this.device.queue.writeBuffer(this.modelBuffer!, 0, item.modelMatrix as unknown as BufferSource);
      tracked.setVertexBuffer(0, this.getVertexBuffer(item.mesh));
      tracked.setIndexBuffer(this.getIndexBuffer(item.mesh), item.mesh.indices instanceof Uint16Array ? "uint16" : "uint32");
      tracked.drawIndexed(item.mesh.indexCount);
    }
  }

  private getVertexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.vertexBuffers.get(mesh);
    if (!buf) {
      buf = this.device.createBuffer({
        size: mesh.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.vertices.buffer);
      this.vertexBuffers.set(mesh, buf);
    }
    return buf;
  }

  private getIndexBuffer(mesh: MeshData): GPUBuffer {
    let buf = this.indexBuffers.get(mesh);
    if (!buf) {
      buf = this.device.createBuffer({
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(buf, 0, mesh.indices.buffer);
      this.indexBuffers.set(mesh, buf);
    }
    return buf;
  }

  destroy(): void {
    this.cameraBuffer?.destroy();
    this.modelBuffer?.destroy();
    this.lightBuffer?.destroy();
    this.pointLightBuffer?.destroy();
    this.spotLightBuffer?.destroy();
    for (const buf of this.vertexBuffers.values()) buf.destroy();
    for (const buf of this.indexBuffers.values()) buf.destroy();
    this.vertexBuffers.clear();
    this.indexBuffers.clear();
    destroyMapValues(this.pipelines);
    destroyMapValues(this.bindGroups);
  }
}
