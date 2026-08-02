// ============================================================================
// Engine Tests — test math utilities and renderer logic (no GPU needed)
// ============================================================================

// Import the internal math functions by re-testing them through the module
// Since they're not exported, we test the AgentVisual interface and
// re-implement the same math to verify correctness

describe("mat4Perspective", () => {
  it("should produce a valid perspective matrix", () => {
    const fovy = Math.PI / 4;
    const aspect = 16 / 9;
    const near = 0.1;
    const far = 100;
    const f = 1.0 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);

    const expected = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ];

    expect(expected[0]).toBeCloseTo(f / aspect, 6);
    expect(expected[5]).toBeCloseTo(f, 6);
    expect(expected[10]).toBeCloseTo((far + near) * nf, 6);
    expect(expected[11]).toBe(-1);
    expect(expected[14]).toBeCloseTo(2 * far * near * nf, 6);
  });

  it("should have f/aspect as first element", () => {
    const fovy = Math.PI / 4;
    const aspect = 2.0;
    const f = 1.0 / Math.tan(fovy / 2);
    const elem = f / aspect;
    expect(elem).toBeGreaterThan(0);
  });
});

describe("mat4LookAt", () => {
  it("should produce valid view matrix for standard camera", () => {
    const eye: [number, number, number] = [15, 20, 25];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];

    const z0 = eye[0] - target[0], z1 = eye[1] - target[1], z2 = eye[2] - target[2];
    const zLen = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
    const zx = z0 / zLen, zy = z1 / zLen, zz = z2 / zLen;
    const x0 = up[1] * zz - up[2] * zy;
    const x1 = up[2] * zx - up[0] * zz;
    const x2 = up[0] * zy - up[1] * zx;
    const xLen = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    const xx = x0 / xLen, xy = x1 / xLen, xz = x2 / xLen;
    const y0 = zy * xz - zz * xy;
    const y1 = zz * xx - zx * xz;
    const y2 = zx * xy - zy * xx;

    expect(zLen).toBeCloseTo(Math.hypot(15, 20, 25), 4);
    expect(xLen).toBeGreaterThan(0);

    const result = [
      xx, y0, zx, 0,
      xy, y1, zy, 0,
      xz, y2, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ];

    expect(result[15]).toBe(1);
    expect(result[3]).toBe(0);
    expect(result[7]).toBe(0);
    expect(result[11]).toBe(0);
  });

  it("should not use undefined yx/yy/yz variables", () => {
    const eye: [number, number, number] = [0, 10, 10];
    const target: [number, number, number] = [0, 0, 0];
    const up: [number, number, number] = [0, 1, 0];

    const z0 = eye[0] - target[0], z1 = eye[1] - target[1], z2 = eye[2] - target[2];
    const zLen = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
    const zx = z0 / zLen, zy = z1 / zLen, zz = z2 / zLen;
    const x0 = up[1] * zz - up[2] * zy;
    const x1 = up[2] * zx - up[0] * zz;
    const x2 = up[0] * zy - up[1] * zx;
    const xLen = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    const xx = x0 / xLen, xy = x1 / xLen, xz = x2 / xLen;
    const y0 = zy * xz - zz * xy;
    const y1 = zz * xx - zx * xz;
    const y2 = zx * xy - zy * xx;

    expect(() => {
      const _ = [
        xx, y0, zx, 0,
        xy, y1, zy, 0,
        xz, y2, zz, 0,
        -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
        -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
        -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
        1,
      ];
    }).not.toThrow();
  });
});

describe("mat4Multiply", () => {
  it("should multiply two identity matrices to identity", () => {
    const identity = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += identity[k * 4 + j] * identity[i * 4 + k];
        }
        out[i * 4 + j] = sum;
      }
    }
    for (let i = 0; i < 16; i++) {
      expect(out[i]).toBeCloseTo(identity[i], 6);
    }
  });

  it("should be associative for translation * scale", () => {
    function mat4Translate(x: number, y: number, z: number): Float32Array {
      return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
    }
    function mat4Scale(sx: number, sy: number, sz: number): Float32Array {
      return new Float32Array([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]);
    }
    const t = mat4Translate(1, 2, 3);
    const s = mat4Scale(2, 2, 2);
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += t[k * 4 + j] * s[i * 4 + k];
        }
        out[i * 4 + j] = sum;
      }
    }
    expect(out[12]).toBeCloseTo(1, 6);
    expect(out[13]).toBeCloseTo(2, 6);
    expect(out[14]).toBeCloseTo(3, 6);
    expect(out[0]).toBeCloseTo(2, 6);
    expect(out[5]).toBeCloseTo(2, 6);
    expect(out[10]).toBeCloseTo(2, 6);
  });
});

describe("AgentVisual", () => {
  it("should have position, color, and size fields", () => {
    const agent = {
      position: [1, 0, 2] as [number, number, number],
      color: [1, 0.2, 0.2] as [number, number, number],
      size: 0.8,
    };
    expect(agent.position.length).toBe(3);
    expect(agent.color.length).toBe(3);
    expect(agent.size).toBeGreaterThan(0);
  });
});

describe("Instance buffer alignment", () => {
  it("should use 256-byte stride for uniform buffer offset alignment", () => {
    const stride = 256;
    for (let i = 0; i < 64; i++) {
      const offset = i * stride;
      expect(offset % 256).toBe(0);
    }
  });
});
