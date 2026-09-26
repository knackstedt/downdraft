// ============================================================================
// wgsl-struct-validator — drift detection between external .wgsl files and
// WgslStruct definitions.
//
// For external .wgsl files (imported via ?raw) where we don't want to split the
// struct out of the shader file, this parser extracts `struct Foo { ... }`
// blocks from a WGSL source string, computes the layout, and compares it
// against a WgslStruct definition. In DOWNDRAFT_STRICT mode a mismatch throws;
// otherwise it logs a warning.
//
// Comments (line `//...` and block `slash-star ... star-slash`) are stripped.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { wgsl, type WgslStruct, type WgslType } from "./wgsl-struct";

const log = createLogger("info");

// ─── WGSL struct parser ─────────────────────────────────────────────────────

export interface ParsedWgslField {
  name: string;
  typeWgsl: string;
}

export interface ParsedWgslStruct {
  name: string;
  fields: ParsedWgslField[];
}

/**
 * Parse all `struct Name { ... }` blocks from a WGSL source string.
 * Handles attributes on fields (e.g. `@location(0)`) and struct attributes.
 * Comments are stripped first (line and block).
 */
export function parseWgslStructs(source: string): ParsedWgslStruct[] {
  // Strip block comments.
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments.
  cleaned = cleaned.replace(/\/\/[^\n]*/g, "");

  const structs: ParsedWgslStruct[] = [];
  // Match: struct Name { fields }
  // Fields may have attributes like @location(0) @builtin(position).
  const structRegex = /struct\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = structRegex.exec(cleaned)) !== null) {
    const name = m[1];
    const body = m[2];
    const fields = parseStructBody(body);
    structs.push({ name, fields });
  }
  return structs;
}

function parseStructBody(body: string): ParsedWgslField[] {
  const fields: ParsedWgslField[] = [];
  // Split on commas (top-level — struct bodies here don't nest commas in
  // practice; array sizes are numeric literals).
  const parts = body.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const part of parts) {
    // Strip leading attributes: @location(0), @builtin(x), @align(16), etc.
    const stripped = part.replace(/@\w+(\([^)]*\))?/g, "").trim();
    if (!stripped) continue;
    // Field: name: type
    const colonIdx = stripped.indexOf(":");
    if (colonIdx < 0) continue;
    const fieldName = stripped.slice(0, colonIdx).trim();
    const typeWgsl = stripped.slice(colonIdx + 1).trim();
    if (!fieldName || !typeWgsl) continue;
    fields.push({ name: fieldName, typeWgsl });
  }
  return fields;
}

// ─── WGSL type string → WgslType descriptor ─────────────────────────────────

/** Map a WGSL type expression string to a WgslType descriptor. */
export function wgslTypeFromString(typeWgsl: string): WgslType {
  const t = typeWgsl.trim();

  // Scalars
  if (t === "f32") return wgsl.f32;
  if (t === "u32") return wgsl.u32;
  if (t === "i32") return wgsl.i32;
  if (t === "f16") return wgsl.f16;

  // Vectors: vecN<T>
  const vecMatch = /^vec(\d)<(f32|f16|u32|i32)>$/.exec(t);
  if (vecMatch) {
    const n = Number(vecMatch[1]);
    const el = vecMatch[2] as "f32" | "f16" | "u32" | "i32";
    const isInt = el === "u32" || el === "i32";
    if (n === 2) return el === "f32" ? wgsl.vec2f : isInt ? (el === "u32" ? wgsl.vec2u : wgsl.vec2i) : wgsl.vec2f;
    if (n === 3) return el === "f32" ? wgsl.vec3f : isInt ? (el === "u32" ? wgsl.vec3u : wgsl.vec3i) : wgsl.vec3f;
    if (n === 4) return el === "f32" ? wgsl.vec4f : isInt ? (el === "u32" ? wgsl.vec4u : wgsl.vec4i) : wgsl.vec4f;
  }

  // Matrices: matCxR<T>
  const matMatch = /^mat(\d)x(\d)<(f32|f16)>$/.exec(t);
  if (matMatch) {
    const c = Number(matMatch[1]);
    const r = Number(matMatch[2]);
    const el = matMatch[3] as "f32" | "f16";
    if (el === "f32") {
      if (c === 4 && r === 4) return wgsl.mat4x4f;
      if (c === 3 && r === 3) return wgsl.mat3x3f;
      if (c === 4 && r === 3) return wgsl.mat4x3f;
      if (c === 3 && r === 4) return wgsl.mat3x4f;
      if (c === 2 && r === 2) return wgsl.mat2x2f;
      if (c === 2 && r === 4) return wgsl.mat2x4f;
      if (c === 4 && r === 2) return wgsl.mat4x2f;
    }
    throw new Error(`wgslTypeFromString: unsupported matrix ${t}`);
  }

  // Arrays: array<T, N> or array<T>
  const arrMatch = /^array<(.+),\s*(\d+)>$/.exec(t);
  if (arrMatch) {
    const elType = wgslTypeFromString(arrMatch[1]);
    const count = Number(arrMatch[2]);
    return wgsl.array(elType, count);
  }
  const arrRuntimeMatch = /^array<(.+)>$/.exec(t);
  if (arrRuntimeMatch) {
    // Runtime-sized array — treat as 1 element for layout (the host sizes it).
    const elType = wgslTypeFromString(arrRuntimeMatch[1]);
    return wgsl.array(elType, 1);
  }

  throw new Error(`wgslTypeFromString: unrecognized type "${t}"`);
}

