import { type Mat4 } from "wgpu-matrix";
import type { FrameGraphBuilder, GraphRenderContext, TextureHandle } from "../frame-graph";
import { RenderPass } from "../render-pass";

const TERRAIN_SHADER = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  patchSize: f32,
  originX: f32,
  originZ: f32,
  _pad0: f32,
  sunDir: vec3<f32>,
  sunIntensity: f32,
  timeOfDay: f32,
  waterHeight: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) depth: f32,
  @location(2) normal: vec3<f32>,
};

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pp = p;
  for (var i = 0; i < 5; i++) {
    v += a * noise(pp);
    pp = pp * 2.0;
    a *= 0.5;
  }
  return v;
}

fn ridgedNoise(p: vec2<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pp = p;
  for (var i = 0; i < 4; i++) {
    let n = noise(pp);
    v += a * (1.0 - abs(n * 2.0 - 1.0));
    pp = pp * 2.0;
    a *= 0.5;
  }
  return v;
}

fn terrainHeight(x: f32, z: f32) -> f32 {
  let p = vec2<f32>(x * 0.01, z * 0.01);
  var h = 0.0;
  h += fbm(p) * 40.0;
  h += ridgedNoise(p * 2.0) * 15.0;
  h += noise(p * 8.0) * 5.0;
  return -h - 10.0;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldX = uniforms.originX + input.position.x * 4.0;
  let worldZ = uniforms.originZ + input.position.y * 4.0;
  let h = terrainHeight(worldX, worldZ);
  let worldPos = vec3<f32>(worldX, h, worldZ);
  output.worldPos = worldPos;
  output.depth = -h;

  // Compute normal by sampling neighbor heights
  let eps = 2.0;
  let hL = terrainHeight(worldX - eps, worldZ);
  let hR = terrainHeight(worldX + eps, worldZ);
  let hD = terrainHeight(worldX, worldZ - eps);
  let hU = terrainHeight(worldX, worldZ + eps);
  output.normal = normalize(vec3<f32>(hL - hR, 2.0 * eps, hD - hU));

  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  return output;
}

fn sandRipples(worldPos: vec3<f32>, depth: f32) -> f32 {
  let rippleScale = 1.0 - smoothstep(0.0, 80.0, depth);
  let rp = vec2<f32>(worldPos.x * 0.15, worldPos.z * 0.15);
  let ripple = sin(rp.x + noise(rp * 0.5) * 3.0) * 0.5 + 0.5;
  let ripple2 = sin(worldPos.x * 0.08 + worldPos.z * 0.06 + noise(rp * 0.3) * 2.0) * 0.5 + 0.5;
  return (ripple * 0.6 + ripple2 * 0.4) * rippleScale;
}

fn grainNoise(worldPos: vec3<f32>) -> f32 {
  let gp = vec2<f32>(worldPos.x * 2.5, worldPos.z * 2.5);
  return noise(gp) * 0.15 + noise(gp * 3.0) * 0.08;
}

