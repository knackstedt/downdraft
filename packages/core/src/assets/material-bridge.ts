import type { Material } from "../material/material.ts";
import { BlendMode, CullMode } from "../material/material.ts";
import type { PBRMaterialResources } from "../render/passes/opaque.ts";
import { createGPUTextureFromData, createSampler, loadTexture } from "./loader-texture.ts";
import type { TextureData } from "./loader-texture.ts";
import type { PluginMaterialData } from "./model-to-mesh.ts";

export interface BridgedMaterial {
  material: Material;
  pbrResources: PBRMaterialResources | null;
  textures: GPUTexture[];
}

function createDefaultTextureView(device: GPUDevice, format: GPUTextureFormat = "rgba8unorm"): GPUTextureView {
  const tex = device.createTexture({
    size: [1, 1],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array([255, 255, 255, 255]);
  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  return tex.createView();
}

function createBlackTextureView(device: GPUDevice): GPUTextureView {
  const tex = device.createTexture({
    size: [1, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array([0, 0, 0, 255]);
  device.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: 4 },
    { width: 1, height: 1 },
  );
  return tex.createView();
}

export async function bridgeMaterial(
  device: GPUDevice,
  pluginMaterial: PluginMaterialData,
  textureBasePath?: string,
): Promise<BridgedMaterial> {
  const textures: GPUTexture[] = [];
  const sampler = createSampler(device, {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

  // Load albedo texture
  let albedoView: GPUTextureView;
  if (pluginMaterial.textureUri) {
    const uri = textureBasePath ? `${textureBasePath}/${pluginMaterial.textureUri}` : pluginMaterial.textureUri;
    const texData = await loadTexture(uri);
    const gpuTex = createGPUTextureFromData(device, texData);
    textures.push(gpuTex);
    albedoView = gpuTex.createView();
  } else if (pluginMaterial.textureData) {
    const texData: TextureData = {
      width: 1,
      height: 1,
      data: new Uint8Array([255, 255, 255, 255]),
      format: "rgba8unorm",
      mipLevels: 1,
      isHDR: false,
    };
    const gpuTex = createGPUTextureFromData(device, texData);
    textures.push(gpuTex);
    albedoView = gpuTex.createView();
  } else {
    albedoView = createDefaultTextureView(device);
  }

  // Load normal texture
  let normalView: GPUTextureView;
  if (pluginMaterial.normalTextureUri) {
    const uri = textureBasePath ? `${textureBasePath}/${pluginMaterial.normalTextureUri}` : pluginMaterial.normalTextureUri;
    const texData = await loadTexture(uri);
    const gpuTex = createGPUTextureFromData(device, texData);
    textures.push(gpuTex);
    normalView = gpuTex.createView();
  } else {
    normalView = createDefaultTextureView(device);
  }

  // Metallic-roughness: pack into a single texture (R=metallic, G=roughness)
  // For now, use a 1x1 default texture
  const metallicRoughnessView = createDefaultTextureView(device);

  // AO and emissive defaults
  const aoView = createDefaultTextureView(device);
  let emissiveView: GPUTextureView;
  if (pluginMaterial.emissiveColor && (pluginMaterial.emissiveColor[0] > 0 || pluginMaterial.emissiveColor[1] > 0 || pluginMaterial.emissiveColor[2] > 0)) {
    const tex = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const data = new Uint8Array([
      Math.min(255, Math.round(pluginMaterial.emissiveColor[0] * 255)),
      Math.min(255, Math.round(pluginMaterial.emissiveColor[1] * 255)),
      Math.min(255, Math.round(pluginMaterial.emissiveColor[2] * 255)),
      255,
    ]);
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: 4 }, { width: 1, height: 1 });
    textures.push(tex);
    emissiveView = tex.createView();
  } else {
    emissiveView = createBlackTextureView(device);
  }

  const emissiveIntensity = pluginMaterial.emissiveColor
    ? Math.max(pluginMaterial.emissiveColor[0], pluginMaterial.emissiveColor[1], pluginMaterial.emissiveColor[2])
    : 0;

  const pbrResources: PBRMaterialResources = {
    albedoTexture: albedoView,
    normalTexture: normalView,
    metallicRoughnessTexture: metallicRoughnessView,
    aoTexture: aoView,
    emissiveTexture: emissiveView,
    sampler,
    baseColor: pluginMaterial.baseColor,
    roughness: pluginMaterial.roughness,
    metallic: pluginMaterial.metallic,
    emissiveIntensity,
  };

  const material = new Material({
    name: pluginMaterial.name || "pbr-material",
    shader: "pbr",
    uniforms: {
      baseColor: { name: "baseColor", type: "vec4", binding: 0 },
      roughness: { name: "roughness", type: "f32", binding: 1 },
      metallic: { name: "metallic", type: "f32", binding: 2 },
      emissiveIntensity: { name: "emissiveIntensity", type: "f32", binding: 3 },
    },
    textures: {
      albedo: { name: "albedo", binding: 1, sampler: "linear-repeat" },
      normal: { name: "normal", binding: 3, sampler: "linear-repeat" },
      metallicRoughness: { name: "metallicRoughness", binding: 5, sampler: "linear-repeat" },
      ao: { name: "ao", binding: 7, sampler: "linear-repeat" },
      emissive: { name: "emissive", binding: 9, sampler: "linear-repeat" },
    },
    blendMode: BlendMode.Opaque,
    cullMode: CullMode.Back,
  });

  material.setUniform("baseColor", pluginMaterial.baseColor);
  material.setUniform("roughness", pluginMaterial.roughness);
  material.setUniform("metallic", pluginMaterial.metallic);
  material.setUniform("emissiveIntensity", emissiveIntensity);

  return { material, pbrResources, textures };
}

export async function bridgeMaterials(
  device: GPUDevice,
  pluginMaterials: PluginMaterialData[],
  textureBasePath?: string,
): Promise<BridgedMaterial[]> {
  return Promise.all(
    pluginMaterials.map((mat) => bridgeMaterial(device, mat, textureBasePath)),
  );
}
