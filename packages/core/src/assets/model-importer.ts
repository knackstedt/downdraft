import type { MeshData } from "../mesh/builder.ts";
import type { GPUMesh } from "./model-to-gpu.ts";
import { uploadMeshesToGPU, uploadMeshToGPU } from "./model-to-gpu.ts";
import type { BridgedMaterial } from "./material-bridge.ts";
import { bridgeMaterials, bridgeMaterial } from "./material-bridge.ts";
import { convertPluginModel, convertPluginMesh, type PluginModelData, type PluginMaterialData, type TargetLayout } from "./model-to-mesh.ts";
import type { GPUResourceCache } from "./cache.ts";

export interface ImportedModel {
  meshes: GPUMesh[];
  meshData: MeshData[];
  materials: BridgedMaterial[];
  animations?: unknown[];
  nodes?: unknown[];
  skin?: unknown;
  name: string;
}

export interface ImportModelOptions {
  device: GPUDevice;
  targetLayout?: TargetLayout;
  textureBasePath?: string;
  cache?: GPUResourceCache;
}

export async function importModel(
  model: PluginModelData,
  options: ImportModelOptions,
): Promise<ImportedModel> {
  const target = options.targetLayout ?? "pbr";

  // Convert plugin meshes to engine MeshData
  const meshData = convertPluginModel(model, target);

  // Upload to GPU
  const meshes = uploadMeshesToGPU(options.device, meshData, options.cache);

  // Bridge materials
  let materials: BridgedMaterial[] = [];
  if (model.materials && model.materials.length > 0) {
    materials = await bridgeMaterials(options.device, model.materials, options.textureBasePath);
  }

  return {
    meshes,
    meshData,
    materials,
    animations: model.animations,
    nodes: model.nodes,
    skin: model.skin,
    name: model.name,
  };
}

export async function importSingleMesh(
  mesh: PluginModelData["meshes"][0],
  device: GPUDevice,
  target: TargetLayout = "pbr",
  cache?: GPUResourceCache,
): Promise<{ mesh: GPUMesh; meshData: MeshData }> {
  const meshData = convertPluginMesh(mesh, target);
  const gpuMesh = uploadMeshToGPU(device, meshData, cache);
  return { mesh: gpuMesh, meshData };
}

export async function importMaterial(
  material: PluginMaterialData,
  device: GPUDevice,
  textureBasePath?: string,
): Promise<BridgedMaterial> {
  return bridgeMaterial(device, material, textureBasePath);
}
