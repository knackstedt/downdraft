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

if (runtime === "bun") {
  const bunffi = await import("bun:ffi");
  bunDlopen = bunffi.dlopen;
  bunPtr = bunffi.ptr;
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
  const p = (globalThis as any).Deno.UnsafePointer.of(buffer);
  return Number(p.value);
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
        if (typeof args[i] === "number") {
          // Deno expects UnsafePointer or bigint for pointer args
          args[i] = new Deno.UnsafePointer(BigInt(args[i]));
        }
        // TypedArray/Buffer → Deno auto-converts via UnsafePointer.of
        // null → Deno passes null pointer
      } else if (t === "cstring") {
        // Deno doesn't have a cstring type; encode as null-terminated buffer
        if (typeof args[i] === "string") {
          args[i] = Buffer.from(args[i] + "\0");
        } else if (Buffer.isBuffer(args[i])) {
          // Already a buffer with null terminator — pass as-is
        }
        // Convert buffer to UnsafePointer
        if (Buffer.isBuffer(args[i]) || args[i] instanceof Uint8Array) {
          args[i] = Deno.UnsafePointer.of(args[i]);
        }
      }
    }

    const result = fn(...args);

    // Convert return value
    if (retType === "ptr") {
      if (typeof result === "bigint") return Number(result);
      if (result && typeof result.value === "bigint") return Number(result.value);
      return result;
    }

    if (retType === "cstring") {
      // Read null-terminated string from pointer
      if (typeof result === "bigint") {
        return Deno.UnsafePointerView.getString(new Deno.UnsafePointer(result));
      }
      if (result && typeof result.value === "bigint") {
        return Deno.UnsafePointerView.getString(result);
      }
      return result;
    }

    return result;
  };
}

// ── Utility: read native memory into a Uint8Array ──

export function readMappedRange(nativePtr: number, byteLength: number): Uint8Array {
  if (runtime === "bun") {
    const buf = Buffer.from(nativePtr as unknown as ArrayBuffer, 0, byteLength);
    return new Uint8Array(buf.buffer, buf.byteOffset, byteLength);
  }

  if (runtime === "node") {
    // koffi.view returns an ArrayBuffer view from a pointer
    const ab = koffi.view(BigInt(nativePtr), byteLength);
    return new Uint8Array(ab);
  }

  // deno
  const Deno = (globalThis as any).Deno;
  const view = new Deno.UnsafePointerView(BigInt(nativePtr));
  const buf = new Uint8Array(byteLength);
  view.copyInto(buf);
  return buf;
}
