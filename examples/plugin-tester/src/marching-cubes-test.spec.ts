import type { DeformationConfig, DensityField, MCChunkConfig, VoxelField } from "@downdraft/engine/libraries/marching-cubes";
import {
    CHUNK_FULL,
    CHUNK_SOLID,
    DEFAULT_LOD_LEVELS,
    DEFAULT_MC_CONFIG,
    DEFAULT_STREAMING_CONFIG,
    TerrainLODManager,
    allocateChunk,
    applyDeformation,
    applyMultipleDeformations,
    createChunkedVoxelField,
    defaultDensityField,
    deformChunk,
    extractMeshFromField,
    generateChunk,
    getChunkedVoxel,
    getLODVoxelSize,
    isChunkEmpty,
    isChunkGenerated,
    markChunkGenerated,
    promoteChunk,
    setChunkedVoxel
} from "@downdraft/engine/libraries/marching-cubes";
import { beforeEach, describe, expect, it, vi } from "bun:test";

// ============================================================================
// Helper: Create a simple sphere density field
// ============================================================================

function sphereField(cx: number, cy: number, cz: number, radius: number): DensityField {
  return (x: number, y: number, z: number) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    return radius - Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
}

function planeField(height: number): DensityField {
  return (_x: number, y: number, _z: number) => height - y;
}

// ============================================================================
// generateChunk Tests
// ============================================================================

describe("generateChunk", () => {
  it("should generate a mesh with vertices and indices for a sphere field", () => {
    const field = sphereField(16, 16, 16, 10);
    const config: MCChunkConfig = { chunkSize: 32, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.indexCount).toBeGreaterThan(0);
    expect(mesh.vertices.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.indices.length).toBe(mesh.indexCount);
  });

  it("should produce no geometry for an entirely solid field", () => {
    const field = () => 1.0;
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
  });

  it("should produce no geometry for an entirely empty field", () => {
    const field = () => -1.0;
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
  });

  it("should generate geometry for a plane field", () => {
    const field = planeField(4);
    const config: MCChunkConfig = { chunkSize: 16, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.indexCount).toBeGreaterThan(0);
  });

  it("should produce valid triangle indices (multiples of 3)", () => {
    const field = sphereField(8, 8, 8, 5);
    const config: MCChunkConfig = { chunkSize: 16, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.indexCount % 3).toBe(0);
  });

  it("should produce normalized normals", () => {
    const field = sphereField(8, 8, 8, 5);
    const config: MCChunkConfig = { chunkSize: 16, isoLevel: 0.5, scale: 1.0 };
    const mesh = generateChunk(0, 0, 0, field, config);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const nx = mesh.normals[i * 3];
      const ny = mesh.normals[i * 3 + 1];
      const nz = mesh.normals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      expect(len).toBeCloseTo(1.0, 3);
    }
  });

  it("should respect scale parameter", () => {
    const field = planeField(4);
    const config1: MCChunkConfig = { chunkSize: 16, isoLevel: 0.5, scale: 1.0 };
    const config2: MCChunkConfig = { chunkSize: 16, isoLevel: 0.5, scale: 2.0 };
    const mesh1 = generateChunk(0, 0, 0, field, config1);
    const mesh2 = generateChunk(0, 0, 0, field, config2);
    // With scale 2, vertices should be further apart
    const maxVert1 = Math.max(...mesh1.vertices);
    const maxVert2 = Math.max(...mesh2.vertices);
    expect(maxVert2).toBeGreaterThan(maxVert1);
  });

  it("should use DEFAULT_MC_CONFIG values", () => {
    expect(DEFAULT_MC_CONFIG.chunkSize).toBe(32);
    expect(DEFAULT_MC_CONFIG.isoLevel).toBe(0.5);
    expect(DEFAULT_MC_CONFIG.scale).toBe(1.0);
  });
});

// ============================================================================
// defaultDensityField Tests
// ============================================================================

