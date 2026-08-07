import { BlendMode, CullMode, Material } from "../material/material";
import type { BindlessTextureRegistry, TextureBucketKey } from "../render/bindless";
import type { PBRMaterialResources } from "../render/passes/opaque";
import type { TextureData } from "./loader-texture";
import { createGPUTextureFromData, createSampler, loadTexture } from "./loader-texture";
import type { PluginMaterialData } from "./model-to-mesh";

export interface BridgedMaterial {
  material: Material;
  pbrResources: PBRMaterialResources | null;
  textures: GPUTexture[];
}

/** Build a TextureBucketKey from a GPUTexture's properties. */
function bucketKeyFromTexture(tex: GPUTexture): TextureBucketKey {
  return {
    format: tex.format,
    width: tex.width,
    height: tex.height,
    mipCount: tex.mipLevelCount,
    sampleCount: tex.sampleCount,
  };
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
  registry?: BindlessTextureRegistry | null,
): Promise<BridgedMaterial> {
  const textures: GPUTexture[] = [];
  const sampler = createSampler(device, {
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
  });

  // When a bindless registry is provided, register textures into it and track
  // sourceIds for the PBRMaterialResources. Otherwise, create standalone GPU
  // textures + views (legacy path, but the OpaquePass PBR path now requires
  // bindless, so the legacy views are only used for non-PBR rendering).
  const useBindless = !!registry;
  let albedoSourceId: string | undefined;
  let normalSourceId: string | undefined;
  let metallicRoughnessSourceId: string | undefined;
  let aoSourceId: string | undefined;
  let emissiveSourceId: string | undefined;

  // Load albedo texture
  let albedoView: GPUTextureView;
  if (pluginMaterial.textureUri) {
    const uri = textureBasePath ? `${textureBasePath}/${pluginMaterial.textureUri}` : pluginMaterial.textureUri;
    const texData = await loadTexture(uri);
    const gpuTex = createGPUTextureFromData(device, texData);
    textures.push(gpuTex);
    albedoView = gpuTex.createView();
    if (useBindless && registry) {
      albedoSourceId = `bridge:albedo:${pluginMaterial.name || Math.random().toString(36)}`;
      registry.registerFromTexture(albedoSourceId, gpuTex, bucketKeyFromTexture(gpuTex));
    }
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
    if (useBindless && registry) {
      albedoSourceId = `bridge:albedo:${pluginMaterial.name || Math.random().toString(36)}`;
      registry.registerFromTexture(albedoSourceId, gpuTex, bucketKeyFromTexture(gpuTex));
    }
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
    if (useBindless && registry) {
      normalSourceId = `bridge:normal:${pluginMaterial.name || Math.random().toString(36)}`;
      registry.registerFromTexture(normalSourceId, gpuTex, bucketKeyFromTexture(gpuTex));
    }
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
    if (useBindless && registry) {
      emissiveSourceId = `bridge:emissive:${pluginMaterial.name || Math.random().toString(36)}`;
      registry.registerFromTexture(emissiveSourceId, tex, bucketKeyFromTexture(tex));
    }
  } else {
    emissiveView = createBlackTextureView(device);
  }

  const emissiveIntensity = pluginMaterial.emissiveColor
    ? Math.max(pluginMaterial.emissiveColor[0], pluginMaterial.emissiveColor[1], pluginMaterial.emissiveColor[2])
    : 0;

  const pbrResources: PBRMaterialResources = {
    albedoTextureSourceId: albedoSourceId,
    normalTextureSourceId: normalSourceId,
    metallicRoughnessTextureSourceId: metallicRoughnessSourceId,
    aoTextureSourceId: aoSourceId,
    emissiveTextureSourceId: emissiveSourceId,
    baseColor: pluginMaterial.baseColor,
    roughness: pluginMaterial.roughness,
    metallic: pluginMaterial.metallic,
    emissiveIntensity,
    textureTransform: pluginMaterial.textureTransform,
  };
  // Keep sampler/views alive for non-PBR consumers; they're referenced by `textures`.
  void sampler; void albedoView; void normalView; void metallicRoughnessView; void aoView; void emissiveView;

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
  registry?: BindlessTextureRegistry | null,
): Promise<BridgedMaterial[]> {
  return Promise.all(
    pluginMaterials.map((mat) => bridgeMaterial(device, mat, textureBasePath, registry)),
  );
}
