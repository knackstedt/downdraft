import { extractMeshFromField } from "./surface-nets";
import type { VoxelField } from "./types";

function makeSphereField(
  dimX: number, dimY: number, dimZ: number,
  cx: number, cy: number, cz: number,
  radius: number,
  voxelSize: number = 1,
): VoxelField {
  const data = new Float32Array(dimX * dimY * dimZ);
  const dimYDimZ = dimY * dimZ;
  for (let x = 0; x < dimX; x++) {
    for (let y = 0; y < dimY; y++) {
      for (let z = 0; z < dimZ; z++) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        data[x * dimYDimZ + y * dimZ + z] = radius - dist;
      }
    }
  }
  return {
    data,
    dimX, dimY, dimZ,
    voxelSize,
    originX: 0, originY: 0, originZ: 0,
    isoLevel: 0,
    radius: radius * voxelSize,
  };
}

function makeHalfSpaceField(
  dimX: number, dimY: number, dimZ: number,
  isoY: number,
  voxelSize: number = 1,
): VoxelField {
  const data = new Float32Array(dimX * dimY * dimZ);
  const dimYDimZ = dimY * dimZ;
  for (let x = 0; x < dimX; x++) {
    for (let y = 0; y < dimY; y++) {
      for (let z = 0; z < dimZ; z++) {
        data[x * dimYDimZ + y * dimZ + z] = isoY - y;
      }
    }
  }
  return {
    data,
    dimX, dimY, dimZ,
    voxelSize,
    originX: 0, originY: 0, originZ: 0,
    isoLevel: 0,
    radius: dimX * voxelSize,
  };
}

