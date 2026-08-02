import type { GaussianSplatData } from "./parser.ts";
import { parseGaussianSplatFile, parsePLY, parseSplat } from "./parser.ts";
import { filterByDistance, sortSplats } from "./sorter.ts";

describe("Gaussian Splats", () => {
  describe("parsePLY (ascii)", () => {
    it("should parse a minimal ASCII PLY", () => {
      const plyText = `ply
format ascii 1.0
element vertex 2
property float x
property float y
property float z
end_header
0 0 0
1 1 1
`;
      const data = new TextEncoder().encode(plyText);
      const result = parsePLY(data);
      expect(result.count).toBe(2);
      expect(result.splats[0].position).toEqual([0, 0, 0]);
      expect(result.splats[1].position).toEqual([1, 1, 1]);
    });

    it("should handle empty PLY", () => {
      const plyText = `ply
format ascii 1.0
element vertex 0
end_header
`;
      const data = new TextEncoder().encode(plyText);
      const result = parsePLY(data);
      expect(result.count).toBe(0);
    });
  });

  describe("parseSplat", () => {
    it("should parse binary splat data", () => {
      const buf = new ArrayBuffer(32);
      const view = new DataView(buf);
      view.setFloat32(0, 1.0, true);
      view.setFloat32(4, 2.0, true);
      view.setFloat32(8, 3.0, true);
      view.setFloat32(12, 0.0, true);
      view.setFloat32(16, 0.0, true);
      view.setFloat32(20, 0.0, true);
      view.setFloat32(24, 0.0, true);
      view.setFloat32(28, 0.0, true);

      const result = parseSplat(new Uint8Array(buf));
      expect(result.count).toBe(1);
      expect(result.splats[0].position).toEqual([1, 2, 3]);
    });

    it("should handle empty splat data", () => {
      const result = parseSplat(new Uint8Array(0));
      expect(result.count).toBe(0);
    });
  });

  describe("parseGaussianSplatFile", () => {
    it("should dispatch to PLY parser", () => {
      const plyText = `ply
format ascii 1.0
element vertex 1
property float x
property float y
property float z
end_header
5 6 7
`;
      const data = new TextEncoder().encode(plyText);
      const result = parseGaussianSplatFile(data, "ply");
      expect(result.count).toBe(1);
      expect(result.splats[0].position).toEqual([5, 6, 7]);
    });
  });

  describe("sortSplats", () => {
    it("should sort splats by distance from camera (nearest first)", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [10, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [1, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [5, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 3,
        shDegree: 0,
        version: 1,
      };

      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices[0]).toBe(1);
      expect(result.indices[1]).toBe(2);
      expect(result.indices[2]).toBe(0);
    });

    it("should produce correct distance values", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [3, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 1,
        shDegree: 0,
        version: 1,
      };

      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.distances[0]).toBeCloseTo(9, 1);
    });
  });

  describe("filterByDistance", () => {
    it("should filter splats within max distance", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [1, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [10, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [2, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 3,
        shDegree: 0,
        version: 1,
      };

      const visible = filterByDistance(splatData, [0, 0, 0], 5);
      expect(visible.length).toBe(2);
      expect(visible[0]).toBe(0);
      expect(visible[1]).toBe(2);
    });

    it("should return all splats if max distance is large enough", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [1, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [10, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 2,
        shDegree: 0,
        version: 1,
      };

      const visible = filterByDistance(splatData, [0, 0, 0], 100);
      expect(visible.length).toBe(2);
    });

    it("should return empty when max distance is 0", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [1, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 1,
        shDegree: 0,
        version: 1,
      };

      const visible = filterByDistance(splatData, [0, 0, 0], 0);
      expect(visible.length).toBe(0);
    });

    it("should include splat at exactly max distance", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [5, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 1,
        shDegree: 0,
        version: 1,
      };

      const visible = filterByDistance(splatData, [0, 0, 0], 5);
      expect(visible.length).toBe(1);
    });
  });

  describe("sortSplats additional", () => {
    it("should handle single splat", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [1, 2, 3], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 1,
        shDegree: 0,
        version: 1,
      };

      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices[0]).toBe(0);
    });

    it("should handle empty splat data", () => {
      const splatData: GaussianSplatData = {
        splats: [],
        count: 0,
        shDegree: 0,
        version: 1,
      };

      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices.length).toBe(0);
    });

    it("should sort 3D distances correctly", () => {
      const splatData: GaussianSplatData = {
        splats: [
          { position: [0, 0, 5], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [3, 0, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
          { position: [0, 4, 0], scale: [0.1, 0.1, 0.1], rotation: [0, 0, 0, 1], color: [1, 1, 1, 1], opacity: 1 },
        ],
        count: 3,
        shDegree: 0,
        version: 1,
      };

      const result = sortSplats(splatData, [0, 0, 0]);
      const d0 = result.distances[result.indices[0]];
      const d1 = result.distances[result.indices[1]];
      const d2 = result.distances[result.indices[2]];
      expect(d0).toBeLessThanOrEqual(d1);
      expect(d1).toBeLessThanOrEqual(d2);
    });
  });

  describe("parseSplat additional", () => {
    it("should apply exp() to scale values", () => {
      const buf = new ArrayBuffer(32);
      const view = new DataView(buf);
      view.setFloat32(0, 0, true);
      view.setFloat32(4, 0, true);
      view.setFloat32(8, 0, true);
      view.setFloat32(12, Math.log(0.1), true);
      view.setFloat32(16, Math.log(0.2), true);
      view.setFloat32(20, Math.log(0.3), true);
      view.setFloat32(24, 0, true);
      view.setFloat32(28, 0, true);

      const result = parseSplat(new Uint8Array(buf));
      expect(result.splats[0].scale[0]).toBeCloseTo(0.1, 3);
      expect(result.splats[0].scale[1]).toBeCloseTo(0.2, 3);
      expect(result.splats[0].scale[2]).toBeCloseTo(0.3, 3);
    });

    it("should parse multiple splats", () => {
      const buf = new ArrayBuffer(64);
      const view = new DataView(buf);
      for (let i = 0; i < 2; i++) {
        const base = i * 32;
        view.setFloat32(base, i + 1, true);
        view.setFloat32(base + 4, 0, true);
        view.setFloat32(base + 8, 0, true);
      }

      const result = parseSplat(new Uint8Array(buf));
      expect(result.count).toBe(2);
      expect(result.splats[0].position[0]).toBe(1);
      expect(result.splats[1].position[0]).toBe(2);
    });
  });

  describe("parseGaussianSplatFile splat format", () => {
    it("should dispatch to splat parser", () => {
      const buf = new ArrayBuffer(32);
      const view = new DataView(buf);
      view.setFloat32(0, 7, true);
      view.setFloat32(4, 8, true);
      view.setFloat32(8, 9, true);

      const data = new Uint8Array(buf);
      const result = parseGaussianSplatFile(data, "splat");
      expect(result.count).toBe(1);
      expect(result.splats[0].position).toEqual([7, 8, 9]);
    });
  });
});
