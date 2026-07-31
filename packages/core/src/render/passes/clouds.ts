import type { RenderPassContext } from "../render-pass.ts";
import { RenderPass } from "../render-pass.ts";
import { TrackedRenderPass } from "../tracked-render-pass.ts";
import { mat4, type Mat4 } from "wgpu-matrix";

const CLOUD_SHADER = /* wgsl */ `
struct CloudUniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  timeOfDay: f32,
  weatherType: u32,
  sunDir: vec3<f32>,
  sunIntensity: f32,
  moonDir: vec3<f32>,
  moonIntensity: f32,
  time: f32,
  weatherBlend: f32,
  fogColor: vec3<f32>,
  fogDensity: f32,
};

@group(0) @binding(0) var<uniform> uniforms: CloudUniforms;

struct PerLayerUniforms {
  layerPos: vec3<f32>,
  _pad: f32,
};

@group(0) @binding(1) var<uniform> perLayer: PerLayerUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) viewDist: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = input.position + perLayer.layerPos;
  output.worldPos = worldPos;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  output.normal = input.normal;
  output.color = input.color;
  output.viewDist = length(uniforms.cameraPos - worldPos);
  return output;
}

fn weatherTint(weather: u32) -> vec3<f32> {
  if (weather == 0u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 1u) { return vec3<f32>(1.0, 1.0, 1.0); }
  if (weather == 2u) { return vec3<f32>(0.7, 0.7, 0.72); }
  if (weather == 3u) { return vec3<f32>(0.55, 0.55, 0.58); }
  if (weather == 4u) { return vec3<f32>(0.25, 0.25, 0.30); }
  if (weather == 5u) { return vec3<f32>(0.6, 0.6, 0.62); }
  if (weather == 8u) { return vec3<f32>(0.4, 0.15, 0.08); }
  if (weather == 9u) { return vec3<f32>(0.85, 0.88, 0.92); }
  return vec3<f32>(1.0, 1.0, 1.0);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(input.normal);
  let baseColor = input.color;

  let sunDir = normalize(uniforms.sunDir);
  let moonDir = normalize(uniforms.moonDir);
  let sunNdotL = max(dot(N, sunDir), 0.0);
  let moonNdotL = max(dot(N, moonDir), 0.0);

  let dayFactor = smoothstep(0.2, 0.4, uniforms.timeOfDay) * (1.0 - smoothstep(0.65, 0.8, uniforms.timeOfDay));
  let sunsetFactor = smoothstep(0.15, 0.25, uniforms.timeOfDay) * (1.0 - smoothstep(0.25, 0.35, uniforms.timeOfDay))
    + smoothstep(0.65, 0.75, uniforms.timeOfDay) * (1.0 - smoothstep(0.75, 0.85, uniforms.timeOfDay));

  let sunColor = mix(vec3<f32>(1.0, 0.6, 0.3), vec3<f32>(1.0, 0.97, 0.9), dayFactor);
  let moonColor = vec3<f32>(0.7, 0.7, 0.75);

  let sunLight = sunColor * sunNdotL * uniforms.sunIntensity;
  let moonLight = moonColor * moonNdotL * uniforms.moonIntensity;
  let ambient = vec3<f32>(0.45, 0.45, 0.47) * (0.4 + dayFactor * 0.4);

  let bottomFactor = max(-N.y, 0.0);
  let bounceColor = mix(vec3<f32>(0.8, 0.82, 0.85), vec3<f32>(1.0, 0.9, 0.75), dayFactor);
  let bounce = bounceColor * bottomFactor * (0.3 + dayFactor * 0.3);

  var litColor = baseColor * (sunLight + moonLight + ambient + bounce);
  litColor = mix(litColor, litColor * vec3<f32>(1.0, 0.6, 0.4), sunsetFactor * 0.4);

  let tint = weatherTint(uniforms.weatherType);
  litColor = mix(litColor, litColor * tint, 0.5);

  let V = normalize(uniforms.cameraPos - input.worldPos);
  let NdotV = max(dot(N, V), 0.0);
  let edgeAlpha = smoothstep(0.0, 0.15, NdotV);
  let distFade = 1.0 - smoothstep(2000.0, 4000.0, input.viewDist);
  let baseAlpha = 0.65 + 0.3 * NdotV;
  let alpha = baseAlpha * edgeAlpha * distFade;

  let fogFactor = 1.0 - exp(-uniforms.fogDensity * input.viewDist);
  litColor = mix(litColor, uniforms.fogColor, fogFactor * 0.5);

  return vec4<f32>(litColor, alpha);
}
`;