describe("defaultDensityField", () => {
  it("should return a number for any input", () => {
    const val = defaultDensityField(10, 5, 10, 20, 0.05);
    expect(typeof val).toBe("number");
    expect(Number.isFinite(val)).toBe(true);
  });

  it("should produce terrain-like values (varying with y)", () => {
    const val0 = defaultDensityField(0, 0, 0, 20, 0.05);
    const val20 = defaultDensityField(0, 20, 0, 20, 0.05);
    // The density field should produce different values at different heights
    expect(val0).not.toBe(val20);
  });

  it("should use default parameters when omitted", () => {
    const val = defaultDensityField(0, 0, 0);
    expect(typeof val).toBe("number");
  });
});

// ============================================================================
// extractMeshFromField Tests
// ============================================================================

describe("extractMeshFromField", () => {
  function createSimpleVoxelField(dimX: number, dimY: number, dimZ: number): VoxelField {
    const data = new Float32Array(dimX * dimY * dimZ);
    // Fill with a simple sphere
    const cx = dimX / 2, cy = dimY / 2, cz = dimZ / 2;
    const radius = Math.min(dimX, dimY, dimZ) / 3;
    for (let x = 0; x < dimX; x++) {
      for (let y = 0; y < dimY; y++) {
        for (let z = 0; z < dimZ; z++) {
          const dx = x - cx, dy = y - cy, dz = z - cz;
          data[x * dimY * dimZ + y * dimZ + z] = radius - Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
      }
    }
    return {
      dimX, dimY, dimZ,
      voxelSize: 1.0,
      originX: 0, originY: 0, originZ: 0,
      isoLevel: 0.0,
      radius: 100,
      data,
    };
  }

  it("should extract mesh from a voxel field", () => {
    const field = createSimpleVoxelField(16, 16, 16);
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it("should return useUint32 false for small fields", () => {
    const field = createSimpleVoxelField(16, 16, 16);
    const mesh = extractMeshFromField(field);
    expect(mesh.useUint32).toBe(false);
  });

  it("should support sub-region extraction", () => {
    const field = createSimpleVoxelField(16, 16, 16);
    const fullMesh = extractMeshFromField(field);
    const subMesh = extractMeshFromField(field, { x0: 4, y0: 4, z0: 4, x1: 12, y1: 12, z1: 12 });
    expect(subMesh.verts.length).toBeLessThanOrEqual(fullMesh.verts.length);
  });

  it("should support colorFn callback", () => {
    const field = createSimpleVoxelField(16, 16, 16);
    const colorFn = vi.fn(() => [1.0, 0.0, 0.0] as [number, number, number]);
    const mesh = extractMeshFromField(field, { colorFn });
    expect(colorFn).toHaveBeenCalled();
    // Each vertex has 9 floats: pos(3) + normal(3) + color(3)
    expect(mesh.verts.length % 9).toBe(0);
  });

  it("should produce empty mesh for all-solid field", () => {
    const field: VoxelField = {
      dimX: 8, dimY: 8, dimZ: 8,
      voxelSize: 1.0,
      originX: 0, originY: 0, originZ: 0,
      isoLevel: 0.0,
      radius: 100,
      data: new Float32Array(8 * 8 * 8).fill(1.0),
    };
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBe(0);
  });

  it("should produce empty mesh for all-empty field", () => {
    const field: VoxelField = {
      dimX: 8, dimY: 8, dimZ: 8,
      voxelSize: 1.0,
      originX: 0, originY: 0, originZ: 0,
      isoLevel: 0.0,
      radius: 100,
      data: new Float32Array(8 * 8 * 8).fill(-1.0),
    };
    const mesh = extractMeshFromField(field);
    expect(mesh.verts.length).toBe(0);
  });
});

// ============================================================================
// Deformation Tests
// ============================================================================

describe("Deformation", () => {
  describe("applyDeformation", () => {
    it("should modify density near deformation point", () => {
      const baseField = planeField(4);
      const config: DeformationConfig = { radius: 5, strength: 10, falloff: 2 };
      const deformedField = applyDeformation(baseField, [0, 4, 0], config);
      const originalVal = baseField(0, 4, 0);
      const deformedVal = deformedField(0, 4, 0);
      expect(deformedVal).toBeGreaterThan(originalVal);
    });

    it("should not modify density outside radius", () => {
      const baseField = planeField(4);
      const config: DeformationConfig = { radius: 2, strength: 10, falloff: 2 };
      const deformedField = applyDeformation(baseField, [0, 4, 0], config);
      const originalVal = baseField(100, 4, 100);
      const deformedVal = deformedField(100, 4, 100);
      expect(deformedVal).toBe(originalVal);
    });

    it("should apply falloff (closer = stronger)", () => {
      const baseField = planeField(4);
      const config: DeformationConfig = { radius: 10, strength: 10, falloff: 2 };
      const deformedField = applyDeformation(baseField, [0, 4, 0], config);
      const nearVal = deformedField(0, 4, 0) - baseField(0, 4, 0);
      const farVal = deformedField(5, 4, 0) - baseField(5, 4, 0);
      expect(nearVal).toBeGreaterThan(farVal);
    });
  });

  describe("applyMultipleDeformations", () => {
    it("should apply multiple deformations in sequence", () => {
      const baseField = planeField(4);
      const deformedField = applyMultipleDeformations(baseField, [
        { pos: [0, 4, 0], config: { radius: 5, strength: 5, falloff: 2 } },
        { pos: [0, 4, 0], config: { radius: 5, strength: 5, falloff: 2 } },
      ]);
      const singleField = applyDeformation(baseField, [0, 4, 0], { radius: 5, strength: 5, falloff: 2 });
      const singleVal = singleField(0, 4, 0) - baseField(0, 4, 0);
      const doubleVal = deformedField(0, 4, 0) - baseField(0, 4, 0);
      expect(doubleVal).toBeGreaterThan(singleVal);
    });

    it("should handle empty deformation array", () => {
      const baseField = planeField(4);
      const result = applyMultipleDeformations(baseField, []);
      expect(result(0, 4, 0)).toBe(baseField(0, 4, 0));
    });
  });

  describe("deformChunk", () => {
    it("should modify vertex Y positions near deformation point", () => {
      const field = sphereField(16, 16, 16, 10);
      const config: MCChunkConfig = { chunkSize: 32, isoLevel: 0.5, scale: 1.0 };
      const mesh = generateChunk(0, 0, 0, field, config);
      const deformConfig: DeformationConfig = { radius: 10, strength: 5, falloff: 2 };
      const deformedMesh = deformChunk(mesh, [16, 16, 16], deformConfig);
      // At least some vertices should have different Y positions
      let anyChanged = false;
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (Math.abs(mesh.vertices[i * 3 + 1] - deformedMesh.vertices[i * 3 + 1]) > 1e-6) {
          anyChanged = true;
          break;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it("should not modify vertices outside radius", () => {
      const field = sphereField(16, 16, 16, 10);
      const config: MCChunkConfig = { chunkSize: 32, isoLevel: 0.5, scale: 1.0 };
      const mesh = generateChunk(0, 0, 0, field, config);
      const deformConfig: DeformationConfig = { radius: 0.1, strength: 5, falloff: 2 };
      const deformedMesh = deformChunk(mesh, [100, 100, 100], deformConfig);
      // No vertices should change
      for (let i = 0; i < mesh.vertexCount; i++) {
        expect(deformedMesh.vertices[i * 3 + 1]).toBe(mesh.vertices[i * 3 + 1]);
      }
    });

    it("should not modify the original mesh", () => {
      const field = sphereField(16, 16, 16, 10);
      const config: MCChunkConfig = { chunkSize: 32, isoLevel: 0.5, scale: 1.0 };
      const mesh = generateChunk(0, 0, 0, field, config);
      const originalVerts = new Float32Array(mesh.vertices);
      deformChunk(mesh, [16, 16, 16], { radius: 10, strength: 5, falloff: 2 });
      for (let i = 0; i < originalVerts.length; i++) {
        expect(mesh.vertices[i]).toBe(originalVerts[i]);
      }
    });
  });
});

// ============================================================================
// ChunkedVoxelField Tests
// ============================================================================

describe("ChunkedVoxelField", () => {
  it("should create a field with correct dimensions", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    expect(field.dimX).toBe(64);
    expect(field.dimY).toBe(64);
    expect(field.dimZ).toBe(64);
    expect(field.chunkSize).toBe(32);
    expect(field.chunkDimX).toBe(2);
    expect(field.chunkDimY).toBe(2);
    expect(field.chunkDimZ).toBe(2);
  });

  it("should return -1 for out-of-bounds gets", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    expect(getChunkedVoxel(field, -1, 0, 0)).toBe(-1.0);
    expect(getChunkedVoxel(field, 64, 0, 0)).toBe(-1.0);
    expect(getChunkedVoxel(field, 0, -1, 0)).toBe(-1.0);
  });

  it("should return -1 for unallocated chunks (CHUNK_EMPTY)", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(-1.0);
  });

  it("should return 1 for CHUNK_SOLID chunks", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    const chunkIdx = 0;
    field.chunkClass[chunkIdx] = CHUNK_SOLID;
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(1.0);
  });

  it("should allocate and read back chunk data", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    const chunkIdx = 0;
    const offset = allocateChunk(field, chunkIdx);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(field.chunkClass[chunkIdx]).toBe(CHUNK_FULL);
    setChunkedVoxel(field, 0, 0, 0, 0.5);
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(0.5);
  });

  it("should not set voxels on non-FULL chunks", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    setChunkedVoxel(field, 0, 0, 0, 0.5);
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(-1.0);
  });

  it("should track generated state", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    expect(isChunkGenerated(field, 0)).toBe(false);
    markChunkGenerated(field, 0);
    expect(isChunkGenerated(field, 0)).toBe(true);
  });

  it("should detect empty chunks", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    expect(isChunkEmpty(field, 0)).toBe(true);
    allocateChunk(field, 0);
    expect(isChunkEmpty(field, 0)).toBe(false);
  });

  it("should promote CHUNK_EMPTY to CHUNK_FULL with 1.0 fill (empty = above surface)", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    const offset = promoteChunk(field, 0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(field.chunkClass[0]).toBe(CHUNK_FULL);
    // CHUNK_EMPTY means "no solid material" — density is positive (above surface)
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(1.0);
  });

  it("should promote CHUNK_SOLID to CHUNK_FULL with 1.0 fill", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32);
    field.chunkClass[0] = CHUNK_SOLID;
    const offset = promoteChunk(field, 0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(field.chunkClass[0]).toBe(CHUNK_FULL);
    expect(getChunkedVoxel(field, 0, 0, 0)).toBe(1.0);
  });

  it("should return -1 when no buffer space left for allocation", () => {
    const field = createChunkedVoxelField(0, 0, 100, 1.0, 64, 64, 64, 0, 0, 0, 0.0, 32, false, 1024);
    // Very small memory budget — can't even fit one chunk
    const offset = allocateChunk(field, 0);
    expect(offset).toBe(-1);
  });
});

