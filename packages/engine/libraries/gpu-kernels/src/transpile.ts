// ============================================================================
// transpile.ts — restricted-JavaScript → WGSL kernel transpiler (gpu.js-inspired)
//
// Deliberately small dialect — "old/simple ECMAScript":
//   function (a, b, scale) {
//     let sum = 0;
//     for (let i = 0; i < a.length; i++) { sum += a[i] * b[i]; }
//     return sum * scale;
//   }
//
// Type model: f32 dominates; i32/u32 only for integer literals, `this.thread.*`
// and `arg.length` (which keeps loops/indexing exact). Everything else is
// coerced to f32. Array args are `array<f32>` storage buffers; scalar args are
// packed into a `scalars: array<f32>` buffer read by slot. `this.thread`,
// `this.output`, `this.constants` are the only `this` members.
// ============================================================================

import * as acorn from "acorn";

export type KernelArgKind = "array" | "scalar" | "buffer";

export interface KernelBinding {
  /** User parameter name. */
  param: string;
  /** Parameter position in the JS signature. */
  index: number;
  /** WGSL @binding index in group(0). */
  binding: number;
  kind: "array" | "buffer";
  access: "read" | "read_write";
}

export interface TranspileOptions {
  /** Dispatch grid in elements: [x, y?, z?] — missing components become 1. */
  output: number[];
  /** Components written per element (1|2|3|4). */
  outputStride: number;
  constants?: Record<string, number>;
  /** Kind per parameter position, in fn signature order. */
  argKinds: KernelArgKind[];
  /** Access per parameter position (storage args only; default "read"). */
  argAccess?: ("read" | "read_write")[];
  workgroupSize: [number, number, number];
}

export interface TranspileResult {
  wgsl: string;
  /** Parameter names in signature order. */
  paramOrder: string[];
  bindings: KernelBinding[];
  /** Scalar params and their slot in the `scalars` buffer, in param order. */
  scalarSlots: Map<string, number>;
  scalarsBinding: number | null;
  resultBinding: number;
  /** Return arity actually emitted (1 or outputStride). */
  resultComponents: number;
}

export class KernelSyntaxError extends Error {
  constructor(message: string, node?: { start?: number; end?: number }) {
    const where = node && typeof node.start === "number" ? ` (at offset ${node.start})` : "";
    super(`kernel transpile: ${message}${where}`);
    this.name = "KernelSyntaxError";
  }
}

type Ty = "f32" | "i32" | "u32" | "bool" | "vec" | "void";

interface E {
  code: string;
  ty: Ty;
  /** For ty "vec": component count. */
  vecN?: number;
}

const WGSL_RESERVED = new Set([
  "var", "let", "const", "fn", "return", "if", "else", "for", "while", "loop",
  "break", "continue", "switch", "case", "default", "true", "false", "struct",
  "storage", "uniform", "workgroup", "read", "write", "read_write", "function",
  "private", "array", "vec2", "vec3", "vec4", "mat2x2", "mat3x3", "mat4x4",
  "f32", "f16", "i32", "u32", "bool", "main", "scalars", "result", "gid",
  "enable", "requires", "alias", "discard", "texture", "sampler", "ptr",
  "wgsl", "premerge", "trait", "null", "align", "binding", "builtin",
  "compute", "fragment", "vertex", "group", "location", "override", "diagnostic",
]);

/** Names the generated module owns — user identifiers can't collide. */
const GENERATED_IDENT = new Set([
  "Math", "NaN", "Infinity", "undefined", "scalars", "result", "gid",
  "user_kernel", "OUT_X", "OUT_Y", "OUT_Z", "STRIDE", "RAND_SEED", "_rs",
]);
const GENERATED_PREFIX = ["CONST_", "_m_", "_dd_", "_ai"];

function assertUsableIdent(name: string, node?: { start?: number }): void {
  if (
    !IDENT_RE.test(name) || name.startsWith("_") ||
    WGSL_RESERVED.has(name) || GENERATED_IDENT.has(name) ||
    GENERATED_PREFIX.some((p) => name.startsWith(p))
  ) {
    throw new KernelSyntaxError(`"${name}" is not a usable kernel identifier`, node);
  }
}

// Math.* → direct WGSL builtin renames
const MATH_DIRECT: Record<string, string> = {
  abs: "abs", acos: "acos", asin: "asin", atan: "atan", atan2: "atan2",
  ceil: "ceil", cos: "cos", cosh: "cosh", exp: "exp", exp2: "exp2",
  floor: "floor", log: "log", log2: "log2", max: "max", min: "min",
  pow: "pow", sign: "sign", sin: "sin", sinh: "sinh", sqrt: "sqrt",
  tan: "tan", tanh: "tanh", trunc: "trunc",
};

// Math.* → module-scope helper functions (emitted only when used)
const MATH_HELPERS: Record<string, string> = {
  round: "fn _m_round(x: f32) -> f32 { return floor(x + 0.5); }",
  cbrt: "fn _m_cbrt(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }",
  expm1: "fn _m_expm1(x: f32) -> f32 { return exp(x) - 1.0; }",
  log10: "fn _m_log10(x: f32) -> f32 { return log2(x) * 0.3010299956639812; }",
  log1p: "fn _m_log1p(x: f32) -> f32 { return log(1.0 + x); }",
  clz32: "fn _m_clz32(x: f32) -> f32 { return f32(countLeadingZeros(u32(x))); }",
  imul: "fn _m_imul(a: f32, b: f32) -> f32 { return f32(i32(a) * i32(b)); }",
  hypot: "fn _m_hypot(a: f32, b: f32) -> f32 { return sqrt(a * a + b * b); }",
  fround: "fn _m_fround(x: f32) -> f32 { return x; }",
};

