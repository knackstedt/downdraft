import type { EnvironmentMap } from "../assets/environment-manager";

export interface IBLBindGroupOptions {
  includeBRDFLUT?: boolean;
}

export class IBLBindGroup {
  private device: GPUDevice;
  private includeBRDFLUT: boolean;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private irradianceSampler: GPUSampler;
  private prefilterSampler: GPUSampler;
  private brdfSampler: GPUSampler;
  private defaultLUTTexture: GPUTexture | null = null;
  private defaultIrradianceTex: GPUTexture | null = null;
  private defaultPrefilterTex: GPUTexture | null = null;

  constructor(device: GPUDevice, options: IBLBindGroupOptions = {}) {
    this.device = device;
    this.includeBRDFLUT = options.includeBRDFLUT ?? true;
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

    // Eagerly create the bind group layout so pipelines can reference @group(2)
    // before any environment map has been captured.
    const entries: GPUBindGroupLayoutEntry[] = this.includeBRDFLUT
      ? [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ]
      : [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "cube" } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ];
    this.bindGroupLayout = device.createBindGroupLayout({ entries });

    // Create a default bind group with placeholder textures so pipelines
    // can render before any environment map has been captured.
    this.createDefaultBindGroup();
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.bindGroupLayout;
  }

  createBindGroup(envMap: EnvironmentMap): GPUBindGroup {
    if (!this.uniformBuffer) {
      this.uniformBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }

    const mipData = new Float32Array(4);
    mipData[0] = envMap.prefilteredMaxMip;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mipData);

    const prefilteredView = envMap.prefilteredSpecular[0]?.createView({
      dimension: "cube",
    }) ?? envMap.cubemap.createView({ dimension: "cube" });

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: envMap.irradiance.createView({ dimension: "cube" }) },
      { binding: 1, resource: prefilteredView },
    ];

    if (this.includeBRDFLUT) {
      const brdfLUTView = envMap.brdfLUT?.createView() ?? this.createDefaultLUTView();
      entries.push({ binding: 2, resource: brdfLUTView });
      entries.push({ binding: 3, resource: this.irradianceSampler });
      entries.push({ binding: 4, resource: this.prefilterSampler });
      entries.push({ binding: 5, resource: this.brdfSampler });
      entries.push({ binding: 6, resource: { buffer: this.uniformBuffer } });
    } else {
      entries.push({ binding: 2, resource: this.irradianceSampler });
      entries.push({ binding: 3, resource: this.prefilterSampler });
      entries.push({ binding: 4, resource: { buffer: this.uniformBuffer } });
    }

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries,
    });

    return this.bindGroup;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.bindGroup;
  }

  private createDefaultLUTView(): GPUTextureView {
    if (!this.defaultLUTTexture) {
      this.defaultLUTTexture = this.device.createTexture({
        size: [1, 1],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const data = new Uint16Array([0x3C00, 0x3C00, 0, 0x3C00]);
      this.device.queue.writeTexture(
        { texture: this.defaultLUTTexture },
        data,
        { bytesPerRow: 8 },
        { width: 1, height: 1 },
      );
    }
    return this.defaultLUTTexture.createView();
  }

  private createDefaultCubemapView(tex: GPUTexture | null, label: string): GPUTextureView {
    if (!tex) {
      tex = this.device.createTexture({
        size: [1, 1, 6],
        format: "rgba16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        label,
      });
      const faceData = new Uint16Array(6 * 4);
      for (let i = 0; i < 6; i++) {
        faceData[i * 4 + 0] = 0x3C00;
        faceData[i * 4 + 1] = 0x3C00;
        faceData[i * 4 + 2] = 0x3C00;
        faceData[i * 4 + 3] = 0x3C00;
      }
      this.device.queue.writeTexture(
        { texture: tex },
        faceData,
        { bytesPerRow: 8, rowsPerImage: 1 },
        { width: 1, height: 1, depthOrArrayLayers: 6 },
      );
      if (label === "default_irradiance") this.defaultIrradianceTex = tex;
      else this.defaultPrefilterTex = tex;
    }
    return tex.createView({ dimension: "cube" });
  }

  private createDefaultBindGroup(): void {
    if (!this.uniformBuffer) {
      this.uniformBuffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const mipData = new Float32Array(4);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mipData);

    const irradianceView = this.createDefaultCubemapView(this.defaultIrradianceTex, "default_irradiance");
    const prefilterView = this.createDefaultCubemapView(this.defaultPrefilterTex, "default_prefilter");

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: irradianceView },
      { binding: 1, resource: prefilterView },
    ];

    if (this.includeBRDFLUT) {
      entries.push({ binding: 2, resource: this.createDefaultLUTView() });
      entries.push({ binding: 3, resource: this.irradianceSampler });
      entries.push({ binding: 4, resource: this.prefilterSampler });
      entries.push({ binding: 5, resource: this.brdfSampler });
      entries.push({ binding: 6, resource: { buffer: this.uniformBuffer } });
    } else {
      entries.push({ binding: 2, resource: this.irradianceSampler });
      entries.push({ binding: 3, resource: this.prefilterSampler });
      entries.push({ binding: 4, resource: { buffer: this.uniformBuffer } });
    }

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries,
    });
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.defaultLUTTexture?.destroy();
    this.defaultIrradianceTex?.destroy();
    this.defaultPrefilterTex?.destroy();
  }
}

export function createIBLShaderChunk(groupIndex: number, includeBRDFLUT: boolean): string {
  const g = groupIndex;
  if (includeBRDFLUT) {
    return /* wgsl */ `
struct IBLUniforms {
  maxMipLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(${g}) @binding(0) var irradianceMap: texture_cube<f32>;
@group(${g}) @binding(1) var prefilterMap: texture_cube<f32>;
@group(${g}) @binding(2) var brdfLUT: texture_2d<f32>;
@group(${g}) @binding(3) var irradianceSampler: sampler;
@group(${g}) @binding(4) var prefilterSampler: sampler;
@group(${g}) @binding(5) var brdfSampler: sampler;
@group(${g}) @binding(6) var<uniform> iblUniforms: IBLUniforms;

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
  }
  return /* wgsl */ `
struct IBLUniforms {
  maxMipLevel: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(${g}) @binding(0) var irradianceMap: texture_cube<f32>;
@group(${g}) @binding(1) var prefilterMap: texture_cube<f32>;
@group(${g}) @binding(2) var irradianceSampler: sampler;
@group(${g}) @binding(3) var prefilterSampler: sampler;
@group(${g}) @binding(4) var<uniform> iblUniforms: IBLUniforms;

fn getIBLDiffuse(N: vec3<f32>) -> vec3<f32> {
  return textureSample(irradianceMap, irradianceSampler, N).rgb;
}

fn getIBLSpecular(N: vec3<f32>, R: vec3<f32>, roughness: f32) -> vec3<f32> {
  let lod = roughness * iblUniforms.maxMipLevel;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, R, lod);
  return prefilteredColor.rgb;
}
`;
}

export const IBL_SHADER_CHUNK = createIBLShaderChunk(2, true);
