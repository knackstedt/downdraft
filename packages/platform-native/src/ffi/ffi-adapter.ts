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

/**
 * Opaque pointer type (same role as bun:ffi's `ptr`). bun:ffi returns a JS
 * number; koffi and Deno return bigint — which is the only lossless JS
 * representation for addresses > 2^53 (all Android heap pointers live at
 * ~0xb400_xxxx_xxxx_xxxx, so Number() would corrupt the low bits). Always
 * treat `ptr` as opaque: normalize with BigInt() before splitting, use
 * `!p`/`p == 0` for null checks (never `=== 0`), and don't do arithmetic.
 */
export type ptr = number | bigint;

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
 * Get the native pointer address of a Buffer/TypedArray. Returns `number`
 * under Bun and `bigint` under Node/Deno — keep it lossless, never Number()
 * a value meant to round-trip back into FFI.
 */
export function ptr(buffer: ArrayBufferView | ArrayBuffer): ptr {
  if (runtime === "bun") {
    return bunPtr(buffer);
  }

  if (runtime === "node") {
    return koffi.address(buffer);
  }

  // deno
  const Deno = (globalThis as any).Deno;
  const p = Deno.UnsafePointer.of(buffer);
  // UnsafePointer.of returns null for empty buffers. Pointer objects are
  // opaque Externals in Deno 2.x — UnsafePointer.value extracts the address.
  return p == null ? 0n : Deno.UnsafePointer.value(p);
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

    // Wrap to normalize representations:
    // - ptr args: number → bigint (koffi requires bigint for void *)
    // - cstring args: Buffer → string (koffi "str" expects JS string)
    // - ptr returns: keep koffi's bigint — converting to Number would drop
    //   low bits on any address > 2^53 (always true for Android heap).
    const wrapped = wrapKoffiFn(fn, spec);
    symbols[name] = wrapped;
  }

  return { symbols };
}

function wrapKoffiFn(
  fn: (...args: any[]) => any,
  spec: CFunction,
): (...args: any[]) => any {
  // Precompute one converter per arg at bind time — the per-call path then
  // runs only the conversions a signature actually needs, instead of a
  // type-string switch over every arg on every FFI crossing.
  //
  // - ptr args: number → bigint (koffi requires bigint for void *)
  // - cstring args: Buffer → string (koffi "str" expects JS string)
  // - ptr returns: keep koffi's bigint — converting to Number would drop
  //   low bits on any address > 2^53 (always true for Android heap).
  const cvts: { i: number; f: (v: any) => any }[] = [];
  spec.args.forEach((t, i) => {
    if (t === "ptr") {
      // null/undefined → koffi passes null pointer;
      // TypedArray/Buffer → koffi auto-converts to pointer
      cvts.push({ i, f: (v) => (typeof v === "number" ? BigInt(v) : v) });
    } else if (t === "cstring") {
      cvts.push({ i, f: (v) => (Buffer.isBuffer(v) ? v.toString("utf8").replace(/\0+$/, "") : v) });
    }
  });
  const retPtr = spec.returns === "ptr";

  return (...args: any[]) => {
    for (let k = 0; k < cvts.length; k++) {
      const c = cvts[k];
      if (c.i < args.length) args[c.i] = c.f(args[c.i]);
    }
    const result = fn(...args);
    if (retPtr && result == null) return 0n;
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
  // Same specialization as wrapKoffiFn: converters are built once per
  // signature so each call touches only the args that need conversion.
  const Deno = (globalThis as any).Deno;
  const cvts: { i: number; f: (v: any) => any }[] = [];
  spec.args.forEach((t, i) => {
    if (t === "ptr") {
      cvts.push({
        i,
        f: (v) => {
          if (typeof v === "number" || typeof v === "bigint") {
            return denoPointerFromAddress(BigInt(v));
          }
          if (v != null && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)) {
            // Deno 2.x "pointer" params reject bare TypedArrays — wrap them.
            return Deno.UnsafePointer.of(v);
          }
          return v; // null/undefined → NULL
        },
      });
    } else if (t === "u64" || t === "i64" || t === "usize") {
      // Deno requires bigint for 64-bit/usize params; callers using the
      // bun:ffi convention may pass a JS number.
      cvts.push({ i, f: (v) => (typeof v === "number" ? BigInt(v) : v) });
    } else if (t === "cstring") {
      // Deno has no cstring type — pass a pointer to a null-terminated
      // buffer. Deno 2.x "pointer" params reject bare TypedArrays, so
      // wrap explicitly with UnsafePointer.of.
      cvts.push({
        i,
        f: (v) => {
          if (typeof v === "string") {
            return Deno.UnsafePointer.of(denoStringEncoder.encode(v + "\0"));
          }
          if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
            return Deno.UnsafePointer.of(v);
          }
          return v;
        },
      });
    }
  });
  const retPtr = spec.returns === "ptr";
  const retCstr = spec.returns === "cstring";

  return (...args: any[]) => {
    for (let k = 0; k < cvts.length; k++) {
      const c = cvts[k];
      if (c.i < args.length) args[c.i] = c.f(args[c.i]);
    }
    const result = fn(...args);

    // Pointer returns normalize to bigint (lossless for 64-bit addresses).
    if (retPtr) {
      if (result == null) return 0n;
      if (typeof result === "bigint") return result;
      if (typeof result === "object") {
        // Deno 2.x: pointer results are opaque Externals — UnsafePointer.value
        // extracts the address; older versions expose .value as bigint.
        if (typeof (result as any).value === "bigint") return (result as any).value;
        try { return Deno.UnsafePointer.value(result); } catch { return 0n; }
      }
      return result;
    }

    if (retCstr) {
      // Read null-terminated string from the returned pointer object.
      if (result == null) return "";
      return new Deno.UnsafePointerView(result).getCString();
    }

    return result;
  };
}

// ── Utility: read native memory into a Uint8Array ──

export function readMappedRange(nativePtr: ptr, byteLength: number): Uint8Array {
  if (runtime === "bun") {
    // bun:ffi toArrayBuffer(ptr, byteOffset, byteCount) — the previous
    // Buffer.from(ptr-as-ArrayBuffer) call was invalid.
    const ab = bunToArrayBuffer(Number(nativePtr), 0, byteLength);
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
