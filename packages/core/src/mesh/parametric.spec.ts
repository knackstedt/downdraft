import { cylinder, cone, torus, disc, ribbon, tube, lathe, tessellatedPlane, type TubePathPoint } from "./parametric";

describe("Parametric Shapes", () => {
  describe("cylinder", () => {
    it("should generate correct side vertex count", () => {
      const mesh = cylinder(0.5, 0.5, 1, 16, 1);
      const sideVerts = (1 + 1) * (16 + 1);
      expect(mesh.vertexCount).toBeGreaterThanOrEqual(sideVerts);
    });

    it("should generate side + cap vertices when both radii > 0", () => {
      const mesh = cylinder(0.5, 0.5, 1, 16, 1);
      const sideVerts = (1 + 1) * (16 + 1);
      const bottomCap = (16 + 1) + 1;
      const topCap = (16 + 1) + 1;
      expect(mesh.vertexCount).toBe(sideVerts + bottomCap + topCap);
    });

    it("should not generate bottom cap when radiusBottom is 0", () => {
      const mesh = cylinder(0.5, 0, 1, 8, 1);
      const sideVerts = (1 + 1) * (8 + 1);
      const topCap = (8 + 1) + 1;
      expect(mesh.vertexCount).toBe(sideVerts + topCap);
    });

    it("should produce valid indices", () => {
      const mesh = cylinder(1, 1, 2, 8, 2);
      expect(mesh.indexCount).toBeGreaterThan(0);
      expect(mesh.indices.length).toBe(mesh.indexCount);
    });
  });

  describe("cone", () => {
    it("should produce fewer vertices than equivalent cylinder (no top cap)", () => {
      const coneMesh = cone(0.5, 1, 8);
      const cylMesh = cylinder(0.5, 0.5, 1, 8, 1);
      expect(coneMesh.vertexCount).toBeLessThan(cylMesh.vertexCount);
    });

    it("should have valid indices", () => {
      const mesh = cone(0.5, 1, 8);
      expect(mesh.indexCount).toBeGreaterThan(0);
    });
  });

  describe("torus", () => {
    it("should generate (radialSegments+1) * (tubularSegments+1) vertices", () => {
      const mesh = torus(0.5, 0.15, 16, 32);
      expect(mesh.vertexCount).toBe((16 + 1) * (32 + 1));
    });

    it("should generate radialSegments * tubularSegments * 6 indices", () => {
      const mesh = torus(0.5, 0.15, 16, 32);
      expect(mesh.indexCount).toBe(16 * 32 * 6);
    });
  });

  describe("disc", () => {
    it("should generate center + tessellation+1 vertices for single side", () => {
      const mesh = disc(0.5, 16, "top");
      expect(mesh.vertexCount).toBe(1 + 17);
    });

    it("should generate double vertices for double side", () => {
      const mesh = disc(0.5, 16, "double");
      expect(mesh.vertexCount).toBe(2 * (1 + 17));
    });

    it("should produce valid triangle indices", () => {
      const mesh = disc(0.5, 8, "top");
      expect(mesh.indexCount).toBe(8 * 3);
    });
  });

  describe("ribbon", () => {
    it("should generate pathCount * pointCount vertices", () => {
      const paths: [number, number, number][][] = [
        [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
        [[0, 1, 0], [1, 1, 0], [2, 1, 0]],
      ];
      const mesh = ribbon(paths);
      expect(mesh.vertexCount).toBe(2 * 3);
    });

    it("should generate (pathCount-1) * (pointCount-1) * 6 indices", () => {
      const paths: [number, number, number][][] = [
        [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
        [[0, 1, 0], [1, 1, 0], [2, 1, 0]],
      ];
      const mesh = ribbon(paths);
      expect(mesh.indexCount).toBe(1 * 2 * 6);
    });
  });

  describe("tube", () => {
    it("should return empty mesh for < 2 path points", () => {
      const mesh = tube([{ position: [0, 0, 0] }], 0.1, 8);
      expect(mesh.vertexCount).toBe(0);
      expect(mesh.indexCount).toBe(0);
    });

    it("should generate segments * (tessellation+1) side vertices", () => {
      const path: TubePathPoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
        { position: [2, 0, 0] },
      ];
      const mesh = tube(path, 0.1, 8, false);
      expect(mesh.vertexCount).toBe(3 * 9);
    });

    it("should add cap vertices when cap=true", () => {
      const path: TubePathPoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const withoutCaps = tube(path, 0.1, 8, false);
      const withCaps = tube(path, 0.1, 8, true);
      expect(withCaps.vertexCount).toBeGreaterThan(withoutCaps.vertexCount);
    });
  });

  describe("lathe", () => {
    it("should generate (segments+1) * pointCount vertices", () => {
      const points: [number, number][] = [[0, 0], [0.5, 0.5], [0, 1]];
      const mesh = lathe(points, 16, 1);
      expect(mesh.vertexCount).toBe((16 + 1) * 3);
    });

    it("should generate segments * (pointCount-1) * 6 indices", () => {
      const points: [number, number][] = [[0, 0], [0.5, 0.5], [0, 1]];
      const mesh = lathe(points, 16, 1);
      expect(mesh.indexCount).toBe(16 * 2 * 6);
    });
  });

  describe("tessellatedPlane", () => {
    it("should generate (subdivX+1) * (subdivY+1) vertices", () => {
      const mesh = tessellatedPlane(2, 2, 4, 4);
      expect(mesh.vertexCount).toBe(5 * 5);
    });

    it("should generate subdivX * subdivY * 6 indices", () => {
      const mesh = tessellatedPlane(2, 2, 4, 4);
      expect(mesh.indexCount).toBe(4 * 4 * 6);
    });

    it("should match existing plane for 1x1 subdivision", () => {
      const mesh = tessellatedPlane(2, 2, 1, 1);
      expect(mesh.vertexCount).toBe(4);
      expect(mesh.indexCount).toBe(6);
    });
  });
});
