import { deformChunk } from "./deformation.ts";
import type { ExtractedMesh } from "./types.ts";

function makeSimpleMesh(): ExtractedMesh {
  // 4 vertices: (0,0,0), (1,0,0), (0,0,1), (1,0,1)
  // pos(3) + normal(3) + color(3) = 9 floats per vertex
  const verts = new Float32Array([
    0, 0, 0,  0, 1, 0,  1, 1, 1,
    1, 0, 0,  0, 1, 0,  1, 1, 1,
    0, 0, 1,  0, 1, 0,  1, 1, 1,
    1, 0, 1,  0, 1, 0,  1, 1, 1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
  return { verts, indices, useUint32: false };
}

describe("Surface Nets Deformation", () => {
  it("should not modify vertices outside the deformation radius", () => {
    const mesh = makeSimpleMesh();
    const result = deformChunk(mesh, [100, 100, 100], { radius: 1, strength: 5, falloff: 2 });
    // All vertices should be unchanged
    for (let i = 0; i < mesh.verts.length; i++) {
      expect(result.verts[i]).toBeCloseTo(mesh.verts[i]);
    }
  });

  it("should displace vertex Y within radius", () => {
    const mesh = makeSimpleMesh();
    const result = deformChunk(mesh, [0.5, 0, 0.5], { radius: 2, strength: 3, falloff: 1 });
    // Vertex at (0,0,0) is distance ~0.707 from center — within radius
    // It should be displaced upward
    expect(result.verts[1]).toBeGreaterThan(mesh.verts[1]);
  });

  it("should preserve non-position vertex data (normals, colors)", () => {
    const mesh = makeSimpleMesh();
    const result = deformChunk(mesh, [0.5, 0, 0.5], { radius: 2, strength: 1, falloff: 1 });
    // Check that normal and color data is preserved for all vertices
    for (let v = 0; v < 4; v++) {
      const offset = v * 9;
      // Normal (indices 3,4,5)
      expect(result.verts[offset + 3]).toBeCloseTo(mesh.verts[offset + 3]);
      expect(result.verts[offset + 4]).toBeCloseTo(mesh.verts[offset + 4]);
      expect(result.verts[offset + 5]).toBeCloseTo(mesh.verts[offset + 5]);
      // Color (indices 6,7,8)
      expect(result.verts[offset + 6]).toBeCloseTo(mesh.verts[offset + 6]);
      expect(result.verts[offset + 7]).toBeCloseTo(mesh.verts[offset + 7]);
      expect(result.verts[offset + 8]).toBeCloseTo(mesh.verts[offset + 8]);
    }
  });

  it("should preserve indices and useUint32 flag", () => {
    const mesh = makeSimpleMesh();
    const result = deformChunk(mesh, [0.5, 0, 0.5], { radius: 2, strength: 1, falloff: 1 });
    expect(result.indices).toBe(mesh.indices);
    expect(result.useUint32).toBe(mesh.useUint32);
  });

  it("should not modify original mesh", () => {
    const mesh = makeSimpleMesh();
    const originalY = mesh.verts[1];
    deformChunk(mesh, [0, 0, 0], { radius: 5, strength: 10, falloff: 1 });
    expect(mesh.verts[1]).toBeCloseTo(originalY);
  });

  it("should handle 9-float stride correctly (not 3-float)", () => {
    // Create a mesh with distinct color values to verify stride is 9 not 3
    const verts = new Float32Array([
      0, 0, 0,  0, 1, 0,  0.1, 0.2, 0.3,
      2, 0, 0,  0, 1, 0,  0.4, 0.5, 0.6,
    ]);
    const mesh: ExtractedMesh = { verts, indices: new Uint16Array([0, 1, 0]), useUint32: false };
    const result = deformChunk(mesh, [0, 0, 0], { radius: 1, strength: 5, falloff: 1 });
    // Vertex 0 at (0,0,0) should be displaced
    expect(result.verts[1]).toBeGreaterThan(0);
    // Vertex 1 at (2,0,0) is distance 2 — outside radius 1, should not be displaced
    expect(result.verts[10]).toBeCloseTo(0); // y of vertex 1 (offset 9+1=10)
    // Color of vertex 0 should be preserved
    expect(result.verts[6]).toBeCloseTo(0.1);
    expect(result.verts[7]).toBeCloseTo(0.2);
    expect(result.verts[8]).toBeCloseTo(0.3);
  });
});