// Expected arity per supported Math.* name ("+" = 2 or more).
const MATH_ARITY: Record<string, number | "+"> = {
  abs: 1, acos: 1, asin: 1, atan: 1, ceil: 1, cos: 1, cosh: 1, exp: 1,
  exp2: 1, floor: 1, log: 1, log2: 1, sign: 1, sin: 1, sinh: 1, sqrt: 1,
  tan: 1, tanh: 1, trunc: 1, atan2: 2, pow: 2, min: "+", max: "+",
  round: 1, cbrt: 1, expm1: 1, log10: 1, log1p: 1, clz32: 1, fround: 1,
  imul: 2, hypot: 2, random: 0,
};

const RAND_HELPER = `fn _dd_rand(state: ptr<function, u32>) -> f32 {
  let s = *state;
  *state = s * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32((w >> 22u) ^ w) * (1.0 / 4294967296.0);
}`;

/** Format a JS number as a valid WGSL f32 literal. */
export function wgslF32(value: number): string {
  if (Number.isNaN(value)) return "bitcast<f32>(0x7fc00000u)";
  if (value === Infinity || value > 3.4028234663852886e38) return "0x1.fffffep+127";
  if (value === -Infinity || value < -3.4028234663852886e38) return "(-0x1.fffffep+127)";
  let str = `${value}`;
  if (str.indexOf(".") === -1 && str.indexOf("e") === -1 && str.indexOf("E") === -1) str += ".0";
  return value < 0 ? `(${str})` : str;
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

class Emitter {
  private scopes: Map<string, Ty>[] = [new Map()];
  private helpersUsed = new Set<string>();
  private usesRandom = false;
  /** Vars auto-widened to f32 after an int-typed decl saw a float assignment
   *  (JS vars are untyped; `var sum = 0; sum += a[i]` must just work — and
   *  Bun's toString() rewrites `0.0` → `0`, so we can't rely on the literal
   *  form surviving). Widening is monotonic: emit retries converge. */
  private widened = new Set<string>();
  private dirty = false;
  private tempCounter = 0;
  private consts = new Set<string>();
  private paramKind: Map<string, KernelArgKind>;
  private paramWritable = new Set<string>();
  private scalarSlot = new Map<string, number>();
  private constants: Record<string, number>;

  constructor(private opts: TranspileOptions, private params: string[]) {
    this.constants = opts.constants ?? {};
    this.paramKind = new Map();
    let slot = 0;
    params.forEach((name, i) => {
      const kind = opts.argKinds[i] ?? "scalar";
      this.paramKind.set(name, kind);
      if (kind === "scalar") {
        this.scalarSlot.set(name, slot++);
        this.declare(name, "f32");
      }
      if (kind !== "scalar" && opts.argAccess?.[i] === "read_write") {
        this.paramWritable.add(name);
      }
    });
  }

  private declare(name: string, ty: Ty): void {
    this.scopes[this.scopes.length - 1].set(name, ty);
  }

  private lookup(name: string): Ty | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const ty = this.scopes[i].get(name);
      if (ty !== undefined) return ty;
    }
    return null;
  }

  private push(): void { this.scopes.push(new Map()); }
  private pop(): void { this.scopes.pop(); }

  private f32(e: E): string {
    if (e.ty === "f32") return e.code;
    if (e.ty === "i32" || e.ty === "u32") return `f32(${e.code})`;
    if (e.ty === "bool") return `select(0.0, 1.0, ${e.code})`;
    throw new KernelSyntaxError(`can't use a ${e.ty === "void" ? "statement" : e.ty} as a number`);
  }

  private i32(e: E): string {
    if (e.ty === "i32") return e.code;
    if (e.ty === "f32" || e.ty === "u32") return `i32(${e.code})`;
    if (e.ty === "bool") return `select(0, 1, ${e.code})`;
    throw new KernelSyntaxError(`can't use a ${e.ty === "void" ? "statement" : e.ty} as a number`);
  }

  private u32(e: E): string {
    if (e.ty === "u32") return e.code;
    if (e.ty === "f32" || e.ty === "i32") return `u32(${e.code})`;
    if (e.ty === "bool") return `select(0u, 1u, ${e.code})`;
    throw new KernelSyntaxError(`can't use a ${e.ty === "void" ? "statement" : e.ty} as a number`);
  }

  private boolify(e: E): string {
    if (e.ty === "bool") return e.code;
    if (e.ty === "f32") return `(${e.code} != 0.0)`;
    if (e.ty === "i32" || e.ty === "u32") return `(${e.code} != 0)`;
    throw new KernelSyntaxError(`can't use a ${e.ty === "void" ? "statement" : e.ty} as a condition`);
  }

  /** Coerce a pair to a common arithmetic type. Returns [l, r, ty]. */
  private unify(l: E, r: E): [string, string, Ty] {
    if (l.ty === r.ty) return [l.code, r.code, l.ty];
    if (l.ty === "f32" || r.ty === "f32") return [this.f32(l), this.f32(r), "f32"];
    if (l.ty === "bool" || r.ty === "bool") {
      // JS numeric context: bool → 0/1, then unify as ints
      return [
        l.ty === "bool" ? `select(0, 1, ${l.code})` : l.ty === "i32" ? l.code : `i32(${l.code})`,
        r.ty === "bool" ? `select(0, 1, ${r.code})` : r.ty === "i32" ? r.code : `i32(${r.code})`,
        "i32",
      ];
    }
    if (l.ty === "vec" || r.ty === "vec" || l.ty === "void" || r.ty === "void") {
      throw new KernelSyntaxError(`incompatible operand types ${l.ty} and ${r.ty}`);
    }
    // i32⊕u32 → i32, never u32: `i >= 0` must terminate and `x - 1` must be
    // able to go negative (JS semantics). u32() is applied only at indexes.
    return [
      l.ty === "i32" ? l.code : `i32(${l.code})`,
      r.ty === "i32" ? r.code : `i32(${r.code})`,
      "i32",
    ];
  }

  // ── Expressions ──────────────────────────────────────────────────────────

  private expr(node: any): E {
    // Synthetic node carrying an already-emitted expression (used to expand
    // compound assignments without re-evaluating the index expression).
    if (node.type === "__e") return node.e as E;
    switch (node.type) {
      case "Literal": return this.literal(node);
      case "Identifier": return this.ident(node);
      case "MemberExpression": return this.member(node);
      case "CallExpression": return this.call(node);
      case "BinaryExpression": return this.binary(node);
      case "LogicalExpression": return this.logical(node);
      case "UnaryExpression": return this.unary(node);
      case "UpdateExpression": return this.update(node);
      case "AssignmentExpression": return this.assign(node);
      case "ConditionalExpression": return this.conditional(node);
      case "ArrayExpression": return this.arrayLiteral(node);
      case "ParenthesizedExpression": return this.expr(node.expression);
      default:
        throw new KernelSyntaxError(`unsupported expression "${node.type}"`, node);
    }
  }

  private literal(node: any): E {
    const v = node.value;
    if (typeof v === "number") {
      // Respect the source form: `2.0`/`1e3` are floats; `2`/`0x10` are ints.
      const raw: string | undefined = node.raw;
      const floatForm = raw ? /[.eExX]/.test(raw) && !/^0[xX]/.test(raw) : !Number.isInteger(v);
      if (!floatForm && Number.isInteger(v) && Math.abs(v) <= 2147483647) {
        return { code: `${v}`, ty: "i32" };
      }
      return { code: wgslF32(v), ty: "f32" };
    }
    if (typeof v === "boolean") return { code: `${v}`, ty: "bool" };
    if (typeof v === "bigint") throw new KernelSyntaxError(`bigint literals aren't supported`, node);
    throw new KernelSyntaxError(`unsupported literal ${String(v)}`, node);
  }

  private ident(node: any): E {
    const name: string = node.name;
    if (name === "NaN") return { code: "bitcast<f32>(0x7fc00000u)", ty: "f32" };
    if (name === "Infinity") return { code: "0x1.fffffep+127", ty: "f32" };
    if (name === "undefined") throw new KernelSyntaxError(`"undefined" is not available in kernels`, node);
    const kind = this.paramKind.get(name);
    if (kind === "array" || kind === "buffer") {
      throw new KernelSyntaxError(`array arg "${name}" used as a value — index it (${name}[i]) or take ${name}.length`, node);
    }
    const ty = this.lookup(name);
    if (ty === null) {
      throw new KernelSyntaxError(`unknown identifier "${name}" — kernels can't close over outer scope (pass it as an argument or constants entry)`, node);
    }
    return { code: name, ty };
  }

  private member(node: any): E {
    const obj = node.object;
    // this.<group>.<prop> — also this["group"].<prop>
    if (obj.type === "MemberExpression" && obj.object.type === "ThisExpression") {
      return this.thisAccess(node);
    }
    if (obj.type === "ThisExpression") {
      throw new KernelSyntaxError(`use this.thread.x / this.output.x / this.constants.NAME`, node);
    }
    if (obj.type === "Identifier" && this.paramKind.has(obj.name)) {
      const kind = this.paramKind.get(obj.name);
      if (kind === "scalar") {
        throw new KernelSyntaxError(`scalar arg "${obj.name}" can't be indexed`, node);
      }
      if (!node.computed) {
        if (node.property.type === "Identifier" && node.property.name === "length") {
          return { code: `arrayLength(&${obj.name})`, ty: "u32" };
        }
        throw new KernelSyntaxError(`unsupported member ".${node.property.name}" on arg "${obj.name}" — only .length and indexing`, node);
      }
      if (node.property.type === "Literal" && node.property.value === "length") {
        return { code: `arrayLength(&${obj.name})`, ty: "u32" };
      }
      const idx = this.expr(node.property);
      return { code: `${obj.name}[${this.u32(idx)}]`, ty: "f32" };
    }
    throw new KernelSyntaxError(`unsupported member expression — only arg[i], arg.length, this.thread/output/constants`, node);
  }

  private thisAccess(node: any): E {
    // node: MemberExpression{ object: MemberExpression{ object: This, property: group }, property: prop }
    const group = node.object.computed ? this.constKey(node.object.property) : node.object.property.name;
    if (group === null) {
      throw new KernelSyntaxError(`this[...] needs a literal key (this.thread / this.output / this.constants)`, node.object);
    }
    const prop = node.computed ? this.constKey(node.property) : node.property.name;
    if (group === "thread" || group === "output") {
      if (prop !== "x" && prop !== "y" && prop !== "z") {
        throw new KernelSyntaxError(`this.${group} supports .x/.y/.z only`, node);
      }
      return { code: group === "thread" ? `gid.${prop}` : `OUT_${prop.toUpperCase()}`, ty: "u32" };
    }
    if (group === "constants") {
      if (prop === null || !Object.prototype.hasOwnProperty.call(this.constants, prop)) {
        throw new KernelSyntaxError(`this.constants.${prop ?? "?"} is not in the kernel's constants map`, node);
      }
      // RAND_SEED is emitted as the u32 seed constant, not CONST_*
      if (prop === "RAND_SEED") return { code: "f32(RAND_SEED)", ty: "f32" };
      return { code: `CONST_${prop}`, ty: "f32" };
    }
    throw new KernelSyntaxError(`unsupported this.${group}`, node);
  }

  private constKey(node: any): string | null {
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    return null;
  }

  private call(node: any): E {
    const callee = node.callee;
    if (
      callee.type === "MemberExpression" && !callee.computed &&
      callee.object.type === "Identifier" && callee.object.name === "Math" &&
      callee.property.type === "Identifier"
    ) {
      const name: string = callee.property.name;
      const arity = MATH_ARITY[name];
      if (arity === undefined) {
        throw new KernelSyntaxError(`Math.${name} is not supported in kernels`, node);
      }
      const args = node.arguments.map((a: any) => this.expr(a));
      const argcOk = arity === "+" ? args.length >= 2 : args.length === arity;
      if (!argcOk) {
        throw new KernelSyntaxError(`Math.${name} takes ${arity === "+" ? "≥2" : arity} arg(s), got ${args.length}`, node);
      }
      if (name === "random") {
        this.usesRandom = true;
        return { code: `_dd_rand(&_rs)`, ty: "f32" };
      }
      if (name === "min" || name === "max") {
        let code = this.f32(args[0]);
        for (let i = 1; i < args.length; i++) code = `${name}(${code}, ${this.f32(args[i])})`;
        return { code, ty: "f32" };
      }
      if (MATH_DIRECT[name]) {
        return { code: `${MATH_DIRECT[name]}(${args.map((a: any) => this.f32(a)).join(", ")})`, ty: "f32" };
      }
      this.helpersUsed.add(name);
      return { code: `_m_${name}(${args.map((a: any) => this.f32(a)).join(", ")})`, ty: "f32" };
    }
    throw new KernelSyntaxError(`unsupported call — kernels only support Math.* builtins (no helper functions yet)`, node);
  }

  private binary(node: any): E {
    const op: string = node.operator;
    if (op === "**") {
      const l = this.expr(node.left);
      const r = this.expr(node.right);
      return { code: `pow(${this.f32(l)}, ${this.f32(r)})`, ty: "f32" };
    }
    if (op === "instanceof" || op === "in") {
      throw new KernelSyntaxError(`operator "${op}" is not supported`, node);
    }
    const l = this.expr(node.left);
    const r = this.expr(node.right);
    // JS "/" is always float division — never emit int `/` (it truncates).
    if (op === "/") {
      return { code: `(${this.f32(l)} / ${this.f32(r)})`, ty: "f32" };
    }
    if (op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>") {
      // WGSL shift amounts must be u32.
      const rhs = op === "<<" || op === ">>" ? this.u32(r) : this.i32(r);
      return { code: `(${this.i32(l)} ${op} ${rhs})`, ty: "i32" };
    }
    if (op === ">>>") {
      return { code: `(${this.u32(l)} >> ${this.u32(r)})`, ty: "u32" };
    }
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=" ||
        op === "===" || op === "!==") {
      const realOp = op === "===" ? "==" : op === "!==" ? "!=" : op;
      const [lc, rc] = this.unify(l, r);
      return { code: `(${lc} ${realOp} ${rc})`, ty: "bool" };
    }
    const [lc, rc, ty] = this.unify(l, r);
    return { code: `(${lc} ${op} ${rc})`, ty };
  }

  private logical(node: any): E {
    const op: string = node.operator;
    if (op === "??") {
      throw new KernelSyntaxError(`"??" isn't supported — write an explicit check`, node);
    }
    const l = this.expr(node.left);
    const r = this.expr(node.right);
    const [lc, rc, ty] = this.unify(l, r);
    if (ty === "bool") {
      return { code: `(${this.boolify(l)} ${op} ${this.boolify(r)})`, ty: "bool" };
    }
    // JS returns an operand, not a boolean — select() preserves that.
    return op === "||"
      ? { code: `select(${rc}, ${lc}, ${this.boolify(l)})`, ty }
      : { code: `select(${lc}, ${rc}, ${this.boolify(l)})`, ty };
  }

  private unary(node: any): E {
    const a = this.expr(node.argument);
    switch (node.operator) {
      case "-": {
        if (a.ty === "bool" || a.ty === "void" || a.ty === "vec") {
          throw new KernelSyntaxError(`unary - on ${a.ty}`, node);
        }
        // u32 has no unary minus in WGSL — negate through i32.
        const code = a.ty === "u32" ? this.i32(a) : a.code;
        return { code: `-(${code})`, ty: a.ty === "u32" ? "i32" : a.ty };
      }
      case "+": {
        if (a.ty === "bool") return { code: `select(0.0, 1.0, ${a.code})`, ty: "f32" };
        if (a.ty === "void" || a.ty === "vec") {
          throw new KernelSyntaxError(`unary + on ${a.ty}`, node);
        }
        return a;
      }
      case "!": return { code: `!(${this.boolify(a)})`, ty: "bool" };
      case "~": return { code: `~(${this.i32(a)})`, ty: "i32" };
      default: throw new KernelSyntaxError(`unsupported unary "${node.operator}"`, node);
    }
  }

  private update(node: any): E {
    const t = node.argument;
    const op = node.operator === "++" ? "+=" : "-=";
    if (t.type === "Identifier") {
      const ty = this.lookup(t.name);
      if (ty === null) throw new KernelSyntaxError(`unknown identifier "${t.name}"`, t);
      if (this.consts.has(t.name)) {
        throw new KernelSyntaxError(`can't ${node.operator} a const "${t.name}"`, node);
      }
      if (ty === "bool" || ty === "void" || ty === "vec") {
        throw new KernelSyntaxError(`can't ${node.operator} a ${ty} variable`, node);
      }
      const lit = ty === "u32" ? "1u" : ty === "i32" ? "1" : "1.0";
      return { code: `${t.name} ${op} ${lit}`, ty: "void" };
    }
    if (t.type === "MemberExpression") {
      const obj = t.object;
      if (t.computed && obj.type === "Identifier" && this.paramWritable.has(obj.name)) {
        const idx = this.expr(t.property);
        return { code: `${obj.name}[${this.u32(idx)}] ${op} 1.0`, ty: "void" };
      }
      throw new KernelSyntaxError(`${node.operator} on that target needs a "read_write" arg`, node);
    }
    throw new KernelSyntaxError(`unsupported ${node.operator} target`, node);
  }

  /** Expand `x op= v` → `x = x op v` via binary() for correct op semantics. */
  private compoundOp(op: string, lhsNode: any, rhsNode: any): E {
    if (op === "&&=" || op === "||=" || op === "??=") {
      throw new KernelSyntaxError(`"${op}" isn't supported`, rhsNode);
    }
    return this.binary({
      type: "BinaryExpression",
      operator: op.slice(0, -1),
      left: lhsNode,
      right: rhsNode,
    });
  }

  private assign(node: any): E {
    const op: string = node.operator;
    const t = node.left;
    if (t.type === "Identifier") {
      const name: string = t.name;
      const kind = this.paramKind.get(name);
      if (kind === "array" || kind === "buffer") {
        throw new KernelSyntaxError(`can't assign to array arg "${name}" — assign to ${name}[i]`, node);
      }
      const ty = this.lookup(name);
      if (ty === null) {
        throw new KernelSyntaxError(`can't assign to undeclared "${name}" — declare it first`, t);
      }
      if (this.consts.has(name)) {
        throw new KernelSyntaxError(`can't assign to const "${name}"`, node);
      }
      const rhs = op === "=" ? this.expr(node.right) : this.compoundOp(op, t, node.right);
      this.checkAssignTypes(name, ty, rhs);
      const code = ty === "f32" ? this.f32(rhs) : ty === "i32" ? this.i32(rhs) : ty === "u32" ? this.u32(rhs) : rhs.code;
      return { code: `${name} = ${code}`, ty: "void" };
    }
    if (t.type === "MemberExpression" && t.computed) {
      const obj = t.object;
      if (obj.type === "Identifier" && this.paramKind.has(obj.name) && this.paramKind.get(obj.name) !== "scalar") {
        if (!this.paramWritable.has(obj.name)) {
          throw new KernelSyntaxError(`writes to "${obj.name}" require access: "read_write" for that arg`, node);
        }
        const idx = this.expr(t.property);
        if (op === "=") {
          const rhs = this.expr(node.right);
          if (rhs.ty === "vec") {
            throw new KernelSyntaxError(`can't store a vector in ${obj.name}[i]`, node);
          }
          return { code: `${obj.name}[${this.u32(idx)}] = ${this.f32(rhs)}`, ty: "void" };
        }
        // a[i] op= v → `var _aiN = i; a[_aiN] = f32(a[_aiN] op v)` — the
        // index evaluates exactly once (Math.random/side effects safe).
        const tmp = `_ai${this.tempCounter++}`;
        const lhsE: E = { code: `${obj.name}[${tmp}]`, ty: "f32" };
        const bin = this.compoundOp(op, { type: "__e", e: lhsE }, node.right);
        return {
          code: `var ${tmp} = ${this.u32(idx)}; ${lhsE.code} = ${this.f32(bin)}`,
          ty: "void",
        };
      }
      throw new KernelSyntaxError(`unsupported assignment target`, node);
    }
    throw new KernelSyntaxError(`unsupported assignment target "${t.type}"`, node);
  }

  /**
   * Type-check an assignment. Int-typed vars that receive a float get widened
   * to f32 and the emit re-runs (JS number semantics). Bool mismatches are
   * real errors.
   */
  private checkAssignTypes(name: string, ty: Ty, rhs: E): void {
    if (rhs.ty === "vec") {
      throw new KernelSyntaxError(`can't assign a vector to "${name}"`, undefined);
    }
    if ((ty === "i32" || ty === "u32") && rhs.ty === "f32" && !this.paramKind.has(name)) {
      this.widened.add(name);
      this.dirty = true;
    }
    if (ty === "bool" && rhs.ty !== "bool") {
      throw new KernelSyntaxError(`"${name}" is bool but the assignment isn't`);
    }
    if (ty === "f32" && rhs.ty === "bool") {
      throw new KernelSyntaxError(`"${name}" is f32 but the assignment is bool`);
    }
  }

  private conditional(node: any): E {
    const c = this.expr(node.test);
    const cons = this.expr(node.consequent);
    const alt = this.expr(node.alternate);
    const [tc, fc, ty] = this.unify(cons, alt);
    return { code: `select(${fc}, ${tc}, ${this.boolify(c)})`, ty };
  }

  private arrayLiteral(node: any): E {
    const els = node.elements.map((e: any) => this.expr(e));
    if (els.length < 1 || els.length > 4) {
      throw new KernelSyntaxError(`return arrays must have 1–4 elements`, node);
    }
    return { code: `vec${els.length}<f32>(${els.map((e: any) => this.f32(e)).join(", ")})`, ty: "vec", vecN: els.length };
  }

  // ── Statements ───────────────────────────────────────────────────────────

  private stmt(node: any, ind: string): string {
    switch (node.type) {
      case "BlockStatement": {
        this.push();
        const body = node.body.map((s: any) => this.stmt(s, ind + "  ")).join("");
        this.pop();
        return `${ind}{\n${body}${ind}}\n`;
      }
      case "VariableDeclaration": return this.varDecl(node, ind);
      case "ExpressionStatement": {
        const e = this.expr(node.expression);
        if (e.ty !== "void") {
          throw new KernelSyntaxError(`expression statement has no effect`, node.expression);
        }
        return `${ind}${e.code};\n`;
      }
      case "IfStatement": return this.ifStmt(node, ind);
      case "ForStatement": return this.forStmt(node, ind);
      case "WhileStatement": {
        const c = this.expr(node.test);
        return `${ind}while (${this.boolify(c)}) {\n${this.stmtBody(node.body, ind)}${ind}}\n`;
      }
      case "DoWhileStatement": {
        const c = this.expr(node.test);
        // JS do..while tests after every pass — including passes ended by
        // `continue`, which a bare tail check would skip. naga rejects
        // `break` inside `continuing`, so the test sets a flag that the
        // loop head breaks on.
        const tmp = `_dw${this.tempCounter++}`;
        return `${ind}var ${tmp} = false;\n${ind}loop {\n${ind}  if (${tmp}) { break; }\n${this.stmtBody(node.body, ind)}${ind}  continuing {\n${ind}    ${tmp} = !(${this.boolify(c)});\n${ind}  }\n${ind}}\n`;
      }
      case "ReturnStatement": return `${ind}return ${this.returnValue(node.argument)};\n`;
      case "BreakStatement": return `${ind}break;\n`;
      case "ContinueStatement": return `${ind}continue;\n`;
      case "EmptyStatement": return "";
      default:
        throw new KernelSyntaxError(`unsupported statement "${node.type}"`, node);
    }
  }

  private stmtBody(node: any, ind: string): string {
    if (node.type === "BlockStatement") {
      this.push();
      const body = node.body.map((s: any) => this.stmt(s, ind + "  ")).join("");
      this.pop();
      return body;
    }
    return this.stmt(node, ind + "  ");
  }

  private returnValue(arg: any): string {
    if (!arg) {
      return this.opts.outputStride > 1 ? `vec${this.opts.outputStride}<f32>()` : "0.0";
    }
    if (arg.type === "ArrayExpression") {
      if (this.opts.outputStride <= 1) {
        throw new KernelSyntaxError(`kernel returns an array — set outputStride to its length`, arg);
      }
      const v = this.expr(arg);
      if (v.vecN !== this.opts.outputStride) {
        throw new KernelSyntaxError(`return array has ${v.vecN} components but outputStride is ${this.opts.outputStride}`, arg);
      }
      return v.code;
    }
    const e = this.expr(arg);
    if (e.ty === "vec") {
      if (this.opts.outputStride > 1 && e.vecN === this.opts.outputStride) return e.code;
      throw new KernelSyntaxError(
        `kernel returns a vec${e.vecN} but outputStride is ${this.opts.outputStride}`, arg);
    }
    if (this.opts.outputStride > 1) {
      throw new KernelSyntaxError(`outputStride is ${this.opts.outputStride} — kernel must return an array of that length`, arg);
    }
    return this.f32(e);
  }

  private varDecl(node: any, ind: string): string {
    let out = "";
    node.declarations.forEach((d: any) => {
      if (d.id.type !== "Identifier") {
        throw new KernelSyntaxError(`destructuring is not supported in kernels`, d.id);
      }
      const name: string = d.id.name;
      assertUsableIdent(name, d.id);
      // JS `var` (and sloppy redeclaration) may redeclare in the same scope —
      // WGSL can't. A same-scope redeclare degrades to a plain assignment.
      const current = this.scopes[this.scopes.length - 1];
      if (current.has(name)) {
        if (d.init) {
          const e = this.expr(d.init);
          const ty = current.get(name)!;
          this.checkAssignTypes(name, ty, e);
          const code = ty === "f32" ? this.f32(e) : ty === "i32" ? this.i32(e) : ty === "u32" ? this.u32(e) : e.code;
          out += `${ind}${name} = ${code};\n`;
        }
        return;
      }
      if (d.init) {
        const e = this.expr(d.init);
        if (e.ty === "void") {
          throw new KernelSyntaxError(`can't initialize "${name}" from a statement`, d.init);
        }
        const widen = this.widened.has(name) && e.ty !== "f32" && e.ty !== "bool" && e.ty !== "vec";
        this.declare(name, widen ? "f32" : e.ty);
        if (node.kind === "const") this.consts.add(name);
        const kw = node.kind === "const" ? "let" : "var";
        out += `${ind}${kw} ${name} = ${widen ? `f32(${e.code})` : e.code};\n`;
      } else {
        this.declare(name, "f32");
        out += `${ind}var ${name}: f32;\n`;
      }
    });
    return out;
  }

  private ifStmt(node: any, ind: string): string {
    const c = this.expr(node.test);
    let out = `${ind}if (${this.boolify(c)}) {\n${this.stmtBody(node.consequent, ind)}${ind}}`;
    if (node.alternate) {
      if (node.alternate.type === "IfStatement") {
        out += ` else ${this.ifStmt(node.alternate, ind).slice(ind.length)}`;
      } else {
        out += ` else {\n${this.stmtBody(node.alternate, ind)}${ind}}\n`;
      }
    } else {
      out += `\n`;
    }
    return out;
  }

  private forStmt(node: any, ind: string): string {
    this.push();
    let init = "";
    if (node.init) {
      if (node.init.type === "VariableDeclaration") {
        if (node.init.declarations.length > 1) {
          throw new KernelSyntaxError(`for-init with multiple declarators isn't supported — split it`, node.init);
        }
        init = this.varDecl(node.init, "").trimEnd().replace(/;$/, "");
      } else {
        init = this.expr(node.init).code;
      }
    }
    const test = node.test ? this.boolify(this.expr(node.test)) : "";
    const update = node.update ? this.expr(node.update).code : "";
    const body = this.stmtBody(node.body, ind);
    this.pop();
    return `${ind}for (${init}; ${test}; ${update}) {\n${body}${ind}}\n`;
  }

  // ── Assembly ─────────────────────────────────────────────────────────────

  emit(body: any[]): TranspileResult {
    // bindings: storage args in param order, scalars, then result
    const bindings: KernelBinding[] = [];
    let b = 0;
    const decls: string[] = [];
    this.params.forEach((name, i) => {
      const kind = this.opts.argKinds[i] ?? "scalar";
      if (kind === "scalar") return;
      const access = this.paramWritable.has(name) ? "read_write" : "read";
      decls.push(`@group(0) @binding(${b}) var<storage, ${access}> ${name}: array<f32>;`);
      bindings.push({ param: name, index: i, binding: b, kind, access });
      b++;
    });
    let scalarsBinding: number | null = null;
    if (this.scalarSlot.size > 0) {
      scalarsBinding = b++;
      decls.push(`@group(0) @binding(${scalarsBinding}) var<storage, read> scalars: array<f32>;`);
    }
    const resultBinding = b;
    decls.push(`@group(0) @binding(${resultBinding}) var<storage, read_write> result: array<f32>;`);

    const [ox, oy, oz] = [this.opts.output[0], this.opts.output[1] ?? 1, this.opts.output[2] ?? 1];
    const lines: string[] = [];
    lines.push("// generated by @downdraft/engine/libraries/gpu-kernels — do not edit");
    for (const [name, value] of Object.entries(this.constants)) {
      if (name === "RAND_SEED") continue;
      assertUsableIdent(name);
      lines.push(`const CONST_${name}: f32 = ${wgslF32(value)};`);
    }
    lines.push(`const OUT_X: u32 = ${ox}u;`);
    lines.push(`const OUT_Y: u32 = ${oy}u;`);
    lines.push(`const OUT_Z: u32 = ${oz}u;`);
    lines.push(`const STRIDE: u32 = ${this.opts.outputStride}u;`);
    if (this.constants.RAND_SEED !== undefined) {
      lines.push(`const RAND_SEED: u32 = ${this.constants.RAND_SEED >>> 0}u;`);
    }
    lines.push("");
    lines.push(decls.join("\n"));
    lines.push("");

    // prologue: scalar param locals (+ rand state), then body
    let prologue = "";
    this.scalarSlot.forEach((slot, name) => {
      prologue += `  var ${name} = scalars[${slot}u];\n`;
    });
    // Emit the body, retrying while int-typed vars get widened to f32.
    let bodyStr = "";
    do {
      this.dirty = false;
      this.push();
      bodyStr = "";
      body.forEach((s: any) => { bodyStr += this.stmt(s, "  "); });
      this.pop();
    } while (this.dirty);
    // Kernels that fall through without a return produce 0.
    bodyStr += `  return ${this.opts.outputStride > 1 ? `vec${this.opts.outputStride}<f32>()` : "0.0"};\n`;

    this.helpersUsed.forEach((h) => lines.push(MATH_HELPERS[h]));
    if (this.usesRandom) {
      if (this.constants.RAND_SEED === undefined) {
        lines.push(`const RAND_SEED: u32 = 3067833785u;`);
      }
      lines.push(RAND_HELPER);
    }
    if (this.helpersUsed.size || this.usesRandom) lines.push("");

    const retTy = this.opts.outputStride > 1 ? `vec${this.opts.outputStride}<f32>` : "f32";
    const randDecl = this.usesRandom
      ? `  var _rs: u32 = ((gid.x * 747796405u + gid.y * 2891336453u + gid.z * 277803737u) ^ RAND_SEED) + 1u;\n`
      : "";
    lines.push(`fn user_kernel(gid: vec3<u32>) -> ${retTy} {`);
    lines.push(prologue + randDecl + bodyStr.trimEnd());
    lines.push(`}`);
    lines.push("");
    const [wx, wy, wz] = this.opts.workgroupSize;
    lines.push(`@compute @workgroup_size(${wx}, ${wy}, ${wz})`);
    lines.push(`fn main(@builtin(global_invocation_id) gid: vec3<u32>) {`);
    lines.push(`  if (gid.x >= OUT_X || gid.y >= OUT_Y || gid.z >= OUT_Z) { return; }`);
    lines.push(`  let idx = (gid.z * OUT_Y + gid.y) * OUT_X + gid.x;`);
    lines.push(`  let v = user_kernel(gid);`);
    if (this.opts.outputStride === 1) {
      lines.push(`  result[idx] = v;`);
    } else {
      lines.push(`  let base = idx * STRIDE;`);
      for (let i = 0; i < this.opts.outputStride; i++) {
        lines.push(`  result[base + ${i}u] = v[${i}u];`);
      }
    }
    lines.push(`}`);

    return {
      wgsl: lines.join("\n"),
      paramOrder: [...this.params],
      bindings,
      scalarSlots: this.scalarSlot,
      scalarsBinding,
      resultBinding,
      resultComponents: this.opts.outputStride,
    };
  }
}

