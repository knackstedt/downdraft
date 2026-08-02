import { computeDecalProjectionMatrix, computeDecalViewMatrix, createDecalMesh, type DecalProjector } from "./decal-mesh.ts";

describe("DecalMesh", () => {
  const defaultProjector: DecalProjector = {
    position: [0, 0, 0],
    direction: [0, 0, 1],
    up: [0, 1, 0],
    width: 2,
    height: 2,
    depth: 2,
  };

  describe("createDecalMesh", () => {
    it("should generate a box with 24 vertices and 36 indices", () => {
      const mesh = createDecalMesh(defaultProjector);
      expect(mesh.vertexCount).toBe(24);
      expect(mesh.indexCount).toBe(36);
    });

    it("should use Uint16Array for indices", () => {
      const mesh = createDecalMesh(defaultProjector);
      expect(mesh.indices instanceof Uint16Array).toBe(true);
    });

    it("should produce valid normals", () => {
      const mesh = createDecalMesh(defaultProjector);
      const n0 = mesh.vertices[3];
      const n1 = mesh.vertices[4];
      const n2 = mesh.vertices[5];
      const len = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2);
      expect(len).toBeCloseTo(1, 5);
    });

    it("should handle non-default direction", () => {
      const projector: DecalProjector = {
        ...defaultProjector,
        direction: [1, 0, 0],
        up: [0, 1, 0],
      };
      const mesh = createDecalMesh(projector);
      expect(mesh.vertexCount).toBe(24);
    });

    it("should handle non-default position", () => {
      const projector: DecalProjector = {
        ...defaultProjector,
        position: [5, 3, -2],
      };
      const mesh = createDecalMesh(projector);
      expect(mesh.vertexCount).toBe(24);
    });
  });

  describe("computeDecalViewMatrix", () => {
    it("should produce a 16-element array", () => {
      const mat = computeDecalViewMatrix(defaultProjector);
      expect(mat.length).toBe(16);
    });

    it("should produce correct view matrix for origin looking +Z with +Y up", () => {
      const mat = computeDecalViewMatrix(defaultProjector);
      expect(mat[0]).toBeCloseTo(-1, 3);
      expect(mat[5]).toBeCloseTo(1, 3);
      expect(mat[10]).toBeCloseTo(-1, 3);
      expect(mat[15]).toBeCloseTo(1, 3);
    });
  });

  describe("computeDecalProjectionMatrix", () => {
    it("should produce a 16-element array", () => {
      const mat = computeDecalProjectionMatrix(defaultProjector);
      expect(mat.length).toBe(16);
    });

    it("should produce orthographic projection with correct scale", () => {
      const mat = computeDecalProjectionMatrix(defaultProjector);
      expect(mat[0]).toBeCloseTo(1, 3);
      expect(mat[5]).toBeCloseTo(1, 3);
      expect(mat[10]).toBeCloseTo(-1, 3);
    });
  });
});
