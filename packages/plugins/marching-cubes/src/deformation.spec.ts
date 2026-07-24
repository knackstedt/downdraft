import { applyDeformation, applyMultipleDeformations, deformChunk, type DeformationConfig } from "./deformation.ts";
import { generateChunk, type DensityField, type MCMesh } from "./generator.ts";

describe("Marching Cubes Deformation", () => {
  const baseField: DensityField = (_x, y, _z) => y - 2;
  const deformConfig: DeformationConfig = { radius: 5, strength: 1, falloff: 2 };

  describe("applyDeformation", () => {
    it("should return a function", () => {
      const deformed = applyDeformation(baseField, [0, 0, 0], deformConfig);
      expect(typeof deformed).toBe("function");
    });

    it("should not modify field outside radius", () => {
      const deformed = applyDeformation(baseField, [0, 0, 0], deformConfig);
      const original = baseField(100, 100, 100);
      const result = deformed(100, 100, 100);
      expect(result).toBe(original);
    });

    it("should modify field within radius", () => {
      const deformed = applyDeformation(baseField, [0, 2, 0], deformConfig);
      const original = baseField(0, 2, 0);
      const result = deformed(0, 2, 0);
      expect(result).toBeGreaterThan(original);
    });

    it("should apply strength proportional to distance", () => {
      const deformed = applyDeformation(baseField, [0, 2, 0], deformConfig);
      const atCenter = deformed(0, 2, 0);
      const atEdge = deformed(4, 2, 0);
      const centerDelta = atCenter - baseField(0, 2, 0);
      const edgeDelta = atEdge - baseField(4, 2, 0);
      expect(centerDelta).toBeGreaterThan(edgeDelta);
    });
  });

  describe("applyMultipleDeformations", () => {
    it("should apply multiple deformations in sequence", () => {
      const deformed = applyMultipleDeformations(baseField, [
        { pos: [0, 2, 0], config: deformConfig },
        { pos: [10, 2, 0], config: deformConfig },
      ]);

      const atFirst = deformed(0, 2, 0) - baseField(0, 2, 0);
      const atSecond = deformed(10, 2, 0) - baseField(10, 2, 0);
      expect(atFirst).toBeGreaterThan(0);
      expect(atSecond).toBeGreaterThan(0);
    });

    it("should handle empty deformation list", () => {
      const deformed = applyMultipleDeformations(baseField, []);
      expect(deformed(0, 0, 0)).toBe(baseField(0, 0, 0));
    });
  });

  describe("deformChunk", () => {
    it("should return a new mesh with modified vertices", () => {
      const field: DensityField = (_x, y, _z) => y - 2;
      const mesh = generateChunk(0, 0, 0, field, { chunkSize: 8, isoLevel: 0, scale: 1 });
      const deformed = deformChunk(mesh, [2, 2, 2], deformConfig);

      expect(deformed).not.toBe(mesh);
      expect(deformed.vertices).not.toBe(mesh.vertices);
    });

    it("should not modify vertices outside radius", () => {
      const field: DensityField = (_x, y, _z) => y - 2;
      const mesh = generateChunk(0, 0, 0, field, { chunkSize: 8, isoLevel: 0, scale: 1 });
      const deformed = deformChunk(mesh, [100, 100, 100], deformConfig);

      let changed = false;
      for (let i = 0; i < mesh.vertices.length; i++) {
        if (mesh.vertices[i] !== deformed.vertices[i]) {
          changed = true;
          break;
        }
      }
      expect(changed).toBe(false);
    });

    it("should modify y-coordinate of vertices within radius", () => {
      const field: DensityField = (_x, y, _z) => y - 2;
      const mesh = generateChunk(0, 0, 0, field, { chunkSize: 8, isoLevel: 0, scale: 1 });

      if (mesh.vertexCount === 0) return;

      const centerVertex = [mesh.vertices[0], mesh.vertices[1], mesh.vertices[2]] as number[];
      const localConfig: DeformationConfig = { radius: 10, strength: 5, falloff: 2 };
      const deformed = deformChunk(mesh, centerVertex as [number, number, number], localConfig);

      expect(deformed.vertices[1]).not.toBe(mesh.vertices[1]);
    });

    it("should preserve other mesh properties", () => {
      const field: DensityField = (_x, y, _z) => y - 2;
      const mesh = generateChunk(0, 0, 0, field, { chunkSize: 8, isoLevel: 0, scale: 1 });
      const deformed = deformChunk(mesh, [0, 0, 0], deformConfig);

      expect(deformed.normals).toBe(mesh.normals);
      expect(deformed.indices).toBe(mesh.indices);
      expect(deformed.vertexCount).toBe(mesh.vertexCount);
      expect(deformed.indexCount).toBe(mesh.indexCount);
    });
  });
});
