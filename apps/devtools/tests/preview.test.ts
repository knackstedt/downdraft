import { describe, test, expect } from "bun:test";
import { previewRemote, remoteKind } from "../src/targets/preview";

describe("previewRemote", () => {
  test("primitives", () => {
    expect(previewRemote({ type: "number", value: 42 })).toBe("42");
    expect(previewRemote({ type: "bigint", value: "123" })).toBe("123n");
    expect(previewRemote({ type: "boolean", value: false })).toBe("false");
    expect(previewRemote({ type: "undefined" })).toBe("undefined");
    expect(previewRemote(undefined)).toBe("undefined");
  });

  test("unserializableValue wins (NaN, Infinity)", () => {
    expect(previewRemote({ type: "number", unserializableValue: "NaN" })).toBe("NaN");
  });

  test("top-level strings are quoted, nested strings bare", () => {
    expect(previewRemote({ type: "string", value: "hi" })).toBe('"hi"');
    expect(previewRemote({ type: "string", value: "hi" }, 1)).toBe("hi");
  });

  test("functions collapse to ƒ name()", () => {
    expect(previewRemote({ type: "function", description: "function doThing(a, b) {}" })).toBe("ƒ doThing()");
  });

  test("object subtypes use descriptions", () => {
    expect(previewRemote({ type: "object", subtype: "null" })).toBe("null");
    expect(previewRemote({ type: "object", subtype: "array", description: "Array(3)" })).toBe("Array(3)");
    expect(previewRemote({ type: "object", subtype: "map", description: "Map(2)" })).toBe("Map(2)");
  });

  test("plain objects render CDP preview properties", () => {
    const s = previewRemote({
      type: "object", className: "Point",
      previewProps: [
        { name: "x", type: "number", value: 1 },
        { name: "label", type: "string", value: "p" },
      ],
    });
    expect(s).toBe('Point {x: 1, label: "p"}');
  });

  test("objects over 5 preview props get an ellipsis", () => {
    const s = previewRemote({
      type: "object",
      previewProps: [0, 1, 2, 3, 4, 5].map((i) => ({ name: `k${i}`, type: "number", value: i })),
    });
    expect(s).toContain("…");
  });
});

describe("remoteKind", () => {
  test("maps types to display kinds", () => {
    expect(remoteKind({ type: "number", value: 1 })).toBe("num");
    expect(remoteKind({ type: "string", value: "x" })).toBe("str");
    expect(remoteKind({ type: "function" })).toBe("fn");
    expect(remoteKind({ type: "undefined" })).toBe("kw");
    expect(remoteKind({ type: "object" })).toBe("obj");
    expect(remoteKind({ type: "object", subtype: "error" })).toBe("err");
  });
});
