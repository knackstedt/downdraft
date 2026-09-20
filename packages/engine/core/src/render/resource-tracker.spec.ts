import { destroyAll, destroyMapValues, destroyAndNull } from "./resource-tracker";

describe("render/resource-tracker", () => {
  function makeMock(): { destroy: () => void; destroyed: boolean } {
    return {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
  }

  describe("destroyAll", () => {
    it("destroys all non-null resources", () => {
      const a = makeMock();
      const b = makeMock();
      destroyAll([a, b, null, undefined]);
      expect(a.destroyed).toBe(true);
      expect(b.destroyed).toBe(true);
    });

    it("skips null and undefined", () => {
      expect(() => destroyAll([null, undefined, null])).not.toThrow();
    });

    it("swallows errors from individual destroy calls", () => {
      const bad = { destroy: () => { throw new Error("already destroyed"); } };
      const good = makeMock();
      expect(() => destroyAll([bad, good])).not.toThrow();
      expect(good.destroyed).toBe(true);
    });
  });

  describe("destroyMapValues", () => {
    it("destroys all map values and clears", () => {
      const a = makeMock();
      const b = makeMock();
      const map = new Map([["a", a], ["b", b]]);
      destroyMapValues(map);
      expect(a.destroyed).toBe(true);
      expect(b.destroyed).toBe(true);
      expect(map.size).toBe(0);
    });

    it("handles maps with non-destroyable values", () => {
      const map = new Map<string, unknown>([["n", 42], ["s", "hello"]]);
      expect(() => destroyMapValues(map)).not.toThrow();
      expect(map.size).toBe(0);
    });

    it("handles empty maps", () => {
      const map = new Map<string, unknown>();
      expect(() => destroyMapValues(map)).not.toThrow();
    });
  });

  describe("destroyAndNull", () => {
    it("destroys resource and sets to null", () => {
      const res = makeMock();
      let holder: typeof res | null = res;
      destroyAndNull(() => holder, (v) => { holder = v; });
      expect(res.destroyed).toBe(true);
      expect(holder).toBeNull();
    });

    it("handles already-null resources", () => {
      let holder: { destroy(): void } | null = null;
      destroyAndNull(() => holder, (v) => { holder = v; });
      expect(holder).toBeNull();
    });
  });
});
