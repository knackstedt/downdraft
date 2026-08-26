import { describe, expect, it } from "bun:test";
import { parseOBJ } from "./obj";

function encode(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer as ArrayBuffer;
}

describe("parseOBJ index bounds validation", () => {
  it("parses valid OBJ with faces", () => {
    const obj = [
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "vn 0 0 1",
      "vt 0 0",
      "f 1/1/1 2/1/1 3/1/1",
    ].join("\n");
    const model = parseOBJ(encode(obj), "test");
    expect(model.meshes.length).toBeGreaterThan(0);
  });

  it("throws on out-of-bounds vertex index", () => {
    const obj = [
      "v 0 0 0",
      "v 1 0 0",
      "f 1 2 99",
    ].join("\n");
    expect(() => parseOBJ(encode(obj), "test")).toThrow(RangeError);
  });

  it("throws on out-of-bounds normal index", () => {
    const obj = [
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "vn 0 0 1",
      "f 1//1 2//1 3//99",
    ].join("\n");
    expect(() => parseOBJ(encode(obj), "test")).toThrow(RangeError);
  });

  it("throws on out-of-bounds uv index", () => {
    const obj = [
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "vt 0 0",
      "f 1/1 2/1 3/99",
    ].join("\n");
    expect(() => parseOBJ(encode(obj), "test")).toThrow(RangeError);
  });

  it("handles faces without normals/uvs gracefully", () => {
    const obj = [
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
    ].join("\n");
    expect(() => parseOBJ(encode(obj), "test")).not.toThrow();
  });
});
