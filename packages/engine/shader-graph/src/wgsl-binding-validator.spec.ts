import { describe, expect, it, vi } from "bun:test";
import {
    assertNoDuplicateBindings,
    findDuplicateBindings,
    parseWgslBindings,
    type ParsedBinding,
} from "./wgsl-binding-validator";

describe("parseWgslBindings", () => {
  it("parses a uniform var declaration", () => {
    const src = `@group(0) @binding(0) var<uniform> uniforms: Uniforms;`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      group: 0,
      binding: 0,
      access: "uniform",
      name: "uniforms",
      typeWgsl: "Uniforms",
    });
  });

  it("parses a storage-read var with comma in access modifier", () => {
    const src = `@group(1) @binding(0) var<storage, read> lightData: LightStorage;`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      group: 1,
      binding: 0,
      access: "storage, read",
      name: "lightData",
      typeWgsl: "LightStorage",
    });
  });

  it("parses a storage-read_write var", () => {
    const src = `@group(0) @binding(2) var<storage, read_write> particles: Particle;`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      group: 0,
      binding: 2,
      access: "storage, read_write",
      name: "particles",
      typeWgsl: "Particle",
    });
  });

  it("parses a bare var (no angle brackets) — texture + sampler", () => {
    const src = `
@group(2) @binding(0) var brdfLUT: texture_2d<f32>;
@group(2) @binding(1) var brdfSampler: sampler;
`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toMatchObject({
      group: 2,
      binding: 0,
      access: "",
      name: "brdfLUT",
      typeWgsl: "texture_2d<f32>",
    });
    expect(bindings[1]).toMatchObject({
      group: 2,
      binding: 1,
      access: "",
      name: "brdfSampler",
      typeWgsl: "sampler",
    });
  });

  it("parses multiple bindings from a realistic shader", () => {
    const src = `
struct Uniforms { viewProj: mat4x4<f32>, };
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(1) @binding(0) var<storage, read> lightData: LightStorage;
@group(2) @binding(0) var brdfLUT: texture_2d<f32>;
@group(2) @binding(1) var brdfSampler: sampler;
@group(3) @binding(0) var<storage, read> bindlessMaterials: array<BindlessMaterial>;

fn foo() -> f32 { return 0.0; }
`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(5);
    expect(bindings.map((b) => `${b.group}:${b.binding}`)).toEqual([
      "0:0",
      "1:0",
      "2:0",
      "2:1",
      "3:0",
    ]);
  });

  it("strips line comments before parsing", () => {
    const src = `
// @group(0) @binding(0) var<uniform> commentedOut: Uniforms;
@group(0) @binding(1) var<uniform> real: Uniforms; // trailing comment
`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].name).toBe("real");
    expect(bindings[0].binding).toBe(1);
  });

  it("strips block comments before parsing", () => {
    const src = `
/* @group(0) @binding(0) var<uniform> blockCommented: Uniforms; */
@group(0) @binding(1) var<uniform> real: Uniforms;
`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].name).toBe("real");
  });

  it("returns empty array for source with no bindings", () => {
    const src = `struct Foo { x: f32, };\nfn bar() -> f32 { return 0.0; }`;
    expect(parseWgslBindings(src)).toEqual([]);
  });

  it("tolerates whitespace variations in group/binding attributes", () => {
    const src = `@group( 3 ) @binding( 7 ) var<storage, read> foo: Bar;`;
    const bindings = parseWgslBindings(src);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ group: 3, binding: 7, name: "foo" });
  });
});

