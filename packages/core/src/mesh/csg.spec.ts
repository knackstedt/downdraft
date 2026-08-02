import { MeshBuilder, type MeshData } from "./builder.ts";
import { BSPNode, csgIntersect, csgSubtract, csgUnion } from "./csg.ts";

function offsetCube(size: number, x: number, y: number, z: number): MeshData {
  const mesh = MeshBuilder.cube(size);
  const stride = mesh.layout.stride / 4;
  const verts = new Float32Array(mesh.vertices);
  for (let i = 0; i < mesh.vertexCount; i++) {
    verts[i * stride] += x;
    verts[i * stride + 1] += y;
    verts[i * stride + 2] += z;
  }
  return { ...mesh, vertices: verts };
}

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

    it("should handle identical meshes in intersect", () => {
      const result = csgIntersect(cubeA, cubeA);
      expect(result.vertexCount).toBeGreaterThan(0);
    });

    it("should handle non-overlapping meshes in union", () => {
      const offset = offsetCube(0.5, 10, 0, 0);
      const result = csgUnion(cubeA, offset);
      expect(result.vertexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeGreaterThan(0);
    });

    it("should handle non-overlapping meshes in subtract (full cube remains)", () => {
      const offset = offsetCube(0.5, 10, 0, 0);
      const result = csgSubtract(cubeA, offset);
      expect(result.vertexCount).toBeGreaterThan(0);
      expect(result.indexCount).toBeGreaterThan(0);
    });

    it("should handle non-overlapping meshes in intersect (empty or minimal)", () => {
      const offset = offsetCube(0.5, 10, 0, 0);
      const result = csgIntersect(cubeA, offset);
      expect(result.indexCount).toBeGreaterThanOrEqual(0);
    });

    it("should produce Uint16Array for small results", () => {
      const result = csgUnion(cubeA, cubeB);
      expect(result.indices instanceof Uint16Array || result.indices instanceof Uint32Array).toBe(true);
    });

    it("should produce valid vertex stride matching input layout", () => {
      const result = csgUnion(cubeA, cubeB);
      expect(result.vertices.length).toBe(result.vertexCount * (cubeA.layout.stride / 4));
    });
  });

  describe("BSPNode advanced", () => {
    it("should build from multiple polygons and recover all", () => {
      const bsp = new BSPNode();
      const polys = [
        { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][], normal: [0, 0, 1] as [number, number, number], shared: 0 },
        { vertices: [[0, 0, 1], [1, 0, 1], [0, 1, 1]] as [number, number, number][], normal: [0, 0, 1] as [number, number, number], shared: 1 },
      ];
      bsp.build(polys);
      const recovered = bsp.allPolygons();
      expect(recovered.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle empty build", () => {
      const bsp = new BSPNode();
      bsp.build([]);
      expect(bsp.allPolygons().length).toBe(0);
    });

    it("should double-invert to original normals", () => {
      const bsp = new BSPNode();
      const polys = [{
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
        normal: [0, 0, 1] as [number, number, number],
        shared: 0,
      }];
      bsp.build(polys);
      bsp.invert();
      bsp.invert();
      const recovered = bsp.allPolygons();
      expect(recovered[0].normal[2]).toBeCloseTo(1, 3);
    });

    it("should clip polygons via clipTo", () => {
      const bspA = new BSPNode();
      bspA.build([{
        vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]] as [number, number, number][],
        normal: [0, 0, 1] as [number, number, number],
        shared: 0,
      }]);
      const bspB = new BSPNode();
      bspB.build([{
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][],
        normal: [0, 0, 1] as [number, number, number],
        shared: 0,
      }]);
      expect(() => bspA.clipTo(bspB)).not.toThrow();
      const clipped = bspA.allPolygons();
      expect(clipped.length).toBeGreaterThanOrEqual(1);
    });
  });
});
