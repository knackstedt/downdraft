import type { EnvironmentMap } from "../assets/environment-manager.ts";

const IBL_BIND_GROUP_LAYOUT_ENTRIES: GPUBindGroupLayoutEntry[] = [
  // binding 0: irradiance cubemap
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
  // binding 1: prefiltered specular cubemap
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
  // binding 2: BRDF LUT
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  // binding 3: sampler for irradiance
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  // binding 4: sampler for prefiltered
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  // binding 5: sampler for BRDF LUT
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  // binding 6: uniform — max mip level
  { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
];

export class IBLBindGroup {
  private device: GPUDevice;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private irradianceSampler: GPUSampler;
  private prefilterSampler: GPUSampler;
  private brdfSampler: GPUSampler;

  constructor(device: GPUDevice) {
    this.device = device;
    this.irradianceSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.prefilterSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.brdfSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.bindGroupLayout;
  }

  createBindGroup(envMap: EnvironmentMap): GPUBindGroup {
    if (!this.bindGroupLayout) {
      this.bindGroupLayout = this.device.createBindGroupLayout({
        entries: IBL_BIND_GROUP_LAYOUT_ENTRIES,
      });
    }

    if (!this.uniformBuffer) {
      this.uniformBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const mipData = new Float32Array(4);
    mipData[0] = envMap.prefilteredMaxMip;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mipData);

    // Create a combined prefiltered specular texture with mipmaps
    // For now, use the first level as a simple cubemap view
    const prefilteredView = envMap.prefilteredSpecular[0]?.createView({
      dimension: "cube",
    }) ?? envMap.cubemap.createView({ dimension: "cube" });

    const brdfLUTView = envMap.brdfLUT?.createView() ?? this.createDefaultLUTView();

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: envMap.irradiance.createView({ dimension: "cube" }) },
        { binding: 1, resource: prefilteredView },
        { binding: 2, resource: brdfLUTView },
        { binding: 3, resource: this.irradianceSampler },
        { binding: 4, resource: this.prefilterSampler },
        { binding: 5, resource: this.brdfSampler },
        { binding: 6, resource: { buffer: this.uniformBuffer } },
      ],
    });

    return this.bindGroup;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.bindGroup;
  }

  private createDefaultLUTView(): GPUTextureView {
    const tex = this.device.createTexture({
      size: [1, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const data = new Uint16Array([0x3C00, 0x3C00, 0, 0x3C00]); // [1, 1, 0, 1] in half-float
    this.device.queue.writeTexture(
      { texture: tex },
      data,
      { bytesPerRow: 8 },
      { width: 1, height: 1 },
    );
    return tex.createView();
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}

export const IBL_SHADER_CHUNK = /* wgsl */ `
struct IBLUniforms {
  maxMipLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(2) @binding(0) var irradianceMap: texture_cube<f32>;
@group(2) @binding(1) var prefilterMap: texture_cube<f32>;
@group(2) @binding(2) var brdfLUT: texture_2d<f32>;
@group(2) @binding(3) var irradianceSampler: sampler;
@group(2) @binding(4) var prefilterSampler: sampler;
@group(2) @binding(5) var brdfSampler: sampler;
@group(2) @binding(6) var<uniform> iblUniforms: IBLUniforms;

fn getIBLDiffuse(N: vec3<f32>) -> vec3<f32> {
  return textureSample(irradianceMap, irradianceSampler, N).rgb;
}

fn getIBLSpecular(N: vec3<f32>, R: vec3<f32>, roughness: f32) -> vec3<f32> {
  let lod = roughness * iblUniforms.maxMipLevel;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, R, lod);
  let brdf = textureSample(brdfLUT, brdfSampler, vec2<f32>(max(dot(N, vec3<f32>(0.0, 0.0, 1.0)), 0.0), roughness)).rg;
  return prefilteredColor.rgb * (brdf.x + brdf.y);
}
`;
