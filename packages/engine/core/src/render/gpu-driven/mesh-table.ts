import type { MeshData } from "../../mesh/builder";

export interface MeshBatch {
  meshIdx: number;
  vertexOffset: number;
  indexOffset: number;
  indexCount: number;
  vertexCount: number;
  baseVertex: number;
  indexFormat: GPUIndexFormat;
  layoutStride: number;
}

export interface MeshTableGroup {
  layoutStride: number;
  indexFormat: GPUIndexFormat;
  meshes: MeshData[];
  batches: MeshBatch[];
  totalVertexCount: number;
  totalIndexCount: number;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
}

/** Packs many MeshData into merged GPU vertex/index buffers, grouped by vertex layout and index format.
 *  This is the "mesh binding table" for an indirect draw pipeline. */
export class GpuMeshTable {
  private sourceMeshes: { mesh: MeshData; group: number; batch: MeshBatch }[] = [];
  private groups: MeshTableGroup[] = [];
  private built = false;

  /** Register a mesh for packing. Returns a mesh index (same as `batch.meshIdx`). */
  addMesh(mesh: MeshData): number {
    const meshIdx = this.sourceMeshes.length;

    const layoutStride = mesh.layout.stride;
    const indexFormat = mesh.indices instanceof Uint32Array ? "uint32" : "uint16";

    // Find or create a group by (stride, indexFormat)
    let groupIdx = this.groups.findIndex(
      g => g.layoutStride === layoutStride && g.indexFormat === indexFormat,
    );
    if (groupIdx < 0) {
      groupIdx = this.groups.length;
      this.groups.push({
        layoutStride,
        indexFormat,
        meshes: [],
        batches: [],
        totalVertexCount: 0,
        totalIndexCount: 0,
        vertexBuffer: null,
        indexBuffer: null,
      });
    }

    const group = this.groups[groupIdx]!;
    const batch: MeshBatch = {
      meshIdx,
      vertexOffset: 0,
      indexOffset: group.totalIndexCount,
      indexCount: mesh.indexCount,
      vertexCount: mesh.vertexCount,
      baseVertex: group.totalVertexCount,
      indexFormat,
      layoutStride,
    };
    group.totalVertexCount += mesh.vertexCount;
    group.totalIndexCount += mesh.indexCount;

    this.sourceMeshes.push({ mesh, group: groupIdx, batch });
    group.meshes.push(mesh);
    group.batches.push(batch);
    this.built = false;
    return meshIdx;
  }

  /** Build (or rebuild) merged GPU buffers. Call after all addMesh / structural changes. */
  build(device: GPUDevice): void {
    this.groups.forEach((group) => {
      // Pack vertices
      let totalVertices = 0;
      group.meshes.forEach((mesh) => {
        totalVertices += mesh.vertexCount;
      });
      const vertexByteSize = totalVertices * group.layoutStride;

      const vertexStaging = new Float32Array(totalVertices * (group.layoutStride / 4));
      let vertexCursor = 0;
      let baseVertex = 0;

      for (let i = 0; i < group.meshes.length; i++) {
        const mesh = group.meshes[i]!;
        const batch = group.batches[i]!;
        batch.baseVertex = baseVertex;
        batch.vertexOffset = 0; // shared buffer, per-mesh baseVertex handles it
        vertexStaging.set(new Float32Array(mesh.vertices.buffer), vertexCursor);
        vertexCursor += mesh.vertexCount * (group.layoutStride / 4);
        baseVertex += mesh.vertexCount;
      }

      if (group.vertexBuffer) group.vertexBuffer.destroy();
      group.vertexBuffer = device.createBuffer({
        size: vertexByteSize,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(group.vertexBuffer, 0, vertexStaging as unknown as BufferSource);

      // Pack indices
      const indexByteSize = group.indexFormat === "uint32" ? 4 : 2;
      let totalIndices = 0;
      group.meshes.forEach((mesh) => {
        totalIndices += mesh.indexCount;
      });
      const indexByteTotal = totalIndices * indexByteSize;

      const indexStaging = group.indexFormat === "uint32" ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);
      let indexCursor = 0;

      for (let i = 0; i < group.meshes.length; i++) {
        const mesh = group.meshes[i]!;
        const batch = group.batches[i]!;
        batch.indexOffset = indexCursor;

        const source = mesh.indices;
        for (let j = 0; j < source.length; j++) {
          indexStaging[indexCursor + j] = source[j] as number;
        }
        indexCursor += source.length;
      }

      if (group.indexBuffer) group.indexBuffer.destroy();
      group.indexBuffer = device.createBuffer({
        size: indexByteTotal,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(group.indexBuffer, 0, indexStaging as unknown as BufferSource);
    });

    this.built = true;
  }

  /** Iterator over all batches, suitable for the indirect draw loop. */
  getBatches(): readonly MeshBatch[] {
    return this.sourceMeshes.map(s => s.batch);
  }

  getGroup(batch: MeshBatch): MeshTableGroup {
    return this.groups[this.sourceMeshes[batch.meshIdx]!.group]!;
  }

  /** Look up a batch by mesh index. */
  getBatch(meshIdx: number): MeshBatch | null {
    const source = this.sourceMeshes[meshIdx];
    return source ? source.batch : null;
  }

  getGroupCount(): number {
    return this.groups.length;
  }

  /** Destroy all created GPU buffers. */
  destroy(): void {
    this.groups.forEach((group) => {
      group.vertexBuffer?.destroy();
      group.indexBuffer?.destroy();
      group.vertexBuffer = null;
      group.indexBuffer = null;
    });
  }

  get isBuilt(): boolean {
    return this.built;
  }
}
