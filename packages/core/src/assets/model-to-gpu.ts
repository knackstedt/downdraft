import type { MeshData } from "../mesh/builder";
import type { GPUResourceCache } from "./cache";

export interface GPUMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  vertexCount: number;
  indexCount: number;
  layout: MeshData["layout"];
  indexFormat: GPUIndexFormat;
}

export function uploadMeshToGPU(
  device: GPUDevice,
  mesh: MeshData,
  cache?: GPUResourceCache,
): GPUMesh {
  const vertexBuffer = device.createBuffer({
    size: mesh.vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices.buffer);

  const indexBuffer = device.createBuffer({
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices.buffer);

  const indexFormat: GPUIndexFormat = mesh.indices instanceof Uint32Array ? "uint32" : "uint16";

  const gpuMesh: GPUMesh = {
    vertexBuffer,
    indexBuffer,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
    layout: mesh.layout,
    indexFormat,
  };

  if (cache) {
    cache.register(`gpuMesh:${vertexBuffer.label || "mesh"}`, gpuMesh, async () => {
      vertexBuffer.destroy();
      indexBuffer.destroy();
    });
  }

  return gpuMesh;
}

export function uploadMeshesToGPU(
  device: GPUDevice,
  meshes: MeshData[],
  cache?: GPUResourceCache,
): GPUMesh[] {
  return meshes.map((mesh) => uploadMeshToGPU(device, mesh, cache));
}

export function destroyGPUMesh(mesh: GPUMesh): void {
  mesh.vertexBuffer.destroy();
  mesh.indexBuffer.destroy();
}