export interface CloudUniforms {
  viewProj: Mat4;
  cameraPos: [number, number, number];
  timeOfDay: number;
  weatherType: number;
  sunDir: [number, number, number];
  sunIntensity: number;
  moonDir: [number, number, number];
  moonIntensity: number;
  time: number;
  weatherBlend: number;
  fogColor: [number, number, number];
  fogDensity: number;
}

export interface CloudLayerData {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  useUint32: boolean;
  perLayerUniform: GPUBuffer;
  bindGroup: GPUBindGroup | null;
  layerPos: [number, number, number];
}

export class CloudPass extends RenderPass {
  name = "clouds";
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private surfaceFormat: GPUTextureFormat;
  private msaaSampleCount: number = 1;
  private layers: CloudLayerData[] = [];

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, msaaSampleCount = 1) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.msaaSampleCount = msaaSampleCount;
  }

  prepare(_device: GPUDevice): void {
    if (this.pipeline) return;

    this.shaderModule = this.device.createShaderModule({ code: CLOUD_SHADER });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    });
  }

  setUniforms(u: CloudUniforms): void {
    if (!this.uniformBuffer) return;
    const data = new Float32Array(40);
    data.set(u.viewProj as Float32Array, 0);
    data[16] = u.cameraPos[0];
    data[17] = u.cameraPos[1];
    data[18] = u.cameraPos[2];
    data[19] = u.timeOfDay;
    const u32View = new Uint32Array(data.buffer);
    u32View[20] = u.weatherType;
    data[24] = u.sunDir[0];
    data[25] = u.sunDir[1];
    data[26] = u.sunDir[2];
    data[27] = u.sunIntensity;
    data[28] = u.moonDir[0];
    data[29] = u.moonDir[1];
    data[30] = u.moonDir[2];
    data[31] = u.moonIntensity;
    data[32] = u.time;
    data[33] = u.weatherBlend;
    data[36] = u.fogColor[0];
    data[37] = u.fogColor[1];
    data[38] = u.fogColor[2];
    data[39] = u.fogDensity;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data as unknown as BufferSource);
  }

  addLayer(layer: CloudLayerData): void {
    this.layers.push(layer);
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.vertexBuffer.destroy();
      layer.indexBuffer.destroy();
      layer.perLayerUniform.destroy();
    }
    this.layers = [];
  }

  updateLayer(index: number, layerPos: [number, number, number]): void {
    const layer = this.layers[index];
    if (!layer) return;
    layer.layerPos = layerPos;
    const data = new Float32Array(4);
    data[0] = layerPos[0];
    data[1] = layerPos[1];
    data[2] = layerPos[2];
    this.device.queue.writeBuffer(layer.perLayerUniform, 0, data as unknown as BufferSource);
  }

  private ensureLayerBindGroup(layer: CloudLayerData): void {
    if (layer.bindGroup || !this.pipeline || !this.uniformBuffer) return;
    layer.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: layer.perLayerUniform, size: 16 } },
      ],
    });
  }

  execute(ctx: RenderPassContext): void {
    if (!this.pipeline || !this.uniformBuffer) return;

    const tracked = ctx.pass instanceof TrackedRenderPass ? ctx.pass : new TrackedRenderPass(ctx.pass);
    tracked.setPipeline(this.pipeline);

    for (const layer of this.layers) {
      if (layer.indexCount === 0) continue;
      this.ensureLayerBindGroup(layer);
      if (!layer.bindGroup) continue;

      const data = new Float32Array(4);
      data[0] = layer.layerPos[0];
      data[1] = layer.layerPos[1];
      data[2] = layer.layerPos[2];
      this.device.queue.writeBuffer(layer.perLayerUniform, 0, data as unknown as BufferSource);

      tracked.setBindGroup(0, layer.bindGroup, [0]);
      tracked.setVertexBuffer(0, layer.vertexBuffer);
      tracked.setIndexBuffer(layer.indexBuffer, layer.useUint32 ? "uint32" : "uint16");
      tracked.drawIndexed(layer.indexCount);
    }
  }

  destroy(): void {
    this.clearLayers();
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
  }
}
