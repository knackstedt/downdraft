import { describe, expect, it } from "bun:test";
import { MeshBuilder } from "../../mesh/builder";
import { GpuMeshTable } from "./mesh-table";

function makeMesh(verts: number[][], indices: number[], indexFormat?: "uint16" | "uint32"): ReturnType<typeof MeshBuilder.prototype.build> {
  const builder = new MeshBuilder();
  for (const v of verts) {
    builder.addVertex(v as [number, number, number]);
  }
  for (let i = 0; i < indices.length; i += 3) {
    builder.addTriangle(indices[i]!, indices[i + 1]!, indices[i + 2]!);
  }
  const mesh = builder.build();
  if (indexFormat === "uint32") {
    mesh.indices = new Uint32Array(mesh.indices);
  }
  return mesh;
}

describe("GpuMeshTable", () => {
  it("should return mesh indices in order", () => {
    const table = new GpuMeshTable();
    const a = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]);
    const b = makeMesh([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [0, 1, 2, 0, 2, 3]);
    expect(table.addMesh(a)).toBe(0);
    expect(table.addMesh(b)).toBe(1);
    expect(table.getBatch(0)?.meshIdx).toBe(0);
    expect(table.getBatch(1)?.meshIdx).toBe(1);
  });

  it("should group meshes by vertex layout and index format", () => {
    const table = new GpuMeshTable();
    const sameStride = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]);
    const sameStride2 = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]);
    const bigger = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 1, 2, 1, 2, 3]);
    const u32 = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2], "uint32");

    table.addMesh(sameStride);
    table.addMesh(sameStride2);
    table.addMesh(bigger);
    table.addMesh(u32);

    expect(table.getGroupCount()).toBe(2);
  });

  it("should compute per-mesh index offsets and base vertices", () => {
    const table = new GpuMeshTable();
    const a = makeMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 1, 2]);
    const b = makeMesh([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [0, 1, 2, 0, 2, 3]);
    table.addMesh(a);
    table.addMesh(b);

    const batchA = table.getBatch(0)!;
    const batchB = table.getBatch(1)!;
    expect(batchA.indexCount).toBe(3);
    expect(batchB.indexOffset).toBe(3);
    expect(batchB.baseVertex).toBe(3);
    expect(batchA.baseVertex).toBe(0);
  });
});
