import { describe, expect, it } from "bun:test";

describe("@downdraft/engine/modules/terrain public API", () => {
  it("index exports load", async () => {
    const mod = await import("./index");
    const keys = Object.keys(mod).filter((k) => !k.startsWith("__"));
    expect(keys.length).toBeGreaterThan(0);
  });
});
