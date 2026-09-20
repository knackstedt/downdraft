import {
    arrayOf,
    f32,
    i32,
    mat3x3f,
    mat4x4f,
    u32,
    vec2f,
    vec3f,
    vec4f,
    vec4u,
    wgsl
} from "./wgsl-struct";
import {
    assertWgslStructMatches,
    compareStruct,
    parseWgslStructs,
    wgslTypeFromString,
} from "./wgsl-struct-validator";

// ─── Layout: scalars / vectors / matrices ───────────────────────────────────

describe("WgslType descriptors", () => {
  it("f32: align 4, size 4", () => {
    expect(f32.align).toBe(4);
    expect(f32.size).toBe(4);
    expect(f32.wgsl).toBe("f32");
  });

  it("u32: align 4, size 4, isInt true", () => {
    expect(u32.align).toBe(4);
    expect(u32.size).toBe(4);
    expect(u32.isInt).toBe(true);
  });

  it("vec2f: align 8, size 8", () => {
    expect(vec2f.align).toBe(8);
    expect(vec2f.size).toBe(8);
  });

  it("vec3f: align 16, size 12 (trailing pad to 16 via stride)", () => {
    expect(vec3f.align).toBe(16);
    expect(vec3f.size).toBe(12);
    expect(vec3f.stride).toBe(16);
  });

  it("vec4f: align 16, size 16", () => {
    expect(vec4f.align).toBe(16);
    expect(vec4f.size).toBe(16);
  });

  it("mat4x4f: align 16, size 64, stride 16", () => {
    expect(mat4x4f.align).toBe(16);
    expect(mat4x4f.size).toBe(64);
    expect(mat4x4f.stride).toBe(16);
  });

  it("mat3x3f: align 16, size 48 (3 cols × 16 stride)", () => {
    expect(mat3x3f.align).toBe(16);
    expect(mat3x3f.size).toBe(48);
    expect(mat3x3f.stride).toBe(16);
  });

  it("arrayOf(vec4f, 8): align 16, size 128 (8 × 16)", () => {
    const a = arrayOf(vec4f, 8);
    expect(a.align).toBe(16);
    expect(a.size).toBe(128);
    expect(a.stride).toBe(16);
  });
});

// ─── Struct layout ──────────────────────────────────────────────────────────

