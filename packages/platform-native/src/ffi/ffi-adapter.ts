// ============================================================================
// ffi-adapter.ts — Runtime-agnostic FFI: works under Bun (bun:ffi), Node
// (koffi), and Deno (Deno.dlopen).
//
// Exports the same API surface as bun:ffi: `dlopen`, `ptr`, `CFunction` type,
// and `ptr` type. All pointer values are represented as `number` (matching
// bun:ffi), regardless of the underlying runtime's native representation.
//
// Canonical type strings (matching bun:ffi):
//   "void", "bool", "u8", "i8", "u16", "i16", "u32", "i32",
//   "u64", "i64", "f32", "f64", "ptr", "cstring", "usize"
// ============================================================================

// ── Public types (matching bun:ffi) ──

export type FFIType =
  | "void" | "bool"
  | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64"
  | "f32" | "f64"
  | "ptr" | "cstring" | "usize";

export interface CFunction {
  args: FFIType[];
  returns: FFIType;
}

/** Opaque pointer type (same as bun:ffi's `ptr` type — a JS number). */
export type ptr = number;

export interface FFILibrary {
  symbols: Record<string, (...args: any[]) => any>;
}

// ── Runtime detection ──

const runtime: "bun" | "node" | "deno" =
  typeof (globalThis as any).Deno !== "undefined" &&
  typeof (globalThis as any).Deno.dlopen === "function"
    ? "deno"
    : typeof (globalThis as any).Bun !== "undefined"
      ? "bun"
      : "node";

// ── Bun implementation (delegates to bun:ffi) ──

let bunDlopen: any = null;
let bunPtr: any = null;
let bunToArrayBuffer: any = null;

if (runtime === "bun") {
  const bunffi = await import("bun:ffi");
  bunDlopen = bunffi.dlopen;
  bunPtr = bunffi.ptr;
  bunToArrayBuffer = bunffi.toArrayBuffer;
}

// ── Node implementation (uses koffi) ──

let koffi: any = null;

if (runtime === "node") {
  koffi = (await import("koffi")).default;
}

// koffi type string mapping
const KOFFI_TYPE_MAP: Record<FFIType, string> = {
  void: "void",
  bool: "bool",
  u8: "uint8",
  i8: "int8",
  u16: "uint16",
  i16: "int16",
  u32: "uint32",
  i32: "int32",
  u64: "uint64",
  i64: "int64",
  f32: "float32",
  f64: "float64",
  ptr: "void *",
  cstring: "str",
  usize: "size_t",
};

// ── Deno implementation (uses Deno.dlopen) ──

const DENO_TYPE_MAP: Record<FFIType, string> = {
  void: "void",
  bool: "u8",
  u8: "u8",
  i8: "i8",
  u16: "u16",
  i16: "i16",
  u32: "u32",
  i32: "i32",
  u64: "u64",
  i64: "i64",
  f32: "f32",
  f64: "f64",
  ptr: "pointer",
  cstring: "pointer",
  usize: "usize",
};

// ── Public API ──

/**
 * Load a shared library and return its symbols as callable JS functions.
 * Pointer arguments and return values are represented as `number`.
 */
export function dlopen(
  path: string,
  specs: Record<string, CFunction>,
): FFILibrary {
  if (runtime === "bun") {
    return bunDlopen(path, specs);
  }

  if (runtime === "node") {
    return nodeDlopen(path, specs);
  }

  // deno
  return denoDlopen(path, specs);
}

/**
 * Get the native pointer address of a Buffer/TypedArray as a `number`.
 */
export function ptr(buffer: ArrayBufferView | ArrayBuffer): number {
  if (runtime === "bun") {
    return bunPtr(buffer);
  }

  if (runtime === "node") {
    return Number(koffi.address(buffer));
  }

  // deno
  const Deno = (globalThis as any).Deno;
  const p = Deno.UnsafePointer.of(buffer);
  // UnsafePointer.of returns null for empty buffers. Pointer objects are
  // opaque Externals in Deno 2.x — UnsafePointer.value extracts the address.
  return p == null ? 0 : Number(Deno.UnsafePointer.value(p));
}

// ── Node (koffi) implementation ──

function nodeDlopen(
  path: string,
  specs: Record<string, CFunction>,
): FFILibrary {
  const lib = koffi.load(path);
  const symbols: Record<string, (...args: any[]) => any> = {};

  for (const [name, spec] of Object.entries(specs)) {
    const argTypes = spec.args.map((t) => KOFFI_TYPE_MAP[t]);
    const retType = KOFFI_TYPE_MAP[spec.returns];
    const fn = lib.func(name, retType, argTypes);

    // Wrap to normalize pointer representation:
    // - ptr args: number → bigint (koffi requires bigint for void *)
    // - cstring args: Buffer → string (koffi "str" expects JS string)
    // - ptr returns: bigint → number (normalize to bun:ffi behavior)
    const wrapped = wrapKoffiFn(fn, spec);
    symbols[name] = wrapped;
  }

  return { symbols };
}

