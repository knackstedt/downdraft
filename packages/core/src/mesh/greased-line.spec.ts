import { createGreasedLine, createGreasedLineMeshData, type GreasedLinePoint } from "./greased-line.ts";

describe("GreasedLine", () => {
  describe("createGreasedLine", () => {
    it("should return empty data for < 2 points", () => {
      const points: GreasedLinePoint[] = [{ position: [0, 0, 0] }];
      const line = createGreasedLine(points);
      expect(line.vertexCount).toBe(0);
      expect(line.indexCount).toBe(0);
      expect(line.pointCount).toBe(0);
    });

    it("should generate 2 vertices per point (left + right)", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
        { position: [2, 0, 0] },
      ];
      const line = createGreasedLine(points);
      expect(line.vertexCount).toBe(6);
      expect(line.pointCount).toBe(3);
    });

    it("should generate 6 indices per segment", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points);
      expect(line.indexCount).toBe(6);
    });

    it("should generate 6 indices per segment for N points", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
        { position: [2, 0, 0] },
        { position: [3, 0, 0] },
      ];
      const line = createGreasedLine(points);
      expect(line.indexCount).toBe(18);
    });

    it("should use Uint16Array for small lines", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points);
      expect(line.indices instanceof Uint16Array).toBe(true);
    });

    it("should store sideOffset as -1 and +1 for left/right vertices", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points);
      const leftOffset = line.vertices[3];
      const rightOffset = line.vertices[3 + 12];
      expect(leftOffset).toBe(-1);
      expect(rightOffset).toBe(1);
    });

    it("should apply per-vertex width when enabled", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0], width: 2 },
        { position: [1, 0, 0], width: 4 },
      ];
      const line = createGreasedLine(points, { perVertexWidth: true });
      const w0 = line.vertices[4];
      const w1 = line.vertices[4 + 24];
      expect(w0).toBe(2);
      expect(w1).toBe(4);
    });

    it("should use default width when perVertexWidth is disabled", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0], width: 2 },
        { position: [1, 0, 0], width: 4 },
      ];
      const line = createGreasedLine(points, { width: 3 });
      const w0 = line.vertices[4];
      expect(w0).toBe(3);
    });

    it("should apply per-vertex color when enabled", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0], color: [1, 0, 0, 1] },
        { position: [1, 0, 0], color: [0, 1, 0, 1] },
      ];
      const line = createGreasedLine(points, { perVertexColor: true });
      const r0 = line.vertices[7];
      const r1 = line.vertices[7 + 24];
      expect(r0).toBe(1);
      expect(r1).toBe(0);
    });

    it("should compute dashU when dash is enabled", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points, { dashEnabled: true, dashSize: 1, gapSize: 0.5 });
      const dashU0 = line.vertices[5];
      expect(dashU0).toBe(0);
      const dashU1 = line.vertices[5 + 24];
      expect(dashU1).toBeGreaterThan(0);
    });
  });

  describe("createGreasedLineMeshData", () => {
    it("should produce MeshData with correct stride", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points);
      const meshData = createGreasedLineMeshData(line);
      expect(meshData.layout.stride).toBe(48);
      expect(meshData.vertexCount).toBe(line.vertexCount);
      expect(meshData.indexCount).toBe(line.indexCount);
    });

    it("should have 7 vertex attributes", () => {
      const points: GreasedLinePoint[] = [
        { position: [0, 0, 0] },
        { position: [1, 0, 0] },
      ];
      const line = createGreasedLine(points);
      const meshData = createGreasedLineMeshData(line);
      expect(meshData.layout.attributes.length).toBe(7);
    });
  });
});