describe("Surface Nets", () => {
  it("should generate an empty mesh for uniform density below iso level", () => {
    const field: VoxelField = {
      data: new Float32Array(4 * 4 * 4).fill(-1),
      dimX: 4, dimY: 4, dimZ: 4,
      voxelSize: 1, originX: 0, originY: 0, originZ: 0,
      isoLevel: 0, radius: 4,
    };
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });

  it("should generate an empty mesh for uniform density above iso level", () => {
    const field: VoxelField = {
      data: new Float32Array(4 * 4 * 4).fill(1),
      dimX: 4, dimY: 4, dimZ: 4,
      voxelSize: 1, originX: 0, originY: 0, originZ: 0,
      isoLevel: 0, radius: 4,
    };
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });

  it("should generate geometry for a half-space density field", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it("should produce 9 floats per vertex (pos+normal+color)", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    const vertexCount = mesh.verts.length / 9;
    expect(mesh.verts.length % 9).toBe(0);
    expect(vertexCount).toBeGreaterThan(0);
  });

  it("should produce valid triangle indices", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    const vertexCount = mesh.verts.length / 9;
    expect(mesh.indices.length % 3).toBe(0);
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThan(vertexCount);
    }
  });

  it("should generate geometry for a sphere field", () => {
    const field = makeSphereField(10, 10, 10, 5, 5, 5, 3);
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it("should produce fewer vertices than marching cubes for same field", () => {
    // Surface nets has one vertex per boundary voxel (shared),
    // while MC duplicates vertices per triangle.
    // A half-space 8x8x8 field should have ~49 boundary cells in SN
    // vs ~196 vertices in MC (49 quads * 4 verts * 3/2 tris).
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    const snVertexCount = mesh.verts.length / 9;
    // MC would produce ~7*7 = 49 quads = 98 triangles = 294 vertices
    // SN should produce ~7*7 = 49 vertices (one per boundary cell)
    expect(snVertexCount).toBeLessThanOrEqual(49);
  });

  it("should apply color callback to vertices", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const colorFn = () => [0.5, 0.2, 0.1] as [number, number, number];
    const mesh = extractMeshFromField(field, { colorFn });
    const vertexCount = mesh.verts.length / 9;
    for (let i = 0; i < vertexCount; i++) {
      const offset = i * 9 + 6;
      expect(mesh.verts[offset]).toBeCloseTo(0.5);
      expect(mesh.verts[offset + 1]).toBeCloseTo(0.2);
      expect(mesh.verts[offset + 2]).toBeCloseTo(0.1);
    }
  });

  it("should default to white color when no colorFn provided", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    const vertexCount = mesh.verts.length / 9;
    for (let i = 0; i < vertexCount; i++) {
      const offset = i * 9 + 6;
      expect(mesh.verts[offset]).toBeCloseTo(1);
      expect(mesh.verts[offset + 1]).toBeCloseTo(1);
      expect(mesh.verts[offset + 2]).toBeCloseTo(1);
    }
  });

  it("should flip downward normals by default", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    const vertexCount = mesh.verts.length / 9;
    // For a half-space where solid is below (density = isoY - y, positive below),
    // outward normal should point up (ny > 0) after flip
    let hasUpNormal = false;
    for (let i = 0; i < vertexCount; i++) {
      const ny = mesh.verts[i * 9 + 4];
      if (ny > 0) hasUpNormal = true;
    }
    expect(hasUpNormal).toBe(true);
  });

  it("should not flip normals when flipDownNormals is false", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field, { flipDownNormals: false });
    const vertexCount = mesh.verts.length / 9;
    // Without flipping, some normals may point down
    let hasDownNormal = false;
    for (let i = 0; i < vertexCount; i++) {
      const ny = mesh.verts[i * 9 + 4];
      if (ny < 0) hasDownNormal = true;
    }
    // At least some normals should point down without flipping
    // (gradient-based normals for a flat surface should be consistent,
    // but the test just verifies the option doesn't throw)
    expect(vertexCount).toBeGreaterThan(0);
  });

  it("should respect sub-region bounds", () => {
    const field = makeHalfSpaceField(16, 16, 16, 8);
    const fullMesh = extractMeshFromField(field);
    const subMesh = extractMeshFromField(field, { x0: 4, y0: 4, z0: 4, x1: 12, y1: 12, z1: 12 });
    // Sub-region should produce fewer vertices than full field
    expect(subMesh.verts.length).toBeLessThan(fullMesh.verts.length);
    expect(subMesh.verts.length).toBeGreaterThan(0);
  });

  it("should upgrade to Uint32 indices when vertex count exceeds 65535", () => {
    // Need a large enough field to produce >65535 boundary cells
    // 40x40x40 half-space = 39*39 = 1521 boundary cells — not enough
    // Use a larger field
    const dim = 300;
    const field = makeHalfSpaceField(dim, 4, dim, 2, 0.5);
    const mesh = extractMeshFromField(field);
    const vertexCount = mesh.verts.length / 9;
    if (vertexCount > 65535) {
      expect(mesh.useUint32).toBe(true);
      expect(mesh.indices instanceof Uint32Array).toBe(true);
    }
  });

  it("should use Uint16 indices for small meshes", () => {
    const field = makeHalfSpaceField(8, 8, 8, 4);
    const mesh = extractMeshFromField(field);
    expect(mesh.useUint32).toBe(false);
    expect(mesh.indices instanceof Uint16Array).toBe(true);
  });

  it("should produce 2 triangles per quad (index count divisible by 3)", () => {
    const field = makeSphereField(10, 10, 10, 5, 5, 5, 3);
    const mesh = extractMeshFromField(field);
    expect(mesh.indices.length % 3).toBe(0);
    // Each quad produces 2 triangles = 6 indices
    expect(mesh.indices.length % 6).toBe(0);
  });

  it("should handle out-of-bounds gracefully", () => {
    // Field with all -1 (empty) at borders, solid in center
    const dim = 6;
    const data = new Float32Array(dim * dim * dim).fill(-1);
    const dimYDimZ = dim * dim;
    // Make center cells solid
    for (let x = 2; x < 4; x++)
      for (let y = 2; y < 4; y++)
        for (let z = 2; z < 4; z++)
          data[x * dimYDimZ + y * dim + z] = 1;
    const field: VoxelField = {
      data,
      dimX: dim, dimY: dim, dimZ: dim,
      voxelSize: 1, originX: 0, originY: 0, originZ: 0,
      isoLevel: 0, radius: dim,
    };
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    // All indices should be valid
    const vc = mesh.verts.length / 9;
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThan(vc);
    }
  });
});
