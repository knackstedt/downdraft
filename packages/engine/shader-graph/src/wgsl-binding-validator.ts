// ============================================================================
// wgsl-binding-validator — duplicate @group/@binding var declaration detector
//
// Mirrors wgsl-struct-validator.ts. Parses `@group(N) @binding(M) var<...> name: type;`
// declarations from a WGSL source string and flags duplicate (group, binding)
// pairs. The compiler is the single emitter of bind-group declarations (sourced
// from ShaderGraphProfile.bindGroups); chunks must NOT declare `@group/@binding
// var` inline. This validator catches the regression where a chunk accidentally
// re-declares a binding that the compiler also emits — a WGSL validation error
// (duplicate `var` declaration) that the graph.spec.ts string-only tests miss
// because they never call `device.createShaderModule`.
//
// In DOWNDRAFT_STRICT mode (or Vite dev mode) a duplicate throws; otherwise it
// logs a warning. Comments (line `//...` and block `/* ... */`) are stripped
// before parsing, same as wgsl-struct-validator.ts.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";

const log = createLogger("info");

export interface ParsedBinding {
  group: number;
  binding: number;
  /** Full access modifier string, e.g. "uniform", "storage, read", "storage, read_write", or "" for bare `var`. */
  access: string;
  /** Variable name. */
  name: string;
  /** WGSL type expression (everything after the `:`), trimmed. */
  typeWgsl: string;
  /** Raw matched declaration line (for error messages). */
  raw: string;
}

export interface DuplicateBinding {
  group: number;
  binding: number;
  /** All declarations that share this (group, binding). */
  declarations: ParsedBinding[];
}

/**
 * Parse all `@group(N) @binding(M) [var<...>] name: type;` declarations from a
 * WGSL source string. Comments (line and block) are stripped first.
 *
 * Handles:
 *   - `@group(0) @binding(0) var<uniform> uniforms: Uniforms;`
 *   - `@group(1) @binding(0) var<storage, read> lightData: LightStorage;`
 *   - `@group(2) @binding(0) var brdfLUT: texture_2d<f32>;`  (bare `var`)
 *   - Multiple `@` attributes before `var` (e.g. `@location(0)` — though those
 *     are on struct fields, not module-scope vars, they won't match the `var`
 *     requirement and are safely skipped).
 */
export function parseWgslBindings(source: string): ParsedBinding[] {
  // Strip block comments.
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip line comments.
  cleaned = cleaned.replace(/\/\/[^\n]*/g, "");

  const bindings: ParsedBinding[] = [];
  // Match: @group(N) @binding(M) [var<access>] name: type;
  // The `var<...>` part is optional in the sense that `var` may have no angle
  // bracket (bare `var name: type;`). The access modifier inside the angle
  // brackets can contain a comma (e.g. `storage, read`).
  const bindingRegex =
    /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:<([^>]*)>)?\s+(\w+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = bindingRegex.exec(cleaned)) !== null) {
    const group = Number(m[1]);
    const binding = Number(m[2]);
    const access = (m[3] ?? "").trim();
    const name = m[4];
    const typeWgsl = m[5].trim();
    bindings.push({
      group,
      binding,
      access,
      name,
      typeWgsl,
      raw: m[0],
    });
  }
  return bindings;
}

/**
 * Find duplicate (group, binding) pairs in a list of parsed bindings.
 * Returns one entry per duplicated pair, containing all declarations that
 * share it. A pair with only one declaration is not a duplicate.
 */
export function findDuplicateBindings(parsed: ParsedBinding[]): DuplicateBinding[] {
  const byKey = new Map<string, ParsedBinding[]>();
  for (const b of parsed) {
    const key = `${b.group}:${b.binding}`;
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(b);
  }
  const dupes: DuplicateBinding[] = [];
  for (const [key, decls] of byKey) {
    if (decls.length > 1) {
      const [g, b] = key.split(":").map(Number);
      dupes.push({ group: g, binding: b, declarations: decls });
    }
  }
  // Sort by (group, binding) for deterministic output.
  dupes.sort((a, b2) => (a.group - b2.group) || (a.binding - b2.binding));
  return dupes;
}

/**
 * Assert that a WGSL source string has no duplicate `@group/@binding var`
 * declarations. In DOWNDRAFT_STRICT mode (env var = "1") or Vite dev mode,
 * throws on duplicate. Otherwise logs a warning.
 */
export function assertNoDuplicateBindings(wgslSource: string): void {
  const parsed = parseWgslBindings(wgslSource);
  const dupes = findDuplicateBindings(parsed);
  if (dupes.length === 0) return;

  const lines = dupes.map((d) => {
    const declLines = d.declarations.map(
      (dec) => `    - @group(${dec.group}) @binding(${dec.binding}) var${dec.access ? `<${dec.access}>` : ""} ${dec.name}: ${dec.typeWgsl};`,
    );
    return `  @group(${d.group}) @binding(${d.binding}) declared ${d.declarations.length} times:\n${declLines.join("\n")}`;
  });
  const msg =
    `assertNoDuplicateBindings: duplicate @group/@binding var declarations:\n` +
    lines.join("\n");

  if (isStrict()) throw new Error(msg);
  log.warn("wgsl-binding-validator", msg);
}

function isStrict(): boolean {
  return (
    process?.env?.DOWNDRAFT_STRICT === "1" ||
    (typeof import.meta !== "undefined" && (import.meta as any).env?.DEV)
  );
}