describe("wgsl.struct layout", () => {
  it("CameraUniforms (4× mat4x4) = 256 bytes", () => {
    const s = wgsl.struct("CameraUniforms", {
      viewProj: mat4x4f,
      prevViewProj: mat4x4f,
      modelMatrix: mat4x4f,
      prevModelMatrix: mat4x4f,
    });
    expect(s.size).toBe(256);
    expect(s.align).toBe(16);
    expect(s.floatCount).toBe(64);
    expect(s.fieldMap.get("viewProj")!.offset).toBe(0);
    expect(s.fieldMap.get("prevViewProj")!.offset).toBe(64);
    expect(s.fieldMap.get("modelMatrix")!.offset).toBe(128);
    expect(s.fieldMap.get("prevModelMatrix")!.offset).toBe(192);
  });

  it("BoxUniforms (mat4x4 + vec4) = 80 bytes (matches overburden stickman-pass)", () => {
    const s = wgsl.struct("BoxUniforms", {
      viewProj: mat4x4f,
      color: vec4f,
    });
    expect(s.size).toBe(80);
    expect(s.floatCount).toBe(20);
    expect(s.fieldMap.get("viewProj")!.offset).toBe(0);
    expect(s.fieldMap.get("color")!.offset).toBe(64);
  });

  it("BindlessMaterial = 80 bytes (matches material-manager MATERIAL_STRUCT_SIZE)", () => {
    const s = wgsl.struct("BindlessMaterial", {
      baseColor: vec4f,
      roughness: f32,
      metallic: f32,
      emissiveIntensity: f32,
      hasTexTransform: f32,
      albedoTex: u32,
      normalTex: u32,
      metallicRoughnessTex: u32,
      aoEmissiveTex: u32,
      texOffset: vec2f,
      texScale: vec2f,
      texRotation: f32,
      _pad0: f32,
      _pad1: f32,
      _pad2: f32,
    });
    expect(s.size).toBe(80);
    expect(s.floatCount).toBe(20);
    expect(s.fieldMap.get("baseColor")!.offset).toBe(0);
    expect(s.fieldMap.get("roughness")!.offset).toBe(16);
    expect(s.fieldMap.get("albedoTex")!.offset).toBe(32);
    expect(s.fieldMap.get("texOffset")!.offset).toBe(48);
    expect(s.fieldMap.get("texRotation")!.offset).toBe(64);
    expect(s.fieldMap.get("_pad2")!.offset).toBe(76);
  });

  it("vec3 followed by f32 packs into 16 bytes (no extra pad)", () => {
    const s = wgsl.struct("P", {
      pos: vec3f,
      w: f32,
    });
    expect(s.size).toBe(16);
    expect(s.fieldMap.get("pos")!.offset).toBe(0);
    expect(s.fieldMap.get("w")!.offset).toBe(12);
  });

  it("vec3 followed by mat4x4: mat4x4 aligns to 16 (vec3 size 12 + 4 pad)", () => {
    const s = wgsl.struct("P2", {
      pos: vec3f,
      m: mat4x4f,
    });
    expect(s.fieldMap.get("pos")!.offset).toBe(0);
    expect(s.fieldMap.get("m")!.offset).toBe(16); // mat4x4 align 16
    expect(s.size).toBe(80); // 16 + 64
  });

  it("trailing pad to struct align", () => {
    // f32 + vec3: f32@0, vec3@16 (align 16), size 28 → pad to 32
    const s = wgsl.struct("Trail", {
      a: f32,
      b: vec3f,
    });
    expect(s.fieldMap.get("a")!.offset).toBe(0);
    expect(s.fieldMap.get("b")!.offset).toBe(16);
    expect(s.size).toBe(32);
  });

  it("nested struct via field referencing another WgslStruct", () => {
    const inner = wgsl.struct("Inner", { x: f32, y: f32 });
    // Nested struct field via wgsl.ref() — emits `inner: Inner,` and lays out
    // at the inner struct's align/size.
    const outer = wgsl.struct("Outer", {
      flag: u32,
      inner: wgsl.ref(inner),
    });
    // inner align 4, size 8. flag@0, inner@4 (align 4), size 12 → pad to 12 (align 4)
    expect(outer.fieldMap.get("flag")!.offset).toBe(0);
    expect(outer.fieldMap.get("inner")!.offset).toBe(4);
    expect(outer.size).toBe(12);
  });
});

// ─── WGSL emit ──────────────────────────────────────────────────────────────

describe("WgslStruct.wgsl emit", () => {
  it("emits struct declaration with all fields", () => {
    const s = wgsl.struct("CameraUniforms", {
      viewProj: mat4x4f,
      modelMatrix: mat4x4f,
    });
    expect(s.wgsl).toContain("struct CameraUniforms {");
    expect(s.wgsl).toContain("viewProj: mat4x4<f32>,");
    expect(s.wgsl).toContain("modelMatrix: mat4x4<f32>,");
  });

  it("emits u32/i32 types correctly", () => {
    const s = wgsl.struct("U", {
      a: u32,
      b: i32,
      c: vec4u,
    });
    expect(s.wgsl).toContain("a: u32,");
    expect(s.wgsl).toContain("b: i32,");
    expect(s.wgsl).toContain("c: vec4<u32>,");
  });
});

// ─── StructView ─────────────────────────────────────────────────────────────

