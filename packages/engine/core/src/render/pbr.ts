// ============================================================================
// PBR System — BRDF integration LUT + IBL environment textures
// Generates a pre-computed BRDF LUT on the GPU via a compute shader.
// Provides bind group layout for PBR resources shared across all entity pipelines.
// ============================================================================

import { createValidatedShaderModule } from "./shader-validator";

const BRDF_LUT_SIZE = 256;
const SAMPLE_COUNT = 1024;

const PI = Math.PI;

// GPUTextureUsage flags — use numeric literals for environments without WebGPU globals (e.g. Bun test)
const TEXTURE_BINDING_USAGE = 0x04;   // GPUTextureUsage.TEXTURE_BINDING
const STORAGE_BINDING_USAGE = 0x08;   // GPUTextureUsage.STORAGE_BINDING
const UNIFORM_BUFFER_USAGE = 0x40 | 0x08; // GPUBufferUsage.UNIFORM | COPY_DST

// GPUShaderStage flags
const SHADER_STAGE_FRAGMENT = 0x02;   // GPUShaderStage.FRAGMENT
const SHADER_STAGE_COMPUTE = 0x04;    // GPUShaderStage.COMPUTE

// --- CPU reference implementation (used for testing / WebGL2 fallback) ---

export function radicalInverseVdC(bits: number): number {
  let v = bits >>> 0;
  v = ((v >>> 16) & 0xffff) | ((v & 0xffff) << 16);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  return (v >>> 0) / 4294967296.0;
}

export function hammersley(i: number, n: number): [number, number] {
  return [i / n, radicalInverseVdC(i)];
}

export function geometrySchlickGGX(NdotV: number, roughness: number): number {
  const r = roughness + 1.0;
  const k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

export function geometrySmith(NdotV: number, NdotL: number, roughness: number): number {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

export function integrateBRDF(NdotV: number, roughness: number): [number, number] {
  const V = [
    Math.sqrt(1.0 - NdotV * NdotV),
    0.0,
    NdotV,
  ];

  let A = 0.0;
  let B = 0.0;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const xi = hammersley(i, SAMPLE_COUNT);

    const a = roughness * roughness;
    const phi = 2.0 * PI * xi[0];
    const cosTheta = Math.sqrt((1.0 - xi[1]) / (1.0 + (a * a - 1.0) * xi[1]));
    const sinTheta = Math.sqrt(1.0 - cosTheta * cosTheta);

    const Hx = sinTheta * Math.cos(phi);
    const Hy = sinTheta * Math.sin(phi);
    const Hz = cosTheta;

    const VdotH = Math.max(V[0] * Hx + V[1] * Hy + V[2] * Hz, 0.0);
    const NdotH = Math.max(Hz, 0.0);

    const Lx = 2.0 * VdotH * Hx - V[0];
    const Ly = 2.0 * VdotH * Hy - V[1];
    const Lz = 2.0 * VdotH * Hz - V[2];
    const Llen = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz) || 1.0;
    const NdotL = Math.max(Lz / Llen, 0.0);

    if (NdotL > 0.0) {
      const G = geometrySmith(NdotV, NdotL, roughness);
      const G_Vis = (G * VdotH) / (NdotH * NdotV + 0.0001);
      const Fc = Math.pow(1.0 - VdotH, 5.0);

      A += (1.0 - Fc) * G_Vis;
      B += Fc * G_Vis;
    }
  }

  A /= SAMPLE_COUNT;
  B /= SAMPLE_COUNT;

  return [A, B];
}

// --- WGSL compute shader ---