// ============================================================================
// TerrainLODManager Tests
// ============================================================================

describe("TerrainLODManager", () => {
  let field: DensityField;
  let manager: TerrainLODManager;

  beforeEach(() => {
    field = planeField(4);
    manager = new TerrainLODManager(field, DEFAULT_LOD_LEVELS, 0);
  });

  it("should select LOD 0 for chunks near camera", () => {
    manager.setCamera([0, 0, 0]);
    expect(manager.selectLOD(0, 0)).toBe(0);
  });

  it("should select higher LOD for distant chunks", () => {
    manager.setCamera([0, 0, 0]);
    const lod = manager.selectLOD(10, 10);
    expect(lod).toBeGreaterThan(0);
  });

  it("should create a chunk entry on getOrCreateChunk", () => {
    const entry = manager.getOrCreateChunk(0, 0);
    expect(entry.coord.x).toBe(0);
    expect(entry.coord.z).toBe(0);
    expect(entry.dirty).toBe(true);
    expect(entry.mesh).toBe(null);
  });

  it("should return same entry for same chunk coords", () => {
    const entry1 = manager.getOrCreateChunk(0, 0);
    const entry2 = manager.getOrCreateChunk(0, 0);
    expect(entry1).toBe(entry2);
  });

  it("should generate mesh for a chunk", () => {
    const mesh = manager.generateChunk(0, 0);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.indexCount).toBeGreaterThan(0);
    const entry = manager.getChunk("0:0");
    expect(entry?.mesh).not.toBe(null);
    expect(entry?.dirty).toBe(false);
  });

  it("should track stats correctly", () => {
    manager.getOrCreateChunk(0, 0);
    manager.getOrCreateChunk(1, 0);
    const stats = manager.getStats();
    expect(stats.total).toBe(2);
    expect(stats.dirty).toBe(2);
    expect(stats.generated).toBe(0);
  });

  it("should update stats after generation", () => {
    manager.generateChunk(0, 0);
    const stats = manager.getStats();
    expect(stats.generated).toBe(1);
    expect(stats.dirty).toBe(0);
  });

  it("should detect LOD changes in updateLOD", () => {
    manager.setCamera([0, 0, 0]);
    manager.getOrCreateChunk(0, 0);
    // Move camera far away
    manager.setCamera([10000, 0, 10000]);
    const result = manager.updateLOD();
    expect(result.toGenerate.length).toBeGreaterThan(0);
  });

  it("should remove chunks", () => {
    manager.getOrCreateChunk(0, 0);
    manager.removeChunk(0, 0);
    expect(manager.getChunk("0:0")).toBeUndefined();
  });

  it("should clear all chunks", () => {
    manager.getOrCreateChunk(0, 0);
    manager.getOrCreateChunk(1, 1);
    manager.clear();
    expect(manager.getAllChunks().length).toBe(0);
  });

  it("should use default LOD levels when not provided", () => {
    const mgr = new TerrainLODManager(field);
    expect(mgr.getStats().total).toBe(0);
  });
});