fn caustics(worldPos: vec3<f32>, depth: f32, time: f32) -> f32 {
  let causticStrength = 1.0 - smoothstep(0.0, 120.0, depth);
  let cuv = vec2<f32>(worldPos.x * 0.05, worldPos.z * 0.05) + vec2<f32>(time * 0.08, time * 0.06);
  let n1 = noise(cuv * 3.0);
  let n2 = noise(cuv * 5.0 + vec2<f32>(10.0, 5.0));
  let n3 = noise(cuv * 8.0 + vec2<f32>(20.0, 15.0));
  let c = abs(n1 * 0.5 + n2 * 0.3 + n3 * 0.2 - 0.5);
  return pow(1.0 - c, 3.0) * causticStrength;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = input.depth;
  let N = normalize(input.normal);
  let sunDir = normalize(uniforms.sunDir);

  // Base color palette — sand to mud to deep sediment
  let sandColor = vec3<f32>(0.72, 0.62, 0.42);
  let wetSandColor = vec3<f32>(0.55, 0.45, 0.30);
  let mudColor = vec3<f32>(0.35, 0.30, 0.20);
  let rockColor = vec3<f32>(0.25, 0.23, 0.20);
  let deepColor = vec3<f32>(0.08, 0.09, 0.07);

  // Depth-based color gradient
  var color = mix(sandColor, wetSandColor, smoothstep(5.0, 25.0, depth));
  color = mix(color, mudColor, smoothstep(25.0, 60.0, depth));
  color = mix(color, rockColor, smoothstep(60.0, 120.0, depth));
  color = mix(color, deepColor, smoothstep(120.0, 250.0, depth));

  // Procedural texture detail
  let ripples = sandRipples(input.worldPos, depth);
  let grain = grainNoise(input.worldPos);
  color *= 0.75 + ripples * 0.35 + grain;

  // Large-scale variation from terrain noise
  let varNoise = fbm(vec2<f32>(input.worldPos.x * 0.02, input.worldPos.z * 0.02));
  color *= 0.85 + varNoise * 0.3;

  // Directional sun lighting (half-Lambert for softer underwater look)
  let NdotL = dot(N, sunDir);
  let halfLambert = NdotL * 0.5 + 0.5;
  let sunLight = halfLambert * halfLambert * uniforms.sunIntensity;

  // Depth-based ambient — bluer in shallow water, darker in deep
  let shallowAmbient = vec3<f32>(0.15, 0.25, 0.30);
  let deepAmbient = vec3<f32>(0.02, 0.03, 0.04);
  let ambient = mix(shallowAmbient, deepAmbient, smoothstep(0.0, 150.0, depth));

  // Apply lighting
  color = color * (ambient + sunLight * vec3<f32>(1.0, 0.95, 0.8) * 0.6);

  // Caustics — animated light patterns on the seabed
  let c = caustics(input.worldPos, depth, uniforms.time);
  color += vec3<f32>(0.3, 0.45, 0.5) * c * uniforms.sunIntensity * 0.5;

  // Night darkening
  let nightFactor = 1.0 - smoothstep(0.2, 0.5, uniforms.timeOfDay);
  color *= 1.0 - nightFactor * 0.6;

  // Distance fog — blend to underwater color
  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = 1.0 - exp(-dist * 0.004);
  let fogColor = vec3<f32>(0.02, 0.08, 0.12);
  color = mix(color, fogColor, clamp(fogFactor, 0.0, 0.95));

  return vec4<f32>(color, 1.0);
}
`;

export interface TerrainUniforms {
  viewProj: Mat4;
  cameraPos: [number, number, number];
  time: number;
  patchSize: number;
  originX: number;
  originZ: number;
  sunDir?: [number, number, number];
  sunIntensity?: number;
  timeOfDay?: number;
  waterHeight?: number;
}

export class TerrainPass extends RenderPass {
  name = "terrain";
  hdrHandle: TextureHandle | null = null;
  depthHandle: TextureHandle | null = null;
  private device: GPUDevice;
  private pipeline: GPURenderPipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;
  private surfaceFormat: GPUTextureFormat;
  private msaaSampleCount: number = 1;
  private gridSize: number;
  private uniformData = new Float32Array(32);

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat, msaaSampleCount = 1, gridSize = 128) {
    super();
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.msaaSampleCount = msaaSampleCount;
    this.gridSize = gridSize;
  }

  prepare(_device: GPUDevice): void {
    if (this.pipeline) return;

    const gridSize = this.gridSize;
    const vertices: number[] = [];
    for (let z = 0; z <= gridSize; z++) {
      for (let x = 0; x <= gridSize; x++) {
        vertices.push(x, z);
      }
    }
    const indices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const i = z * (gridSize + 1) + x;
        indices.push(i, i + 1, i + gridSize + 1);
        indices.push(i + 1, i + gridSize + 2, i + gridSize + 1);
      }
    }
    this.indexCount = indices.length;

    const dev = this.device;
    this.shaderModule = dev.createShaderModule({ code: TERRAIN_SHADER });
    this.uniformBuffer = dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.vertexBuffer = dev.createBuffer({ size: vertices.length * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));
    this.indexBuffer = dev.createBuffer({ size: indices.length * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.indexBuffer, 0, new Uint16Array(indices));
    this.pipeline = dev.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.shaderModule, entryPoint: "vs_main",
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }],
      },
      fragment: { module: this.shaderModule, entryPoint: "fs_main", targets: [{ format: this.surfaceFormat }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: this.msaaSampleCount },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.bindGroup = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  setUniforms(u: TerrainUniforms): void {
    if (!this.uniformBuffer) return;
    const data = this.uniformData;
    data.set(u.viewProj as Float32Array, 0);
    data[16] = u.cameraPos[0];
    data[17] = u.cameraPos[1];
    data[18] = u.cameraPos[2];
    data[19] = u.time;
    data[20] = u.patchSize;
    data[21] = u.originX;
    data[22] = u.originZ;
    // data[23] = padding (vec3 alignment)
    const sd = u.sunDir ?? [0, 1, 0];
    data[24] = sd[0];
    data[25] = sd[1];
    data[26] = sd[2];
    data[27] = u.sunIntensity ?? 1.0;
    data[28] = u.timeOfDay ?? 0.5;
    data[29] = u.waterHeight ?? 0.0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  setup(builder: FrameGraphBuilder): void {
    if (this.depthHandle) builder.depthAttachment({ handle: this.depthHandle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
    if (this.hdrHandle) builder.colorAttachment({ handle: this.hdrHandle, loadOp: "load", storeOp: "store" });
  }

  execute(ctx: GraphRenderContext): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer || !this.indexBuffer || !ctx.pass) return;

    const tracked = ctx.pass;
    tracked.setPipeline(this.pipeline);
    tracked.setBindGroup(0, this.bindGroup);
    tracked.setVertexBuffer(0, this.vertexBuffer);
    tracked.setIndexBuffer(this.indexBuffer, "uint16");
    tracked.drawIndexed(this.indexCount);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.pipeline = null;
    this.shaderModule = null;
    this.bindGroup = null;
  }
}
