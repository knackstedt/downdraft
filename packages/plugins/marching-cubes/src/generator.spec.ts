import { generateChunk, defaultDensityField, DEFAULT_MC_CONFIG, type DensityField, type MCChunkConfig } from "./generator";

describe("Marching Cubes Generator", () => {
  it("should generate an empty mesh for uniform density below iso level", () => {
    const field: DensityField = () => 0;
    const config: MCChunkConfig = { chunkSize: 4, isoLevel: 0.5, scale: 1 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
  });

  it("should generate an empty mesh for uniform density above iso level", () => {
    const field: DensityField = () => 1;
    const config: MCChunkConfig = { chunkSize: 4, isoLevel: 0.5, scale: 1 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBe(0);
    expect(mesh.indexCount).toBe(0);
  });

  it("should generate geometry for a half-space density field", () => {
    const field: DensityField = (_x, y, _z) => y - 2;
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0, scale: 1 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.indexCount).toBeGreaterThan(0);
  });

  it("should produce consistent vertex and normal array sizes", () => {
    const field: DensityField = (_x, y, _z) => y - 2;
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0, scale: 1 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.vertices.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.indices.length).toBe(mesh.indexCount);
  });

  it("should produce valid triangle indices", () => {
    const field: DensityField = (_x, y, _z) => y - 2;
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0, scale: 1 };
    const mesh = generateChunk(0, 0, 0, field, config);
    expect(mesh.indexCount % 3).toBe(0);
    for (let i = 0; i < mesh.indexCount; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThan(mesh.vertexCount);
    }
  });

  it("should respect chunk size parameter", () => {
    const field: DensityField = (_x, y, _z) => y - 2;
    const small = generateChunk(0, 0, 0, field, { chunkSize: 4, isoLevel: 0, scale: 1 });
    const large = generateChunk(0, 0, 0, field, { chunkSize: 16, isoLevel: 0, scale: 1 });
    expect(large.vertexCount).toBeGreaterThan(small.vertexCount);
  });

  it("should respect scale parameter", () => {
    const field: DensityField = (_x, y, _z) => y - 2;
    const mesh = generateChunk(0, 0, 0, field, { chunkSize: 8, isoLevel: 0, scale: 2 });
    let maxCoord = 0;
    for (let i = 0; i < mesh.vertexCount * 3; i++) {
      maxCoord = Math.max(maxCoord, Math.abs(mesh.vertices[i]));
    }
    expect(maxCoord).toBeGreaterThan(8);
  });

  it("defaultDensityField should return a number", () => {
    const val = defaultDensityField(0, 0, 0);
    expect(typeof val).toBe("number");
    expect(isFinite(val)).toBe(true);
  });

  it("defaultDensityField should vary with position", () => {
    const a = defaultDensityField(0, 0, 0);
    const b = defaultDensityField(10, 10, 10);
    expect(a).not.toBe(b);
  });

  it("DEFAULT_MC_CONFIG should have expected defaults", () => {
    expect(DEFAULT_MC_CONFIG.chunkSize).toBe(32);
    expect(DEFAULT_MC_CONFIG.isoLevel).toBe(0.5);
    expect(DEFAULT_MC_CONFIG.scale).toBe(1.0);
  });

  it("should handle spherical density field", () => {
    const field: DensityField = (x, y, z) => {
      const r = Math.sqrt(x * x + y * y + z * z);
      return 3 - r;
    };
    const config: MCChunkConfig = { chunkSize: 8, isoLevel: 0, scale: 1 };
    const mesh = generateChunk(-4, -4, -4, field, config);
    expect(mesh.vertexCount).toBeGreaterThan(0);
  });
});
