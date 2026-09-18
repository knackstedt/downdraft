// Tests for the MaterialRegistry (mod-defined material shaders).

import { MaterialRegistry } from "./material-registry";

describe("MaterialRegistry", () => {
  it("registers and retrieves a material", () => {
    const reg = new MaterialRegistry();
    reg.register({
      id: "mod:iridescent",
      wgsl: "// iridescent shader",
      manifestId: "my-mod",
      uniforms: 64,
      props: { metallic: 0.9 },
    });
    expect(reg.has("mod:iridescent")).toBe(true);
    const m = reg.get("mod:iridescent");
    expect(m?.wgsl).toBe("// iridescent shader");
    expect(m?.manifestId).toBe("my-mod");
    expect(m?.uniforms).toBe(64);
    expect(m?.props.metallic).toBe(0.9);
  });

  it("throws on duplicate registration", () => {
    const reg = new MaterialRegistry();
    reg.register({ id: "mod:x", wgsl: "", manifestId: "m", props: {} });
    expect(() =>
      reg.register({ id: "mod:x", wgsl: "", manifestId: "m", props: {} }),
    ).toThrow("already registered");
  });

  it("unregisters a material", () => {
    const reg = new MaterialRegistry();
    reg.register({ id: "mod:x", wgsl: "", manifestId: "m", props: {} });
    reg.unregister("mod:x");
    expect(reg.has("mod:x")).toBe(false);
    expect(reg.get("mod:x")).toBeUndefined();
  });

  it("lists all registered ids", () => {
    const reg = new MaterialRegistry();
    reg.register({ id: "mod:a", wgsl: "", manifestId: "m", props: {} });
    reg.register({ id: "mod:b", wgsl: "", manifestId: "m", props: {} });
    expect(reg.ids().sort()).toEqual(["mod:a", "mod:b"]);
  });

  it("clears all materials", () => {
    const reg = new MaterialRegistry();
    reg.register({ id: "mod:a", wgsl: "", manifestId: "m", props: {} });
    reg.register({ id: "mod:b", wgsl: "", manifestId: "m", props: {} });
    reg.clear();
    expect(reg.ids()).toEqual([]);
  });

  it("returns undefined for unregistered id", () => {
    const reg = new MaterialRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
    expect(reg.has("nonexistent")).toBe(false);
  });
});