describe("StructView", () => {
  it("set/get float field at correct offset", () => {
    const s = wgsl.struct("S", { a: f32, b: f32 });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    v.set("a", 1.5);
    v.set("b", 2.5);
    expect(buf[0]).toBe(1.5);
    expect(buf[1]).toBe(2.5);
    expect(v.get("a")[0]).toBe(1.5);
    expect(v.get("b")[0]).toBe(2.5);
  });

  it("set mat4x4 writes 16 floats at offset", () => {
    const s = wgsl.struct("S", { viewProj: mat4x4f, color: vec4f });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    const mat = new Float32Array(16);
    for (let i = 0; i < 16; i++) mat[i] = i;
    v.set("viewProj", mat);
    for (let i = 0; i < 16; i++) expect(buf[i]).toBe(i);
    // color at offset 16 (floats)
    v.set("color", [1, 2, 3, 4]);
    expect(buf[16]).toBe(1);
    expect(buf[19]).toBe(4);
  });

  it("setU32 writes correct bit pattern via Uint32Array view", () => {
    const s = wgsl.struct("S", { flag: u32, val: f32 });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    v.setU32("flag", 0xdeadbeef);
    // Reading the same word as u32 should give the same bit pattern.
    expect(v.getU32("flag")).toBe(0xdeadbeef);
    // The Float32Array slot holds the reinterpreted bits (not a meaningful float).
    expect(buf[0]).not.toBe(0); // bits are non-zero
  });

  it("setU32 for packed handle (arrayIndex<<16 | layerIndex)", () => {
    const s = wgsl.struct("S", { handle: u32 });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    const handle = (3 << 16) | 42; // arrayIndex=3, layerIndex=42
    v.setU32("handle", handle);
    expect(v.getU32("handle")).toBe(handle >>> 0);
  });

  it("throws on unknown field", () => {
    const s = wgsl.struct("S", { a: f32 });
    const v = s.view(new Float32Array(s.floatCount));
    expect(() => v.set("nope" as "a", 1)).toThrow(/unknown field "nope"/);
    expect(() => v.setU32("nope" as "a", 1)).toThrow(/unknown field "nope"/);
  });

  it("throws when buffer too small", () => {
    const s = wgsl.struct("S", { a: mat4x4f });
    expect(() => s.view(new Float32Array(1))).toThrow(/buffer too small/);
  });

  it("zero() clears the struct region", () => {
    const s = wgsl.struct("S", { a: f32, b: f32 });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    v.set("a", 99);
    v.set("b", 88);
    v.zero();
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0);
  });

  it("view is zero-copy over the provided Float32Array", () => {
    const s = wgsl.struct("S", { a: f32 });
    const buf = new Float32Array(s.floatCount);
    const v = s.view(buf);
    v.set("a", 42);
    // Mutating the original buffer is visible through the view and vice versa.
    expect(buf[0]).toBe(42);
    buf[0] = 99;
    expect(v.get("a")[0]).toBe(99);
  });
});

// ─── Validator: parseWgslStructs ────────────────────────────────────────────

describe("parseWgslStructs", () => {
  it("parses a simple struct", () => {
    const src = `
struct Foo {
  a: f32,
  b: vec4<f32>,
}`;
    const parsed = parseWgslStructs(src);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("Foo");
    expect(parsed[0].fields.length).toBe(2);
    expect(parsed[0].fields[0]).toEqual({ name: "a", typeWgsl: "f32" });
    expect(parsed[0].fields[1]).toEqual({ name: "b", typeWgsl: "vec4<f32>" });
  });

  it("parses multiple structs", () => {
    const src = `
struct A { x: f32, }
struct B { y: u32, }
`;
    const parsed = parseWgslStructs(src);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe("A");
    expect(parsed[1].name).toBe("B");
  });

  it("strips field attributes (@location, @builtin)", () => {
    const src = `
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
}`;
    const parsed = parseWgslStructs(src);
    expect(parsed[0].fields[0]).toEqual({ name: "pos", typeWgsl: "vec4<f32>" });
    expect(parsed[0].fields[1]).toEqual({ name: "color", typeWgsl: "vec4<f32>" });
  });

  it("strips line and block comments", () => {
    const src = `
// a comment
struct Foo {
  /* inline */ a: f32,  // trailing
  b: u32,
}`;
    const parsed = parseWgslStructs(src);
    expect(parsed[0].fields.length).toBe(2);
    expect(parsed[0].fields[0]).toEqual({ name: "a", typeWgsl: "f32" });
  });
});

// ─── Validator: wgslTypeFromString ──────────────────────────────────────────