describe("findDuplicateBindings", () => {
  it("returns empty when all bindings are unique", () => {
    const bindings: ParsedBinding[] = [
      { group: 0, binding: 0, access: "uniform", name: "a", typeWgsl: "U", raw: "" },
      { group: 1, binding: 0, access: "storage, read", name: "b", typeWgsl: "L", raw: "" },
      { group: 2, binding: 0, access: "", name: "c", typeWgsl: "tex", raw: "" },
    ];
    expect(findDuplicateBindings(bindings)).toEqual([]);
  });

  it("detects a duplicate (group, binding) with same type", () => {
    const bindings: ParsedBinding[] = [
      { group: 2, binding: 0, access: "", name: "brdfLUT", typeWgsl: "texture_2d<f32>", raw: "" },
      { group: 2, binding: 0, access: "", name: "brdfLUT", typeWgsl: "texture_2d<f32>", raw: "" },
    ];
    const dupes = findDuplicateBindings(bindings);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].group).toBe(2);
    expect(dupes[0].binding).toBe(0);
    expect(dupes[0].declarations).toHaveLength(2);
  });

  it("detects a duplicate (group, binding) with different types", () => {
    // The exact bug from the chunk-vs-compiler drift: lightData declared as
    // LightStorage (chunk) and array<vec4<f32>> (compiler).
    const bindings: ParsedBinding[] = [
      { group: 1, binding: 0, access: "storage, read", name: "lightData", typeWgsl: "LightStorage", raw: "" },
      { group: 1, binding: 0, access: "storage, read", name: "lightData", typeWgsl: "array<vec4<f32>>", raw: "" },
    ];
    const dupes = findDuplicateBindings(bindings);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].declarations).toHaveLength(2);
    expect(dupes[0].declarations[0].typeWgsl).toBe("LightStorage");
    expect(dupes[0].declarations[1].typeWgsl).toBe("array<vec4<f32>>");
  });

  it("detects multiple distinct duplicate pairs", () => {
    const bindings: ParsedBinding[] = [
      { group: 1, binding: 0, access: "storage, read", name: "a", typeWgsl: "X", raw: "" },
      { group: 1, binding: 0, access: "storage, read", name: "a", typeWgsl: "Y", raw: "" },
      { group: 2, binding: 0, access: "", name: "b", typeWgsl: "Z", raw: "" },
      { group: 2, binding: 0, access: "", name: "b", typeWgsl: "Z", raw: "" },
      { group: 3, binding: 0, access: "uniform", name: "c", typeWgsl: "U", raw: "" },
    ];
    const dupes = findDuplicateBindings(bindings);
    expect(dupes).toHaveLength(2);
    // Sorted by (group, binding).
    expect(dupes[0].group).toBe(1);
    expect(dupes[1].group).toBe(2);
  });

  it("sorts duplicates by (group, binding) for deterministic output", () => {
    const bindings: ParsedBinding[] = [
      { group: 5, binding: 0, access: "", name: "a", typeWgsl: "X", raw: "" },
      { group: 5, binding: 0, access: "", name: "a", typeWgsl: "X", raw: "" },
      { group: 1, binding: 0, access: "", name: "b", typeWgsl: "Y", raw: "" },
      { group: 1, binding: 0, access: "", name: "b", typeWgsl: "Y", raw: "" },
    ];
    const dupes = findDuplicateBindings(bindings);
    expect(dupes[0].group).toBe(1);
    expect(dupes[1].group).toBe(5);
  });
});

describe("assertNoDuplicateBindings", () => {
  it("does not throw or warn when there are no duplicates", () => {
    // The validator logs through the engine logger, which writes to
    // process.stdout directly (console.warn is never touched).
    const warnSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const src = `
@group(0) @binding(0) var<uniform> a: U;
@group(1) @binding(0) var<storage, read> b: L;
`;
    expect(() => assertNoDuplicateBindings(src)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warns (not throws) in non-strict mode when duplicates exist", () => {
    const warnSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Force non-strict: DOWNDRAFT_STRICT unset and import.meta.env.DEV falsy.
    const origStrict = process.env.DOWNDRAFT_STRICT;
    delete process.env.DOWNDRAFT_STRICT;
    const src = `
@group(1) @binding(0) var<storage, read> lightData: LightStorage;
@group(1) @binding(0) var<storage, read> lightData: array<vec4<f32>>;
`;
    expect(() => assertNoDuplicateBindings(src)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    const warnLine = warnSpy.mock.calls
      .map((c) => String(c[0]).replace(/\x1b\[[0-9;]*m/g, ""))
      .find((s) => s.includes("duplicate"));
    expect(warnLine).toContain("@group(1) @binding(0)");
    warnSpy.mockRestore();
    if (origStrict !== undefined) process.env.DOWNDRAFT_STRICT = origStrict;
  });

  it("throws in DOWNDRAFT_STRICT mode when duplicates exist", () => {
    const origStrict = process.env.DOWNDRAFT_STRICT;
    process.env.DOWNDRAFT_STRICT = "1";
    const src = `
@group(2) @binding(0) var brdfLUT: texture_2d<f32>;
@group(2) @binding(0) var brdfLUT: texture_2d<f32>;
`;
    expect(() => assertNoDuplicateBindings(src)).toThrow(
      /duplicate @group\/@binding var declarations/i,
    );
    if (origStrict === undefined) delete process.env.DOWNDRAFT_STRICT;
    else process.env.DOWNDRAFT_STRICT = origStrict;
  });
});
