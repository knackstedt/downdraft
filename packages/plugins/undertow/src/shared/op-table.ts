// ============================================================================
// op-table — the data-driven registry of proxied DOM ops. One entry per op id.
// Adding a new API = append an entry here. The worker side generates typed
// method shims from this table (shim-gen); the main side dispatches via exec.
//
// `exec` runs on the main thread against the real DOM node resolved from the
// handle. It receives decoded args and returns a Result which the host encodes
// into a ReplyRecord.
// ============================================================================

import { ArgKind, type ArgKindValue } from "./protocol";

// --- Arg decoding (main side) ---
// The host decodes inline args + payload refs into JS values before calling exec.

export type ArgValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Int32Array
  | Float32Array
  | Float64Array
  | ArgValue[]
  | { [key: string]: ArgValue };

export interface DecodedArgs {
  /** Inline + payload-decoded args in positional order. */
  values: ArgValue[];
}

// --- Result encoding (main side) ---
export type Result =
  | { kind: 0 }                                    // Null
  | { kind: 1; value: boolean }                     // Bool
  | { kind: 2; value: number }                      // I32
  | { kind: 3; value: number }                      // U32
  | { kind: 4; value: number }                      // F32
  | { kind: 5; value: number }                      // F64
  | { kind: 6; handle: number }                     // Handle
  | { kind: 7; atom: number }                       // StringAtom
  | { kind: 8; bytes: Uint8Array }                  // PayloadRef
  | { kind: 9 }                                     // Void
  | { kind: 10; code?: number; message: string };   // Error

// --- Op entry ---
export type OpKind = "method" | "getter" | "setter";

export interface OpEntry {
  id: number;
  name: string; // e.g. "Element.setAttribute"
  kind: OpKind;
  /** Target kind: which real DOM interface the handle resolves to. */
  target: "document" | "window" | "element" | "node" | "text" | "fragment" | "any";
  /** Arg kind spec for validation / fast path (informational in v1). */
  argSpec: ArgKindValue[];
  /** Result spec (informational; the exec return value is authoritative). */
  resultSpec: ArgKindValue | "void" | "handle" | "payload";
  /**
   * Main-thread executor. `node` is the resolved real DOM Node (or null for
   * document/window sentinels). Returns a Result the host encodes into a reply.
   */
  exec: (ctx: MainExecCtx, node: Node | null, args: DecodedArgs) => Result | Promise<Result>;
}

// --- Main-side execution context ---
// Carries the host services the exec function needs (handle allocation, string
// pool, payload heap). The host constructs this once and passes it to every exec.
export interface MainExecCtx {
  /** Allocate a new handle for a real DOM node. Returns the integer handle. */
  allocHandle: (node: Node) => number;
  /** Resolve a handle to its real DOM node, or null. */
  resolveHandle: (handle: number) => Node | null;
  /** Intern a JS string → atom id (for StringAtom results). */
  internString: (str: string) => number;
  /** Resolve an atom id → JS string (for StringAtom args). */
  resolveString: (atom: number) => string | null;
  /** Write bytes into the payload heap; returns absolute offset. */
  writePayload: (bytes: Uint8Array) => number;
  /** The real document. */
  document: Document;
  /** The real window. */
  window: Window;
}

// --- The table ---
// Built incrementally; Phase 2 registers the initial 6 ops. Phase 3 appends
// the rest of the subset. Lookups are by id via a Map built at host init.

const entries: OpEntry[] = [];

export function registerOp(entry: OpEntry): void {
  // Idempotent re-registration (HMR / multiple imports) — replace in place.
  const existing = entries.findIndex((e) => e.id === entry.id);
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);
}

export function getOp(id: number): OpEntry | undefined {
  return entries.find((e) => e.id === id);
}

export function allOps(): readonly OpEntry[] {
  return entries;
}

export function buildOpMap(): Map<number, OpEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

// --- Helpers for common result shapes ---
export const voidResult = (): Result => ({ kind: ArgKind.Void });
export const boolResult = (v: boolean): Result => ({ kind: ArgKind.Bool, value: v });
export const i32Result = (v: number): Result => ({ kind: ArgKind.I32, value: v });
export const f64Result = (v: number): Result => ({ kind: ArgKind.F64, value: v });
export const handleResult = (h: number): Result => ({ kind: ArgKind.Handle, handle: h });
export const stringResult = (atom: number): Result => ({ kind: ArgKind.StringAtom, atom });
export const errorResult = (message: string, code = 0): Result => ({
  kind: ArgKind.Error,
  code,
  message,
});
