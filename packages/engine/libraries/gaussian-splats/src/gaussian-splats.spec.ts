import type { GaussianSplatData } from "./parser";
import { getSplat, parseGaussianSplatFile, parsePLY, parseSplat, SH_REST_COEFFS_PER_DEGREE } from "./parser";
import { filterByDistance, sortSplats } from "./sorter";

/** Build a small SoA GaussianSplatData from tuple splats (test helper). */
function makeSplatData(
  splats: Array<{ position: [number, number, number]; scale?: [number, number, number]; rotation?: [number, number, number, number]; color?: [number, number, number, number]; opacity?: number }>,
  shDegree = 0,
): GaussianSplatData {
  const count = splats.length;
  const restCoeffs = SH_REST_COEFFS_PER_DEGREE[shDegree] ?? 0;
  const data: GaussianSplatData = {
    count,
    shDegree,
    version: 1,
    position: new Float32Array(count * 3),
    scale: new Float32Array(count * 3),
    rotation: new Float32Array(count * 4),
    color: new Float32Array(count * 4),
    shCoeffs: restCoeffs > 0 ? new Float32Array(count * restCoeffs) : new Float32Array(0),
  };
  for (let i = 0; i < count; i++) {
    const s = splats[i];
    const i3 = i * 3;
    const i4 = i * 4;
    data.position[i3] = s.position[0];
    data.position[i3 + 1] = s.position[1];
    data.position[i3 + 2] = s.position[2];
    const sc = s.scale ?? [0.1, 0.1, 0.1];
    data.scale[i3] = sc[0];
    data.scale[i3 + 1] = sc[1];
    data.scale[i3 + 2] = sc[2];
    const r = s.rotation ?? [0, 0, 0, 1];
    data.rotation[i4] = r[0];
    data.rotation[i4 + 1] = r[1];
    data.rotation[i4 + 2] = r[2];
    data.rotation[i4 + 3] = r[3];
    const c = s.color ?? [1, 1, 1, 1];
    const o = s.opacity ?? 1;
    data.color[i4] = c[0];
    data.color[i4 + 1] = c[1];
    data.color[i4 + 2] = c[2];
    data.color[i4 + 3] = c[3] * o;
  }
  return data;
}

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
      expect(result.position[0]).toBe(0);
      expect(result.position[3]).toBe(1);
      expect(result.shDegree).toBe(0);
      expect(result.shCoeffs.length).toBe(0);
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

    it("should parse full INRIA fields (ascii) with SH degree 3", () => {
      // 1 vertex with x,y,z, scale_0..2, rot_0..3, f_dc_0..2, opacity, f_rest_0..44
      const props = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"];
      for (let i = 0; i < 45; i++) props.push(`f_rest_${i}`);
      const header = `ply\nformat ascii 1.0\nelement vertex 1\n` + props.map((p) => `property float ${p}`).join("\n") + "\nend_header\n";
      const values = [1, 2, 3, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0.5, 5];
      for (let i = 0; i < 45; i++) values.push(i * 0.01);
      const plyText = header + values.join(" ") + "\n";
      const data = new TextEncoder().encode(plyText);
      const result = parsePLY(data);

      expect(result.count).toBe(1);
      expect(result.shDegree).toBe(3);
      expect(result.shCoeffs.length).toBe(45);

      // Position
      expect(result.position[0]).toBe(1);
      expect(result.position[1]).toBe(2);
      expect(result.position[2]).toBe(3);

      // Scale exp-transform
      expect(result.scale[0]).toBeCloseTo(1, 5); // exp(0) = 1

      // Rotation normalized (already unit: w=1,x=y=z=0)
      expect(result.rotation[0]).toBeCloseTo(1, 5);

      // DC color: 0.5 + 0.5 * SH_C0
      expect(result.color[0]).toBeCloseTo(0.5 + 0.5 * 0.28209479177387814, 4);
      // Opacity sigmoid: 1/(1+exp(-5)) ≈ 0.9933
      expect(result.color[3]).toBeCloseTo(1 / (1 + Math.exp(-5)), 3);

      // SH coeffs
      expect(result.shCoeffs[0]).toBeCloseTo(0, 5);
      expect(result.shCoeffs[1]).toBeCloseTo(0.01, 5);
    });
  });

  describe("parsePLY (binary_little_endian)", () => {
    it("should parse full INRIA fields with correct transforms", () => {
      // Build a binary PLY with 2 vertices, full INRIA fields (no f_rest → deg 0)
      const props = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"];
      const header = `ply\nformat binary_little_endian 1.0\nelement vertex 2\n` + props.map((p) => `property float ${p}`).join("\n") + "\nend_header\n";
      const headerBytes = new TextEncoder().encode(header);
      const stride = props.length * 4; // 14 * 4 = 56 bytes/vertex

      const body = new ArrayBuffer(2 * stride);
      const view = new DataView(body);
      // Vertex 0: pos(1,2,3), scale(log(0.1),...), rot(1,0,0,0), f_dc(0,0,0), opacity(0)
      const log01 = Math.log(0.1);
      const v0 = [1, 2, 3, log01, log01, log01, 1, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 14; i++) view.setFloat32(i * 4, v0[i], true);
      // Vertex 1: pos(4,5,6), scale(0,0,0→exp=1), rot(0,1,0,0), f_dc(1,1,1), opacity(100→sigmoid≈1)
      const v1 = [4, 5, 6, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 100];
      for (let i = 0; i < 14; i++) view.setFloat32(stride + i * 4, v1[i], true);

      const data = new Uint8Array(headerBytes.length + body.byteLength);
      data.set(headerBytes, 0);
      data.set(new Uint8Array(body), headerBytes.length);

      const result = parsePLY(data);
      expect(result.count).toBe(2);
      expect(result.shDegree).toBe(0);

      // Vertex 0
      expect(result.position[0]).toBe(1);
      expect(result.position[1]).toBe(2);
      expect(result.position[2]).toBe(3);
      expect(result.scale[0]).toBeCloseTo(0.1, 3);
      expect(result.rotation[0]).toBeCloseTo(1, 5); // w
      expect(result.color[0]).toBeCloseTo(0.5, 4); // 0.5 + 0 * SH_C0
      expect(result.color[3]).toBeCloseTo(0.5, 4); // sigmoid(0) = 0.5

      // Vertex 1
      expect(result.position[3]).toBe(4);
      expect(result.scale[3]).toBeCloseTo(1, 5); // exp(0) = 1
      expect(result.rotation[4]).toBeCloseTo(0, 5); // w=0
      expect(result.rotation[5]).toBeCloseTo(1, 5); // x=1
      expect(result.color[4]).toBeCloseTo(0.5 + 1 * 0.28209479177387814, 4);
      expect(result.color[7]).toBeCloseTo(1, 5); // sigmoid(100) ≈ 1
    });

    it("should detect SH degree 1 from 9 f_rest properties", () => {
      const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"];
      for (let i = 0; i < 9; i++) props.push(`f_rest_${i}`);
      const header = `ply\nformat binary_little_endian 1.0\nelement vertex 1\n` + props.map((p) => `property float ${p}`).join("\n") + "\nend_header\n";
      const headerBytes = new TextEncoder().encode(header);
      const stride = props.length * 4;
      const body = new ArrayBuffer(stride);
      const view = new DataView(body);
      for (let i = 0; i < props.length; i++) view.setFloat32(i * 4, 0, true);
      const data = new Uint8Array(headerBytes.length + body.byteLength);
      data.set(headerBytes, 0);
      data.set(new Uint8Array(body), headerBytes.length);

      const result = parsePLY(data);
      expect(result.shDegree).toBe(1);
      expect(result.shCoeffs.length).toBe(9); // 1 splat * 9 coeffs
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
      view.setUint8(24, 255);
      view.setUint8(25, 128);
      view.setUint8(26, 0);
      view.setUint8(27, 255);
      view.setUint8(28, 128);
      view.setUint8(29, 128);
      view.setUint8(30, 128);
      view.setUint8(31, 128);

      const result = parseSplat(new Uint8Array(buf));
      expect(result.count).toBe(1);
      expect(result.position[0]).toBe(1);
      expect(result.position[1]).toBe(2);
      expect(result.position[2]).toBe(3);
      expect(result.color[0]).toBeCloseTo(1, 2); // 255/255
      expect(result.color[1]).toBeCloseTo(128 / 255, 2);
    });

    it("should handle empty splat data", () => {
      const result = parseSplat(new Uint8Array(0));
      expect(result.count).toBe(0);
    });

    it("should apply exp() to scale values", () => {
      const buf = new ArrayBuffer(32);
      const view = new DataView(buf);
      view.setFloat32(0, 0, true);
      view.setFloat32(4, 0, true);
      view.setFloat32(8, 0, true);
      view.setFloat32(12, Math.log(0.1), true);
      view.setFloat32(16, Math.log(0.2), true);
      view.setFloat32(20, Math.log(0.3), true);
      view.setFloat32(24, 0);
      view.setFloat32(28, 0);

      const result = parseSplat(new Uint8Array(buf));
      expect(result.scale[0]).toBeCloseTo(0.1, 3);
      expect(result.scale[1]).toBeCloseTo(0.2, 3);
      expect(result.scale[2]).toBeCloseTo(0.3, 3);
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
      expect(result.position[0]).toBe(1);
      expect(result.position[3]).toBe(2);
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
      expect(result.position[0]).toBe(5);
      expect(result.position[1]).toBe(6);
      expect(result.position[2]).toBe(7);
    });

    it("should dispatch to splat parser", () => {
      const buf = new ArrayBuffer(32);
      const view = new DataView(buf);
      view.setFloat32(0, 7, true);
      view.setFloat32(4, 8, true);
      view.setFloat32(8, 9, true);

      const data = new Uint8Array(buf);
      const result = parseGaussianSplatFile(data, "splat");
      expect(result.count).toBe(1);
      expect(result.position[0]).toBe(7);
      expect(result.position[1]).toBe(8);
      expect(result.position[2]).toBe(9);
    });
  });

  describe("getSplat (escape hatch)", () => {
    it("should extract a single splat as a tuple", () => {
      const data = makeSplatData([
        { position: [1, 2, 3], scale: [0.1, 0.2, 0.3], rotation: [1, 0, 0, 0], color: [1, 0, 0, 0.5], opacity: 1 },
      ]);
      const s = getSplat(data, 0);
      expect(s.position).toEqual([1, 2, 3]);
      expect(s.scale[0]).toBeCloseTo(0.1, 5);
      expect(s.scale[1]).toBeCloseTo(0.2, 5);
      expect(s.scale[2]).toBeCloseTo(0.3, 5);
      expect(s.rotation).toEqual([1, 0, 0, 0]);
      expect(s.color).toEqual([1, 0, 0, 0.5]);
      expect(s.opacity).toBe(0.5);
    });
  });

  describe("sortSplats", () => {
    it("should sort splats by distance from camera (nearest first)", () => {
      const splatData = makeSplatData([
        { position: [10, 0, 0] },
        { position: [1, 0, 0] },
        { position: [5, 0, 0] },
      ]);

      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices[0]).toBe(1);
      expect(result.indices[1]).toBe(2);
      expect(result.indices[2]).toBe(0);
    });

    it("should produce correct distance values", () => {
      const splatData = makeSplatData([{ position: [3, 0, 0] }]);
      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.distances[0]).toBeCloseTo(9, 1);
    });

    it("should handle single splat", () => {
      const splatData = makeSplatData([{ position: [1, 2, 3] }]);
      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices[0]).toBe(0);
    });

    it("should handle empty splat data", () => {
      const splatData = makeSplatData([]);
      const result = sortSplats(splatData, [0, 0, 0]);
      expect(result.indices.length).toBe(0);
    });

    it("should sort 3D distances correctly", () => {
      const splatData = makeSplatData([
        { position: [0, 0, 5] },
        { position: [3, 0, 0] },
        { position: [0, 4, 0] },
      ]);

      const result = sortSplats(splatData, [0, 0, 0]);
      const d0 = result.distances[result.indices[0]];
      const d1 = result.distances[result.indices[1]];
      const d2 = result.distances[result.indices[2]];
      expect(d0).toBeLessThanOrEqual(d1);
      expect(d1).toBeLessThanOrEqual(d2);
    });
  });

  describe("filterByDistance", () => {
    it("should filter splats within max distance", () => {
      const splatData = makeSplatData([
        { position: [1, 0, 0] },
        { position: [10, 0, 0] },
        { position: [2, 0, 0] },
      ]);

      const visible = filterByDistance(splatData, [0, 0, 0], 5);
      expect(visible.length).toBe(2);
      expect(visible[0]).toBe(0);
      expect(visible[1]).toBe(2);
    });

    it("should return all splats if max distance is large enough", () => {
      const splatData = makeSplatData([
        { position: [1, 0, 0] },
        { position: [10, 0, 0] },
      ]);
      const visible = filterByDistance(splatData, [0, 0, 0], 100);
      expect(visible.length).toBe(2);
    });

    it("should return empty when max distance is 0", () => {
      const splatData = makeSplatData([{ position: [1, 0, 0] }]);
      const visible = filterByDistance(splatData, [0, 0, 0], 0);
      expect(visible.length).toBe(0);
    });

    it("should include splat at exactly max distance", () => {
      const splatData = makeSplatData([{ position: [5, 0, 0] }]);
      const visible = filterByDistance(splatData, [0, 0, 0], 5);
      expect(visible.length).toBe(1);
    });
  });
});
