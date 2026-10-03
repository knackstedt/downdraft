import { describe, expect, it } from "bun:test";
import { transpileKernel, wgslF32 } from "./transpile";

const BASE = { output: [16, 16] as [number, number], outputStride: 1, workgroupSize: [8, 8, 1] as [number, number, number] };

describe("transpileKernel", () => {
  it("emits bindings for array + scalar args and a result buffer", () => {
    const r = transpileKernel(
      `function (a, scale) { return a[this.thread.x] * scale; }`,
      { ...BASE, argKinds: ["array", "scalar"] },
    );
    expect(r.wgsl).toContain("@group(0) @binding(0) var<storage, read> a: array<f32>;");
    expect(r.wgsl).toContain("@group(0) @binding(1) var<storage, read> scalars: array<f32>;");
    expect(r.wgsl).toContain("@group(0) @binding(2) var<storage, read_write> result: array<f32>;");
    expect(r.wgsl).toContain("var scale = scalars[0u];");
    expect(r.bindings).toHaveLength(1);
    expect(r.resultBinding).toBe(2);
  });

  it("guards dispatch against out-of-range gids and flattens the index", () => {
    const r = transpileKernel(`function () { return 1; }`, { ...BASE, argKinds: [] });
    expect(r.wgsl).toContain("if (gid.x >= OUT_X || gid.y >= OUT_Y || gid.z >= OUT_Z) { return; }");
    expect(r.wgsl).toContain("let idx = (gid.z * OUT_Y + gid.y) * OUT_X + gid.x;");
  });

  it("maps this.thread/this.output/this.constants", () => {
    const r = transpileKernel(
      `function (a) { return a[this.thread.x] + this.thread.y * this.output.x + this.constants.K; }`,
      { ...BASE, argKinds: ["array"], constants: { K: 2.5 } },
    );
    expect(r.wgsl).toContain("const CONST_K: f32 = 2.5;");
    expect(r.wgsl).toContain("gid.x");
    expect(r.wgsl).toContain("gid.y");
    expect(r.wgsl).toContain("OUT_X");
  });

  it("emits arg.length as arrayLength", () => {
    const r = transpileKernel(
      `function (a) { let n = 0; for (let i = 0; i < a.length; i++) { n += a[i]; } return n; }`,
      { ...BASE, argKinds: ["array"] },
    );
    expect(r.wgsl).toContain("arrayLength(&a)");
    expect(r.wgsl).toContain("for (var i = 0;");
  });

  it("supports ternary, bitwise ops, and Math helpers", () => {
    const r = transpileKernel(
      `function (a) { const v = a[this.thread.x]; return v > 0.5 ? Math.floor(v * 4.0) : (v | 0); }`,
      { ...BASE, argKinds: ["array"] },
    );
    expect(r.wgsl).toContain("select(");
    expect(r.wgsl).toContain("floor(");
    expect(r.wgsl).toContain("i32(");
  });

  it("emits vecN returns for outputStride > 1", () => {
    const r = transpileKernel(
      `function (a) { const i = this.thread.x; return [a[i], a[i] * 2.0]; }`,
      { ...BASE, argKinds: ["array"], outputStride: 2 },
    );
    expect(r.wgsl).toContain("-> vec2<f32>");
    expect(r.wgsl).toContain("vec2<f32>(");
    expect(r.wgsl).toContain("result[base + 0u] = v[0u];");
    expect(r.wgsl).toContain("result[base + 1u] = v[1u];");
  });

  it("keeps compound assignment on int vars int-typed", () => {
    const r = transpileKernel(
      `function () { let n = 0; n += 1; n *= 2; return n; }`,
      { ...BASE, argKinds: [] },
    );
    expect(r.wgsl).toContain("n = (n + 1);");
    expect(r.wgsl).toContain("n = (n * 2);");
    expect(r.wgsl).not.toContain("f32(n +");
  });

  it("expands compound assignment on read_write args with single-eval index", () => {
    const r = transpileKernel(
      `function (a) { a[this.thread.x] += 2.0; a[this.thread.x] *= a[0]; return a[this.thread.x]; }`,
      { ...BASE, argKinds: ["array"], argAccess: ["read_write"] },
    );
    expect(r.wgsl).toContain("var _ai0 = gid.x; a[_ai0] = (a[_ai0] + 2.0);");
    expect(r.wgsl).toContain("var _ai1 = gid.x; a[_ai1] = (a[_ai1] * a[u32(0)]);");
  });

  it("keeps int semantics for bitwise compound assignment on args", () => {
    const r = transpileKernel(
      `function (a) { a[this.thread.x] &= 3; return a[this.thread.x]; }`,
      { ...BASE, argKinds: ["array"], argAccess: ["read_write"] },
    );
    expect(r.wgsl).toContain("a[_ai0] = f32((i32(a[_ai0]) & 3))");
  });

  it("marks read_write args as writable storage", () => {
    const r = transpileKernel(
      `function (a) { a[this.thread.x] = a[this.thread.x] * 2.0; return 0; }`,
      { ...BASE, argKinds: ["array"], argAccess: ["read_write"] },
    );
    expect(r.wgsl).toContain("var<storage, read_write> a: array<f32>;");
    expect(r.bindings[0].access).toBe("read_write");
  });

  it("rejects writes to read-only args", () => {
    expect(() =>
      transpileKernel(`function (a) { a[0] = 1.0; return 0; }`, { ...BASE, argKinds: ["array"] }),
    ).toThrow(/read_write/);
  });

  it("rejects closures over outer scope", () => {
    expect(() =>
      transpileKernel(`function (a) { return a[this.thread.x] + magic; }`, { ...BASE, argKinds: ["array"] }),
    ).toThrow(/magic/);
  });

  it("rejects objects and unsupported statements", () => {
    expect(() =>
      transpileKernel(`function () { const o = { x: 1 }; return o.x; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/ObjectExpression|unsupported/);
    expect(() =>
      transpileKernel(`function () { switch (1) { default: return 0; } }`, { ...BASE, argKinds: [] }),
    ).toThrow(/SwitchStatement|unsupported/);
  });

  it("injects the PCG helper only when Math.random is used", () => {
    const plain = transpileKernel(`function () { return 1; }`, { ...BASE, argKinds: [] });
    expect(plain.wgsl).not.toContain("_dd_rand");
    const withRand = transpileKernel(`function () { return Math.random(); }`, { ...BASE, argKinds: [] });
    expect(withRand.wgsl).toContain("_dd_rand(&_rs)");
    expect(withRand.wgsl).toContain("fn _dd_rand");
    expect(withRand.wgsl).toContain("RAND_SEED");
  });

  it("wraps non-boolean conditions with a != 0 comparison", () => {
    const r = transpileKernel(`function (a) { if (a[0]) { return 1; } return 0; }`, { ...BASE, argKinds: ["array"] });
    expect(r.wgsl).toContain("!= 0.0");
  });

  it("emits float division even for int operands (JS semantics)", () => {
    const r = transpileKernel(
      `function (a) { return this.thread.x / 2 + a.length / 4; }`,
      { ...BASE, argKinds: ["array"] },
    );
    expect(r.wgsl).toContain("(f32(gid.x) / f32(2))");
    expect(r.wgsl).toContain("f32(arrayLength(&a))");
  });

  it("unifies i32/u32 to i32 so countdown loops terminate", () => {
    const r = transpileKernel(
      `function (a) { let s = 0; for (let i = a.length - 1; i >= 0; i--) { s += a[i]; } return s; }`,
      { ...BASE, argKinds: ["array"] },
    );
    expect(r.wgsl).toContain("i32(arrayLength(&a)) - 1");
    expect(r.wgsl).toContain("i >= 0");
    expect(r.wgsl).not.toContain("u32(0))");
  });

  it("puts the do..while test in a continuing clause", () => {
    const r = transpileKernel(
      `function () { let i = 0; do { i += 1; continue; } while (i < 5); return i; }`,
      { ...BASE, argKinds: [] },
    );
    expect(r.wgsl).toContain("continuing {");
    expect(r.wgsl).toContain("_dw0 = !((i < 5))");
  });

  it("preserves JS operand values for && and ||", () => {
    const r = transpileKernel(
      `function (a) { return a[0] || 0.5; }`,
      { ...BASE, argKinds: ["array"] },
    );
    expect(r.wgsl).toContain("select(0.5, a[u32(0)], (a[u32(0)] != 0.0))");
    expect(r.wgsl).not.toContain("f32(");
  });

  it("rejects ?? and logical-assignment operators", () => {
    expect(() =>
      transpileKernel(`function (a) { return a[0] ?? 1; }`, { ...BASE, argKinds: ["array"] }),
    ).toThrow(/\?\?/);
    expect(() =>
      transpileKernel(`function () { let x = 1; x &&= 2; return x; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/&&=/);
  });

  it("rejects async/generator kernels", () => {
    expect(() =>
      transpileKernel(`async function () { return 1; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/async/);
    expect(() =>
      transpileKernel(`function* () { return 1; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/generator|async/);
  });

  it("rejects multi-declarator for-inits", () => {
    expect(() =>
      transpileKernel(`function () { for (let i = 0, j = 0; i < 2; i++) {} return 0; }`,
        { ...BASE, argKinds: [] }),
    ).toThrow(/declarator|multiple/);
  });

  it("rejects unknown Math calls and wrong arity", () => {
    expect(() =>
      transpileKernel(`function () { return Math.sign(1); }`, { ...BASE, argKinds: [] }),
    ).not.toThrow();
    expect(() =>
      transpileKernel(`function () { return Math.floor(1, 2); }`, { ...BASE, argKinds: [] }),
    ).toThrow(/arg/);
    expect(() =>
      transpileKernel(`function () { return Math.random(3); }`, { ...BASE, argKinds: [] }),
    ).toThrow(/arg/);
  });

  it("resolves this.constants.RAND_SEED and proto-safe names", () => {
    const r = transpileKernel(
      `function () { return this.constants.RAND_SEED; }`,
      { ...BASE, argKinds: [], constants: { RAND_SEED: 7 } },
    );
    expect(r.wgsl).toContain("f32(RAND_SEED)");
    expect(() =>
      transpileKernel(`function () { return this.constants.constructor; }`,
        { ...BASE, argKinds: [], constants: {} }),
    ).toThrow(/constants\.constructor/);
  });

  it("rejects void expressions in value position", () => {
    expect(() =>
      transpileKernel(`function () { let i = 0; let j = i++; return j; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/number|void|statement/);
  });

  it("rejects identifiers colliding with generated names", () => {
    expect(() =>
      transpileKernel(`function (Math) { return Math; }`, { ...BASE, argKinds: ["scalar"] }),
    ).toThrow(/identifier|usable/);
    expect(() =>
      transpileKernel(`function () { let user_kernel = 1; return user_kernel; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/identifier|usable/);
  });

  it("parses arrow functions", () => {
    const r = transpileKernel(`(a) => a[this.thread.x] * 2.0`, { ...BASE, argKinds: ["array"] });
    expect(r.wgsl).toContain("return (a[gid.x] * 2.0)");
  });

  it("rejects duplicate param names", () => {
    expect(() =>
      transpileKernel(`function (a, a) { return a[0]; }`, { ...BASE, argKinds: ["array", "array"] }),
    ).toThrow(/unique/);
  });

  it("rejects non-number constants", () => {
    expect(() =>
      transpileKernel(`function () { return 0; }`,
        { ...BASE, argKinds: [], constants: { X: "abc" as unknown as number } }),
    ).toThrow(/constant.*number|isn't a number/);
    expect(() =>
      transpileKernel(`function () { return 0; }`,
        { ...BASE, argKinds: [], constants: { X: true as unknown as number } }),
    ).toThrow(/isn't a number/);
    // NaN/Infinity are numbers — they emit valid WGSL forms
    expect(() =>
      transpileKernel(`function () { return this.constants.X; }`,
        { ...BASE, argKinds: [], constants: { X: NaN } }),
    ).not.toThrow();
  });

  it("rejects arrays in locals", () => {
    expect(() =>
      transpileKernel(`function (a) { let v = [1, 2]; return a[0]; }`, { ...BASE, argKinds: ["array"] }),
    ).toThrow(/arrays can't live in locals|local/);
  });

  it("emits vec selects for vec-typed ternaries", () => {
    const r = transpileKernel(
      `function (a) { return a[this.thread.x] > 0.5 ? [1, 2] : [3, 4]; }`,
      { ...BASE, argKinds: ["array"], outputStride: 2 },
    );
    expect(r.wgsl).toContain("return select(vec2<f32>(f32(3), f32(4)), vec2<f32>(f32(1), f32(2))");
    expect(() =>
      transpileKernel(`function (a) { return a[0] > 0.5 ? [1, 2] : [3, 4, 5]; }`,
        { ...BASE, argKinds: ["array"], outputStride: 2 }),
    ).toThrow(/incompatible/);
  });

  it("rejects non-statement for-init and for-update", () => {
    expect(() =>
      transpileKernel(`function () { for (let i = 0; i < 4; i * 2) {} return 0; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/for-update/);
    expect(() =>
      transpileKernel(`function () { let i = 0; for (i + 1; i < 4; i++) {} return 0; }`, { ...BASE, argKinds: [] }),
    ).toThrow(/for-init/);
  });

  it("rejects locals shadowing array params but allows scalar shadowing", () => {
    expect(() =>
      transpileKernel(`function (a) { { let a = 5.0; return a; } }`, { ...BASE, argKinds: ["array"] }),
    ).toThrow(/shadows/);
    const r = transpileKernel(
      `function (s) { { let s = 2.0; return s; } }`, { ...BASE, argKinds: ["scalar"] },
    );
    expect(r.wgsl).toContain("var s = scalars[0u];");
    expect(r.wgsl).toContain("var s = 2.0;");
  });

  it("rejects output with more than 3 dims", () => {
    expect(() =>
      transpileKernel(`function () { return 0; }`, { ...BASE, output: [1, 1, 1, 1], argKinds: [] }),
    ).toThrow(/1–3 dims/);
  });
});

describe("wgslF32", () => {
  it("formats floats, ints, infinities, NaN", () => {
    expect(wgslF32(2.5)).toBe("2.5");
    expect(wgslF32(3)).toBe("3.0");
    expect(wgslF32(-1.5)).toBe("(-1.5)");
    expect(wgslF32(Infinity)).toBe("0x1.fffffep+127");
    expect(wgslF32(NaN)).toBe("bitcast<f32>(0x7fc00000u)");
  });
});