function wrapKoffiFn(
  fn: (...args: any[]) => any,
  spec: CFunction,
): (...args: any[]) => any {
  const argTypes = spec.args;
  const retType = spec.returns;

  return (...args: any[]) => {
    // Convert args
    for (let i = 0; i < args.length && i < argTypes.length; i++) {
      const t = argTypes[i];

      if (t === "ptr") {
        // koffi requires bigint for void * when passing a pointer address
        if (typeof args[i] === "number") {
          args[i] = BigInt(args[i]);
        }
        // null/undefined → koffi passes null pointer
        // TypedArray/Buffer → koffi auto-converts to pointer
      } else if (t === "cstring") {
        // koffi "str" expects a JS string; convert Buffer if needed
        if (Buffer.isBuffer(args[i])) {
          args[i] = args[i].toString("utf8").replace(/\0+$/, "");
        }
      }
    }

    const result = fn(...args);

    // Convert return value
    if (retType === "ptr" && typeof result === "bigint") {
      return Number(result);
    }

    return result;
  };
}

// ── Deno implementation ──

// Shared encoder for cstring args (avoids the Node-only Buffer global).
const denoStringEncoder = new TextEncoder();

/** Convert a raw numeric address to a Deno pointer object (Deno 1.x ctor vs 2.x UnsafePointer.create). */
function denoPointerFromAddress(addr: bigint): unknown {
  const UP = (globalThis as any).Deno.UnsafePointer;
  if (addr === 0n) return null; // NULL pointer
  if (typeof UP.create === "function") return UP.create(addr);
  return new UP(addr);
}

function denoDlopen(
  path: string,
  specs: Record<string, CFunction>,
): FFILibrary {
  const Deno = (globalThis as any).Deno;
  const denoSpecs: Record<string, any> = {};

  for (const [name, spec] of Object.entries(specs)) {
    denoSpecs[name] = {
      parameters: spec.args.map((t) => DENO_TYPE_MAP[t]),
      result: DENO_TYPE_MAP[spec.returns],
    };
  }

  const lib = Deno.dlopen(path, denoSpecs);
  const symbols: Record<string, (...args: any[]) => any> = {};

  for (const name of Object.keys(specs)) {
    const spec = specs[name];
    const fn = lib.symbols[name];
    symbols[name] = wrapDenoFn(fn, spec);
  }

  return { symbols };
}

function wrapDenoFn(
  fn: (...args: any[]) => any,
  spec: CFunction,
): (...args: any[]) => any {
  const argTypes = spec.args;
  const retType = spec.returns;
  const Deno = (globalThis as any).Deno;

  return (...args: any[]) => {
    // Convert args
    for (let i = 0; i < args.length && i < argTypes.length; i++) {
      const t = argTypes[i];

      if (t === "ptr") {
        if (typeof args[i] === "number" || typeof args[i] === "bigint") {
          args[i] = denoPointerFromAddress(BigInt(args[i]));
        } else if (args[i] != null && (ArrayBuffer.isView(args[i]) || args[i] instanceof ArrayBuffer)) {
          // Deno 2.x "pointer" params reject bare TypedArrays — wrap them.
          args[i] = Deno.UnsafePointer.of(args[i]);
        }
        // null/undefined → NULL.
      } else if (t === "u64" || t === "i64" || t === "usize") {
        // Deno requires bigint for 64-bit/usize params; callers using the
        // bun:ffi convention may pass a JS number.
        if (typeof args[i] === "number") args[i] = BigInt(args[i]);
      } else if (t === "cstring") {
        // Deno has no cstring type — pass a pointer to a null-terminated
        // buffer. Deno 2.x "pointer" params reject bare TypedArrays, so
        // wrap explicitly with UnsafePointer.of.
        if (typeof args[i] === "string") {
          const buf = denoStringEncoder.encode(args[i] + "\0");
          args[i] = Deno.UnsafePointer.of(buf);
        } else if (args[i] instanceof Uint8Array || args[i] instanceof ArrayBuffer) {
          args[i] = Deno.UnsafePointer.of(args[i]);
        }
      }
    }

    const result = fn(...args);

    // Convert return value — normalize everything to `number` (bun:ffi shape).
    if (retType === "ptr") {
      if (result == null) return 0;
      if (typeof result === "bigint") return Number(result);
      if (typeof result === "object") {
        // Deno 2.x: pointer results are opaque Externals — UnsafePointer.value
        // extracts the address; older versions expose .value as bigint.
        if (typeof (result as any).value === "bigint") return Number((result as any).value);
        try { return Number(Deno.UnsafePointer.value(result)); } catch { return 0; }
      }
      return result;
    }

    if (retType === "cstring") {
      // Read null-terminated string from the returned pointer object.
      if (result == null) return "";
      return new Deno.UnsafePointerView(result).getCString();
    }

    return result;
  };
}

// ── Utility: read native memory into a Uint8Array ──

export function readMappedRange(nativePtr: number, byteLength: number): Uint8Array {
  if (runtime === "bun") {
    // bun:ffi toArrayBuffer(ptr, byteOffset, byteCount) — the previous
    // Buffer.from(ptr-as-ArrayBuffer) call was invalid.
    const ab = bunToArrayBuffer(nativePtr, 0, byteLength);
    return new Uint8Array(ab);
  }

  if (runtime === "node") {
    // koffi.view(pointer, len) returns an ArrayBuffer view of native memory;
    // fall back to decode() on older koffi without it.
    if (typeof koffi.view === "function") {
      return new Uint8Array(koffi.view(BigInt(nativePtr), byteLength));
    }
    return new Uint8Array(koffi.decode(BigInt(nativePtr), "uint8", byteLength));
  }

  // deno
  const Deno = (globalThis as any).Deno;
  const p = denoPointerFromAddress(BigInt(nativePtr));
  if (p == null) return new Uint8Array(0);
  const view = new Deno.UnsafePointerView(p);
  const buf = new Uint8Array(byteLength);
  view.copyInto(buf);
  return buf;
}