// ============================================================================
// Streaming Config Tests
// ============================================================================

describe("Streaming Config", () => {
  it("should return base voxel size for distance 0", () => {
    const voxelSize = getLODVoxelSize(0, DEFAULT_STREAMING_CONFIG.lodLevels);
    expect(voxelSize).toBe(DEFAULT_STREAMING_CONFIG.lodLevels[0].voxelSize);
  });

  it("should return larger voxel size for greater distances", () => {
    const near = getLODVoxelSize(100, DEFAULT_STREAMING_CONFIG.lodLevels);
    const far = getLODVoxelSize(1000, DEFAULT_STREAMING_CONFIG.lodLevels);
    expect(far).toBeGreaterThan(near);
  });

  it("should return last level voxel size for distances beyond all levels", () => {
    const voxelSize = getLODVoxelSize(99999, DEFAULT_STREAMING_CONFIG.lodLevels);
    expect(voxelSize).toBe(DEFAULT_STREAMING_CONFIG.lodLevels[DEFAULT_STREAMING_CONFIG.lodLevels.length - 1].voxelSize);
  });

  it("DEFAULT_STREAMING_CONFIG should have valid values", () => {
    expect(DEFAULT_STREAMING_CONFIG.baseVoxelSize).toBeGreaterThan(0);
    expect(DEFAULT_STREAMING_CONFIG.lodLevels.length).toBeGreaterThan(0);
    expect(DEFAULT_STREAMING_CONFIG.chunkGenMaxPerTick).toBeGreaterThan(0);
    expect(DEFAULT_STREAMING_CONFIG.generationRange).toBeGreaterThan(0);
  });
});