/** Extract the function node from kernel source (`function (...) {}`, arrows). */
function parseKernelFn(source: string): any {
  let ast: any;
  try {
    ast = acorn.parse(`(${source})`, { ecmaVersion: "latest" });
  } catch (e) {
    throw new KernelSyntaxError(`can't parse kernel source: ${(e as Error).message}`);
  }
  const stmt = ast.body[0];
  if (stmt?.type !== "ExpressionStatement") {
    throw new KernelSyntaxError(`kernel must be a single function expression`);
  }
  const fn = stmt.expression;
  if (fn.async || fn.generator) {
    throw new KernelSyntaxError(`kernel can't be async or a generator`);
  }
  if (fn.type === "FunctionExpression" || fn.type === "FunctionDeclaration") return fn;
  if (fn.type === "ArrowFunctionExpression") {
    if (fn.body.type !== "BlockStatement") {
      fn.body = { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: fn.body }] };
    }
    return fn;
  }
  throw new KernelSyntaxError(`kernel must be a function expression — got "${fn.type}"`);
}

/**
 * Transpile a restricted-JS kernel function to a complete WGSL module.
 *
 * `source` is `fn.toString()`. `argKinds[i]` classifies each parameter:
 * "array" (TypedArray → storage buffer), "buffer" (GPUBuffer → direct bind),
 * "scalar" (number → packed into the scalars buffer).
 */
