import { safeJsonParse, safeJsonParseWithSchema, sanitizeObject } from "./json";

describe("safety/json", () => {
  describe("safeJsonParse", () => {
    it("parses valid JSON", () => {
      expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    });

    it("parses arrays", () => {
      expect(safeJsonParse("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("blocks __proto__ key — no own property", () => {
      const obj = safeJsonParse('{"__proto__":{"polluted":true}}') as any;
      expect(Object.getOwnPropertyDescriptor(obj, "__proto__")).toBeUndefined();
    });

    it("blocks __proto__ key — no prototype pollution", () => {
      safeJsonParse('{"__proto__":{"polluted":true}}');
      expect(({} as any).polluted).toBeUndefined();
    });

    it("blocks constructor key — no own property", () => {
      const obj = safeJsonParse('{"constructor":{"prototype":{"polluted":true}}}') as any;
      expect(Object.getOwnPropertyDescriptor(obj, "constructor")).toBeUndefined();
    });

    it("blocks prototype key", () => {
      const obj = safeJsonParse('{"prototype":{"polluted":true}}') as any;
      expect(obj.prototype).toBeUndefined();
    });

    it("blocks nested __proto__ keys", () => {
      const obj = safeJsonParse('{"a":{"__proto__":{"polluted":true}}}') as any;
      const a = obj.a;
      expect(Object.getOwnPropertyDescriptor(a, "__proto__")).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });

    it("throws on invalid JSON", () => {
      expect(() => safeJsonParse("not json")).toThrow();
    });

    it("preserves normal nested objects", () => {
      const obj = safeJsonParse('{"a":{"b":{"c":1}}}');
      expect(obj).toEqual({ a: { b: { c: 1 } } });
    });
  });

  describe("safeJsonParseWithSchema", () => {
    it("returns parsed value when validation passes", () => {
      const result = safeJsonParseWithSchema('{"x":1}', (obj): obj is { x: number } =>
        typeof obj === "object" && obj !== null && typeof (obj as any).x === "number",
      );
      expect(result).toEqual({ x: 1 });
    });

    it("returns null when validation fails", () => {
      const result = safeJsonParseWithSchema('{"x":"not a number"}', (obj): obj is { x: number } =>
        typeof obj === "object" && obj !== null && typeof (obj as any).x === "number",
      );
      expect(result).toBeNull();
    });

    it("returns null on parse error", () => {
      const result = safeJsonParseWithSchema("invalid", () => true);
      expect(result).toBeNull();
    });
  });

  describe("sanitizeObject", () => {
    it("removes __proto__ own property from objects", () => {
      const obj = Object.assign(Object.create(null), { a: 1, __proto__: { polluted: true } });
      sanitizeObject(obj);
      expect(Object.getOwnPropertyDescriptor(obj, "__proto__")).toBeUndefined();
    });

    it("handles nested objects", () => {
      const inner = Object.assign(Object.create(null), { __proto__: { bad: true } });
      const obj = { nested: inner };
      sanitizeObject(obj);
      expect(Object.getOwnPropertyDescriptor(inner, "__proto__")).toBeUndefined();
    });

    it("handles arrays", () => {
      const item = Object.assign(Object.create(null), { __proto__: { bad: true } });
      const arr = [item];
      sanitizeObject(arr);
      expect(Object.getOwnPropertyDescriptor(item, "__proto__")).toBeUndefined();
    });

    it("passes through primitives", () => {
      expect(sanitizeObject(42)).toBe(42);
      expect(sanitizeObject("hello")).toBe("hello");
      expect(sanitizeObject(null)).toBeNull();
    });
  });
});
