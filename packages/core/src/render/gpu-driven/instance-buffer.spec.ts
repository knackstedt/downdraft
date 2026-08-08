import { describe, expect, it } from "bun:test";
import { mat4, quat, vec3 } from "wgpu-matrix";
import { INSTANCE_RECORD_BYTES, INSTANCE_RECORD_FLOATS, InstanceBuffer } from "./instance-buffer";

describe("InstanceBuffer", () => {
  it("should compute record size", () => {
    expect(INSTANCE_RECORD_BYTES).toBe(80);
    expect(INSTANCE_RECORD_FLOATS).toBe(20);
  });

  it("should round-trip write/read a record", () => {
    const buf = new InstanceBuffer(4);
    buf.writeInstance(0, {
      pos: vec3.create(1, 2, 3),
      scale: 2,
      rot: { x: 0, y: 0, z: 0, w: 1 },
      aabbMin: vec3.create(-1, -1, -1),
      aabbMax: vec3.create(1, 1, 1),
      meshIdx: 5,
      materialIdx: 7,
      flags: 0x12345678,
    });

    const s = buf.getStaging();
    expect(s[0]).toBe(1);
    expect(s[1]).toBe(2);
    expect(s[2]).toBe(3);
    expect(s[3]).toBe(2);
    expect(s[8]).toBe(-1);
    expect(s[12]).toBe(1);

    const u32 = new Uint32Array(s.buffer);
    expect(u32[16]).toBe(5);
    expect(u32[17]).toBe(7);
    expect(u32[18]).toBe(0x12345678);
  });

  it("writeTransformInstance should derive pos/rot/scale", () => {
    const t = vec3.create(10, 20, 30);
    const r = quat.create(0, 0.7071, 0, 0.7071);
    const s = vec3.create(2, 2, 2);
    const rotMat = mat4.fromQuat(r);
    const transMat = mat4.translation(t);
    const scaleMat = mat4.scaling(s);
    const m = mat4.multiply(mat4.multiply(transMat, rotMat), scaleMat);
    const buf = new InstanceBuffer(1);
    buf.writeTransformInstance(
      0,
      m,
      vec3.create(-1, -1, -1),
      vec3.create(1, 1, 1),
      9,
      11,
      0,
    );

    const st = buf.getStaging();
    expect(st[0]).toBeCloseTo(10);
    expect(st[1]).toBeCloseTo(20);
    expect(st[2]).toBeCloseTo(30);
    expect(st[3]).toBeCloseTo(2);
  });
});