const BRDF_LUT_SHADER = /* wgsl */ `
struct Uniforms {
  sampleCount: u32,
  lutSize: u32,
};

@group(0) @binding(0) var dstTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

const PI: f32 = 3.141592653589793;

fn radicalInverse(bits: u32) -> f32 {
  var b = bits;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return f32(b) * 2.3283064365386963e-10;
}

fn hammersley(i: u32, N: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(N), radicalInverse(i));
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn integrateBRDF(NdotV: f32, roughness: f32) -> vec2<f32> {
  let V = vec3<f32>(
    sqrt(1.0 - NdotV * NdotV),
    0.0,
    NdotV,
  );

  var A = 0.0;
  var B = 0.0;
  let sampleCount = uniforms.sampleCount;

  for (var i = 0u; i < sampleCount; i++) {
    let xi = hammersley(i, sampleCount);

    let a = roughness * roughness;
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);

    let H = vec3<f32>(
      sinTheta * cos(phi),
      sinTheta * sin(phi),
      cosTheta,
    );

    let VdotH = max(dot(V, H), 0.0);
    let NdotH = max(H.z, 0.0);

    let L = 2.0 * VdotH * H - V;
    let Llen = max(sqrt(dot(L, L)), 0.0001);
    let NdotL = max(L.z / Llen, 0.0);

    if (NdotL > 0.0) {
      let G = geometrySmith(NdotV, NdotL, roughness);
      let G_Vis = (G * VdotH) / (NdotH * NdotV + 0.0001);
      let Fc = pow(1.0 - VdotH, 5.0);

      A += (1.0 - Fc) * G_Vis;
      B += Fc * G_Vis;
    }
  }

  A = A / f32(sampleCount);
  B = B / f32(sampleCount);

  return vec2<f32>(A, B);
}

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let lutSize = uniforms.lutSize;
  if (gid.x >= lutSize || gid.y >= lutSize) { return; }

  let NdotV = (f32(gid.x) + 0.5) / f32(lutSize);
  let roughness = (f32(gid.y) + 0.5) / f32(lutSize);
  let result = integrateBRDF(NdotV, roughness);

  textureStore(dstTex, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(result.x, result.y, 0.0, 1.0));
}
`;

export class PBRSystem {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline | null = null;
  private computeBindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  brdfLUT: GPUTexture | null = null;
  brdfLUTView: GPUTextureView | null = null;
  brdfSampler: GPUSampler | null = null;
  bindGroupLayout: GPUBindGroupLayout | null = null;
  bindGroup: GPUBindGroup | null = null;

  private lutResolve: () => void = () => {};
  readonly lutReady: Promise<void> = new Promise(resolve => { this.lutResolve = resolve; });

  constructor(device: GPUDevice) {
    this.device = device;
  }

  init(): void {
    const dev = this.device;

    // Create the BRDF LUT texture with STORAGE_BINDING so the compute shader
    // can write directly — no CPU→GPU upload needed.
    this.brdfLUT = dev.createTexture({
      size: [BRDF_LUT_SIZE, BRDF_LUT_SIZE],
      format: "rgba16float",
      usage: TEXTURE_BINDING_USAGE | STORAGE_BINDING_USAGE,
    });
    this.brdfLUTView = this.brdfLUT.createView();
    this.brdfSampler = dev.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    this.bindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.bindGroup = dev.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.brdfLUTView },
        { binding: 1, resource: this.brdfSampler },
      ],
    });

    this.generateLUTGPU();
    this.lutResolve();
  }

  private generateLUTGPU(): void {
    const dev = this.device;

    this.computeBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: SHADER_STAGE_COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
        { binding: 1, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "uniform" } },
      ],
    });

    const shaderModule = createValidatedShaderModule(dev, { code: BRDF_LUT_SHADER, label: "PBRSystem.brdfLUT" });

    this.computePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [this.computeBindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: "cs_main" },
    });

    this.uniformBuffer = dev.createBuffer({
      size: 8,
      usage: UNIFORM_BUFFER_USAGE,
    });
    const uniformData = new Uint32Array(2);
    uniformData[0] = SAMPLE_COUNT;
    uniformData[1] = BRDF_LUT_SIZE;
    dev.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const computeBindGroup = dev.createBindGroup({
      layout: this.computeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.brdfLUTView! },
        { binding: 1, resource: { buffer: this.uniformBuffer } },
      ],
    });

    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(BRDF_LUT_SIZE / 8), Math.ceil(BRDF_LUT_SIZE / 8), 1);
    pass.end();
    dev.queue.submit([encoder.finish()]);
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.bindGroupLayout;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.bindGroup;
  }
}
