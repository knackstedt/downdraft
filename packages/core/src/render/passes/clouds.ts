import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, u32, vec3f, wgsl } from "@downdraft/shader-graph";
import { type Mat4 } from "wgpu-matrix";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

// ─── Uniform structs (single source of truth for layout) ───────────────────
const CloudUniformsStruct: WgslStruct = wgsl.struct("CloudUniforms", {
  viewProj: mat4x4f,
  cameraPos: vec3f,
  timeOfDay: f32,
  weatherType: u32,
  sunDir: vec3f,
  sunIntensity: f32,
  moonDir: vec3f,
  moonIntensity: f32,
  time: f32,
  weatherBlend: f32,
  fogColor: vec3f,
  fogDensity: f32,
});

const PerLayerUniformsStruct: WgslStruct = wgsl.struct("PerLayerUniforms", {
  layerPos: vec3f,
  _pad: f32,
});

const CLOUD_SHADER = /* wgsl */ `
${CloudUniformsStruct.wgsl}

@group(0) @binding(0) var<uniform> uniforms: CloudUniforms;

${PerLayerUniformsStruct.wgsl}

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
  hdrHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private surfaceFormat: GPUTextureFormat;
  private msaaSampleCount: number = 1;
  private layers: CloudLayerData[] = [];
  private _uniformView: StructView | null = null;
  private _uniformBuf: Float32Array | null = null;
  private _perLayerView: StructView | null = null;
  private _perLayerBuf: Float32Array | null = null;

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
    this._uniformBuf = new Float32Array(CloudUniformsStruct.floatCount);
    this._uniformView = CloudUniformsStruct.view(this._uniformBuf);
    this._perLayerBuf = new Float32Array(PerLayerUniformsStruct.floatCount);
    this._perLayerView = PerLayerUniformsStruct.view(this._perLayerBuf);

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
    const view = this._uniformView!;
    view.set("viewProj", u.viewProj as Float32Array);
    view.set("cameraPos", u.cameraPos);
    view.set("timeOfDay", u.timeOfDay);
    view.setU32("weatherType", u.weatherType);
    view.set("sunDir", u.sunDir);
    view.set("sunIntensity", u.sunIntensity);
    view.set("moonDir", u.moonDir);
    view.set("moonIntensity", u.moonIntensity);
    view.set("time", u.time);
    view.set("weatherBlend", u.weatherBlend);
    view.set("fogColor", u.fogColor);
    view.set("fogDensity", u.fogDensity);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformBuf! as unknown as BufferSource);
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
    const view = this._perLayerView!;
    view.set("layerPos", layerPos);
    this.device.queue.writeBuffer(layer.perLayerUniform, 0, this._perLayerBuf! as unknown as BufferSource);
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

  setup(builder: FrameGraphBuilder): void {
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !this.uniformBuffer || !ctx.pass) return;

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);

    for (const layer of this.layers) {
      if (layer.indexCount === 0) continue;
      this.ensureLayerBindGroup(layer);
      if (!layer.bindGroup) continue;

      const perLayerView = this._perLayerView!;
      perLayerView.set("layerPos", layer.layerPos);
      this.device.queue.writeBuffer(layer.perLayerUniform, 0, this._perLayerBuf! as unknown as BufferSource);

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
    this._uniformView = null;
    this._uniformBuf = null;
    this._perLayerView = null;
    this._perLayerBuf = null;
  }
}
