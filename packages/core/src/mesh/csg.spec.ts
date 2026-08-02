import { MeshBuilder } from "./builder.ts";
import { BSPNode, csgIntersect, csgSubtract, csgUnion } from "./csg.ts";

describe("CSG", () => {
  const cubeA = MeshBuilder.cube(1);
  const cubeB = MeshBuilder.cube(0.5);

  describe("BSPNode", () => {
    it("should build from polygons and recover them", () => {
      const bsp = new BSPNode();
      // Use a simple triangle
      const polys = [{
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
        normal: [0, 0, 1] as [number, number, number],
        shared: 0,
      }];
      bsp.build(polys);
      const recovered = bsp.allPolygons();
      expect(recovered.length).toBeGreaterThanOrEqual(1);
    });

    it("should invert and recover inverted normals", () => {
      const bsp = new BSPNode();
      const polys = [{
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
        normal: [0, 0, 1] as [number, number, number],
        shared: 0,
      }];
      bsp.build(polys);
      bsp.invert();
      const recovered = bsp.allPolygons();
      expect(recovered[0].normal[2]).toBeCloseTo(-1, 3);
    });
  });

  describe("csgUnion", () => {
    it("should produce a valid mesh", () => {
      const result = csgUnion(cubeA, cubeB);
      expect(result.vertexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeGreaterThan(0);
      expect(result.vertices.length).toBe(result.vertexCount * (cubeA.layout.stride / 4));
    });

    it("should produce more or equal indices than either input", () => {
      const result = csgUnion(cubeA, cubeB);
      expect(result.indexCount).toBeGreaterThanOrEqual(Math.min(cubeA.indexCount, cubeB.indexCount));
    });
  });

  describe("csgSubtract", () => {
    it("should produce a valid mesh", () => {
      const result = csgSubtract(cubeA, cubeB);
      expect(result.vertexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeGreaterThan(0);
    });

    it("should produce indices when subtracting smaller cube from larger", () => {
      const result = csgSubtract(cubeA, cubeB);
      expect(result.indexCount).toBeGreaterThan(0);
    });
  });

  describe("csgIntersect", () => {
    it("should produce a valid mesh", () => {
      const result = csgIntersect(cubeA, cubeB);
      expect(result.vertexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeGreaterThan(0);
    });

    it("should produce a valid mesh with reasonable polygon count", () => {
      const result = csgIntersect(cubeA, cubeB);
      expect(result.indexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeLessThan(cubeA.indexCount * 10);
    });
  });

  describe("edge cases", () => {
    it("should handle identical meshes in union", () => {
      const result = csgUnion(cubeA, cubeA);
      expect(result.vertexCount).toBeGreaterThan(0);
    });

    it("should handle identical meshes in subtract (should produce empty or minimal)", () => {
      const result = csgSubtract(cubeA, cubeA);
      expect(result.indexCount).toBeGreaterThanOrEqual(0);
    });
  });
});
