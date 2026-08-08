import { describe, it, expect } from "bun:test";
import { bakeNodeTransforms } from "./bake-node-transforms";
import type { ModelData } from "./types";

function makeModelData(
  meshes: { vertices: number[]; vertexCount: number; indices?: number[] }[],
  nodes: { name: string; mesh?: number; translation?: [number, number, number]; rotation?: [number, number, number, number]; scale?: [number, number, number]; children?: number[] }[],
): ModelData {
  return {
    meshes: meshes.map((m) => ({
      vertices: new Float32Array(m.vertices),
      indices: m.indices ? new Uint16Array(m.indices) : new Uint16Array([0, 1, 2]),
      vertexCount: m.vertexCount,
      indexCount: m.indices?.length ?? 3,
      uvs: null,
      colors: null,
    })),
    name: "test",
    format: "gltf",
    nodes: nodes,
  };
}

describe("bakeNodeTransforms", () => {
  it("is a no-op when there are no nodes", () => {
    const model = makeModelData(
      [{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }],
      [],
    );
    bakeNodeTransforms(model);
    expect(model.meshes[0].vertices[0]).toBe(1);
    expect(model.meshes[0].vertices[1]).toBe(2);
    expect(model.meshes[0].vertices[2]).toBe(3);
  });

  it("is a no-op when all transforms are identity", () => {
    const model = makeModelData(
      [{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }],
      [{ name: "root", mesh: 0 }],
    );
    bakeNodeTransforms(model);
    expect(model.meshes[0].vertices[0]).toBe(1);
    expect(model.meshes[0].vertices[1]).toBe(2);
    expect(model.meshes[0].vertices[2]).toBe(3);
  });

  it("applies node translation", () => {
    const model = makeModelData(
      [{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }],
      [{ name: "root", mesh: 0, translation: [10, 20, 30] }],
    );
    bakeNodeTransforms(model);
    expect(model.meshes[0].vertices[0]).toBe(11); // 1+10
    expect(model.meshes[0].vertices[1]).toBe(22); // 2+20
    expect(model.meshes[0].vertices[2]).toBe(33); // 3+30
    // Normals unchanged (translation doesn't affect normals)
    expect(model.meshes[0].vertices[3]).toBe(0);
    expect(model.meshes[0].vertices[4]).toBe(1);
    expect(model.meshes[0].vertices[5]).toBe(0);
  });

  it("applies node scale", () => {
    const model = makeModelData(
      [{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }],
      [{ name: "root", mesh: 0, scale: [2, 3, 4] }],
    );
    bakeNodeTransforms(model);
    expect(model.meshes[0].vertices[0]).toBe(2); // 1*2
    expect(model.meshes[0].vertices[1]).toBe(6); // 2*3
    expect(model.meshes[0].vertices[2]).toBe(12); // 3*4
  });

  it("applies node rotation (90° around Y)", () => {
    const halfAngle = Math.PI / 4;
    const rot: [number, number, number, number] = [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)];
    const model = makeModelData(
      [{ vertices: [1, 0, 0, 0, 0, 1], vertexCount: 1 }],
      [{ name: "root", mesh: 0, rotation: rot }],
    );
    bakeNodeTransforms(model);
    // (1,0,0) rotated 90° around Y → (0, 0, -1)
    expect(model.meshes[0].vertices[0]).toBeCloseTo(0, 6);
    expect(model.meshes[0].vertices[1]).toBeCloseTo(0, 6);
    expect(model.meshes[0].vertices[2]).toBeCloseTo(-1, 6);
    // Normal (0,0,1) → (1, 0, 0)
    expect(model.meshes[0].vertices[3]).toBeCloseTo(1, 6);
    expect(model.meshes[0].vertices[4]).toBeCloseTo(0, 6);
    expect(model.meshes[0].vertices[5]).toBeCloseTo(0, 6);
  });

  it("composes parent + child transforms", () => {
    const model = makeModelData(
      [{ vertices: [1, 0, 0, 0, 1, 0], vertexCount: 1 }],
      [
        { name: "parent", translation: [10, 0, 0], children: [1] },
        { name: "child", mesh: 0, translation: [1, 0, 0] },
      ],
    );
    bakeNodeTransforms(model);
    // Child world translation = parent(10,0,0) + child(1,0,0) = (11,0,0)
    // Vertex (1,0,0) + (11,0,0) = (12,0,0)
    expect(model.meshes[0].vertices[0]).toBe(12);
    expect(model.meshes[0].vertices[1]).toBe(0);
    expect(model.meshes[0].vertices[2]).toBe(0);
  });

  it("handles multiple root nodes", () => {
    const model = makeModelData(
      [
        { vertices: [0, 0, 0, 0, 1, 0], vertexCount: 1 },
        { vertices: [0, 0, 0, 0, 1, 0], vertexCount: 1 },
      ],
      [
        { name: "root1", mesh: 0, translation: [5, 0, 0] },
        { name: "root2", mesh: 1, translation: [0, 5, 0] },
      ],
    );
    bakeNodeTransforms(model);
    expect(model.meshes[0].vertices[0]).toBe(5); // root1: 0+5
    expect(model.meshes[1].vertices[1]).toBe(5); // root2: 0+5
  });

  it("skips nodes without a mesh", () => {
    const model = makeModelData(
      [{ vertices: [1, 2, 3, 0, 1, 0], vertexCount: 1 }],
      [
        { name: "group", translation: [100, 100, 100], children: [1] },
        { name: "mesh_node", mesh: 0, translation: [1, 0, 0] },
      ],
    );
    bakeNodeTransforms(model);
    // Parent (100,100,100) + child (1,0,0) = (101,100,100)
    // Vertex (1,2,3) + (101,100,100) = (102,102,103)
    expect(model.meshes[0].vertices[0]).toBe(102);
    expect(model.meshes[0].vertices[1]).toBe(102);
    expect(model.meshes[0].vertices[2]).toBe(103);
  });
});