// ─── Drift detection ────────────────────────────────────────────────────────

export interface StructMismatch {
  structName: string;
  errors: string[];
}

/**
 * Compare a parsed WGSL struct against a WgslStruct definition.
 * Returns a list of mismatch errors (empty if they match).
 *
 * Checks: field names (set equality), per-field type, per-field offset,
 * struct size. Field ORDER is not enforced (WGSL layout is order-dependent,
 * but if both sides compute layout from the same field order we get the same
 * offsets — so we compare offsets, not order).
 */
export function compareStruct(
  parsed: ParsedWgslStruct,
  def: WgslStruct,
): StructMismatch {
  const errors: string[] = [];

  if (parsed.name !== def.name) {
    errors.push(`struct name: wgsl "${parsed.name}" vs def "${def.name}"`);
  }

  // Build a layout from the parsed fields using the same rules.
  let offset = 0;
  let structAlign = 4;
  const parsedLayout: { name: string; offset: number; type: WgslType }[] = [];
  for (const f of parsed.fields) {
    let type: WgslType;
    try {
      type = wgslTypeFromString(f.typeWgsl);
    } catch (e) {
      errors.push(`field "${f.name}": cannot parse type "${f.typeWgsl}" (${(e as Error).message})`);
      continue;
    }
    const align = type.align;
    offset = (offset + align - 1) & ~(align - 1);
    parsedLayout.push({ name: f.name, offset, type });
    offset += type.size;
    if (align > structAlign) structAlign = align;
  }
  const parsedSize = (offset + structAlign - 1) & ~(structAlign - 1);

  // Compare field sets.
  const defNames = new Set(def.fieldMap.keys());
  const parsedNames = new Set(parsed.fields.map((f) => f.name));
  for (const n of defNames) {
    if (!parsedNames.has(n)) errors.push(`field "${n}" missing in wgsl`);
  }
  for (const n of parsedNames) {
    if (!defNames.has(n)) errors.push(`field "${n}" missing in def`);
  }

  // Compare offsets + types for shared fields.
  for (const pl of parsedLayout) {
    const df = def.fieldMap.get(pl.name);
    if (!df) continue;
    if (df.offset !== pl.offset) {
      errors.push(
        `field "${pl.name}": offset wgsl ${pl.offset} vs def ${df.offset}`,
      );
    }
    if (df.type.wgsl !== pl.type.wgsl) {
      errors.push(
        `field "${pl.name}": type wgsl "${pl.type.wgsl}" vs def "${df.type.wgsl}"`,
      );
    }
  }

  if (parsedSize !== def.size) {
    errors.push(`struct size: wgsl ${parsedSize} vs def ${def.size}`);
  }

  return { structName: parsed.name, errors };
}

/**
 * Assert that a WgslStruct definition matches the corresponding struct in a
 * WGSL source string. In DOWNDRAFT_STRICT mode (env var = "1"), throws on
 * mismatch. Otherwise logs a warning.
 *
 * @param wgslSource Raw WGSL source (e.g. imported via `?raw`).
 * @param def The WgslStruct definition to compare against.
 */
export function assertWgslStructMatches(wgslSource: string, def: WgslStruct): void {
  const parsed = parseWgslStructs(wgslSource);
  const match = parsed.find((s) => s.name === def.name);
  if (!match) {
    const msg = `assertWgslStructMatches: struct "${def.name}" not found in WGSL source`;
    if (isStrict()) throw new Error(msg);
    log.warn("wgsl-struct-validator", msg);
    return;
  }
  const result = compareStruct(match, def);
  if (result.errors.length > 0) {
    const msg =
      `assertWgslStructMatches: struct "${def.name}" drift:\n` +
      result.errors.map((e) => `  - ${e}`).join("\n");
    if (isStrict()) throw new Error(msg);
    log.warn("wgsl-struct-validator", msg);
  }
}

function isStrict(): boolean {
  return (
    process?.env?.DOWNDRAFT_STRICT === "1" ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV)
  );
}