describe("wgslTypeFromString", () => {
  it("scalars", () => {
    expect(wgslTypeFromString("f32").wgsl).toBe("f32");
    expect(wgslTypeFromString("u32").wgsl).toBe("u32");
    expect(wgslTypeFromString("i32").wgsl).toBe("i32");
  });

  it("vectors", () => {
    expect(wgslTypeFromString("vec2<f32>").wgsl).toBe("vec2<f32>");
    expect(wgslTypeFromString("vec3<f32>").wgsl).toBe("vec3<f32>");
    expect(wgslTypeFromString("vec4<u32>").wgsl).toBe("vec4<u32>");
  });

  it("matrices", () => {
    expect(wgslTypeFromString("mat4x4<f32>").wgsl).toBe("mat4x4<f32>");
    expect(wgslTypeFromString("mat3x3<f32>").wgsl).toBe("mat3x3<f32>");
  });

  it("arrays", () => {
    expect(wgslTypeFromString("array<vec4<f32>, 8>").wgsl).toBe("array<vec4<f32>, 8>");
  });

  it("throws on unrecognized", () => {
    expect(() => wgslTypeFromString("wat")).toThrow(/unrecognized/);
  });
});

// ─── Validator: compareStruct + assertWgslStructMatches ─────────────────────

describe("compareStruct", () => {
  it("matches when identical", () => {
    const def = wgsl.struct("S", { a: f32, b: vec4f });
    const parsed = parseWgslStructs("struct S { a: f32, b: vec4<f32>, }")[0];
    const result = compareStruct(parsed, def);
    expect(result.errors).toEqual([]);
  });

  it("detects missing field in wgsl", () => {
    const def = wgsl.struct("S", { a: f32, b: f32 });
    const parsed = parseWgslStructs("struct S { a: f32, }")[0];
    const result = compareStruct(parsed, def);
    expect(result.errors.some((e) => e.includes('"b" missing in wgsl'))).toBe(true);
  });

  it("detects missing field in def", () => {
    const def = wgsl.struct("S", { a: f32 });
    const parsed = parseWgslStructs("struct S { a: f32, b: f32, }")[0];
    const result = compareStruct(parsed, def);
    expect(result.errors.some((e) => e.includes('"b" missing in def'))).toBe(true);
  });

  it("detects type mismatch", () => {
    const def = wgsl.struct("S", { a: f32 });
    const parsed = parseWgslStructs("struct S { a: u32, }")[0];
    const result = compareStruct(parsed, def);
    expect(result.errors.some((e) => e.includes("type wgsl"))).toBe(true);
  });

  it("detects size mismatch from trailing pad", () => {
    // def has vec3 (size 12) → struct size 16 (pad to align 16).
    // wgsl has f32 → struct size 4.
    const def = wgsl.struct("S", { a: vec3f });
    const parsed = parseWgslStructs("struct S { a: f32, }")[0];
    const result = compareStruct(parsed, def);
    expect(result.errors.some((e) => e.includes("struct size"))).toBe(true);
  });
});

describe("assertWgslStructMatches", () => {
  it("passes silently when matching", () => {
    const def = wgsl.struct("S", { a: f32, b: vec4f });
    const src = "struct S { a: f32, b: vec4<f32>, }";
    expect(() => assertWgslStructMatches(src, def)).not.toThrow();
  });

  it("warns (no throw) when struct not found and not strict", () => {
    const def = wgsl.struct("Missing", { a: f32 });
    const src = "struct Other { a: f32, }";
    // Suppress console.warn for this test.
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (msg: string) => warns.push(msg);
    try {
      assertWgslStructMatches(src, def);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => w.includes("not found"))).toBe(true);
  });

  it("throws in strict mode on drift", () => {
    const origStrict = process.env.DOWNDRAFT_STRICT;
    process.env.DOWNDRAFT_STRICT = "1";
    try {
      const def = wgsl.struct("S", { a: f32, b: f32 });
      const src = "struct S { a: f32, }";
      expect(() => assertWgslStructMatches(src, def)).toThrow(/drift/);
    } finally {
      process.env.DOWNDRAFT_STRICT = origStrict;
    }
  });
});