export function transpileKernel(source: string, opts: TranspileOptions): TranspileResult {
  const fn = parseKernelFn(source);
  const params: string[] = fn.params.map((p: any) => {
    if (p.type !== "Identifier") {
      throw new KernelSyntaxError(`kernel params must be plain identifiers`, p);
    }
    assertUsableIdent(p.name, p);
    return p.name;
  });
  if (params.length > opts.argKinds.length) {
    throw new KernelSyntaxError(
      `kernel takes ${params.length} params but argKinds declares ${opts.argKinds.length}`);
  }
  const stride = opts.outputStride;
  if (!Number.isInteger(stride) || stride < 1 || stride > 4) {
    throw new KernelSyntaxError(`outputStride must be an integer 1–4, got ${stride}`);
  }
  for (let i = 0; i < Math.min(opts.output.length, 3); i++) {
    const d = opts.output[i];
    if (!Number.isInteger(d) || d <= 0) {
      throw new KernelSyntaxError(`output dims must be positive integers, got ${d}`);
    }
  }
  opts.workgroupSize.forEach((w) => {
    if (!Number.isInteger(w) || w <= 0) {
      throw new KernelSyntaxError(`workgroupSize must be positive integers, got ${w}`);
    }
  });
  const emitter = new Emitter(opts, params);
  return emitter.emit(fn.body.body);
}
