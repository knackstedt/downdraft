// ============================================================================
// wgsl-struct — typed WGSL struct definitions with computed layout
//
// Single source of truth for uniform/storage struct layout. Define a struct
// once in TS; the layout (offsets/alignment/padding/size) is computed at module
// load per the WGSL spec §14.4 (uniform address space). The struct emits its
// own WGSL declaration string, and a zero-copy typed view wraps a Float32Array
// with named field setters (type-checked at the TS level).
//
// This replaces the hand-mirrored struct + magic-offset buffer-write pattern
// (e.g. `data.set(viewProj, 0); data.set(prevViewProj, 16); ...`) that relies
// on "MUST match the WGSL below" comments.
// ============================================================================

// ─── Type descriptors ──────────────────────────────────────────────────────

export type WgslScalar = "f32" | "f16" | "u32" | "i32";
export type WgslVecCmp = "f32" | "f16" | "u32" | "i32";

/** A leaf WGSL type descriptor (scalar, vector, matrix, array, or struct ref). */
export interface WgslType {
  /** WGSL type expression string, e.g. "mat4x4<f32>", "vec3<f32>", "f32". */
  readonly wgsl: string;
  /** Byte alignment (uniform address space). */
  readonly align: number;
  /** Byte size (uniform address space, including trailing pad to align). */
  readonly size: number;
  /** Element stride for matrices (per-column) and arrays (per-element), else size. */
  readonly stride: number;
  /** Number of float32 slots this type occupies (size / 4). Convenience. */
  readonly floatCount: number;
  /** Whether this is a u32/i32 scalar (drives setU32 vs set on the view). */
  readonly isInt: boolean;
  /** Whether this is a struct reference (used by nested-struct layout). */
  readonly isStruct: boolean;
}

// ─── Layout helpers ─────────────────────────────────────────────────────────

const roundUp = (alignment: number, n: number): number =>
  (n + alignment - 1) & ~(alignment - 1);

function makeType(
  wgsl: string,
  align: number,
  size: number,
  stride: number = size,
  isInt = false,
  isStruct = false,
): WgslType {
  return Object.freeze({
    wgsl,
    align,
    size,
    stride,
    floatCount: size / 4,
    isInt,
    isStruct,
  });
}

// ─── Scalar type descriptors ────────────────────────────────────────────────

export const f32 = makeType("f32", 4, 4);
export const u32 = makeType("u32", 4, 4, 4, true);
export const i32 = makeType("i32", 4, 4, 4, true);
export const f16 = makeType("f16", 2, 2);

// ─── Vector type descriptors ────────────────────────────────────────────────
// Per WGSL §14.4: vec2<T> align 8 size 8; vec3<T> align 16 size 12;
// vec4<T> align 16 size 16. (For f16 element the align/size differ, but the
// engine only uses f32/u32/i32 vectors — keep it simple.)

function vec(n: number, el: WgslScalar, isInt: boolean): WgslType {
  const elSize = el === "f16" ? 2 : 4;
  const elAlign = elSize;
  if (n === 2) {
    return makeType(`vec2<${el}>`, Math.max(8, elAlign * 2), elSize * 2, elSize * 2, isInt);
  }
  if (n === 3) {
    // vec3: align 16 (for f32/u32/i32), size 12.
    return makeType(`vec3<${el}>`, 16, elSize * 3, 16, isInt);
  }
  if (n === 4) {
    return makeType(`vec4<${el}>`, 16, elSize * 4, elSize * 4, isInt);
  }
  throw new Error(`wgsl: unsupported vector length ${n}`);
}

export const vec2f = vec(2, "f32", false);
export const vec3f = vec(3, "f32", false);
export const vec4f = vec(4, "f32", false);
export const vec2u = vec(2, "u32", true);
export const vec3u = vec(3, "u32", true);
export const vec4u = vec(4, "u32", true);
export const vec2i = vec(2, "i32", true);
export const vec3i = vec(3, "i32", true);
export const vec4i = vec(4, "i32", true);

// ─── Matrix type descriptors ────────────────────────────────────────────────
// Per WGSL §14.4: matCxR<T> has alignment = alignment of vecR<T>, and size =
// C * RoundUp(16, stride) where stride = size of vecR<T> rounded up to 16.
// For mat4x4<f32>: align 16, size 4*16 = 64, stride 16.
// For mat3x3<f32>: align 16, size 3*16 = 48, stride 16 (vec3 size 12 → 16).
// For mat4x3<f32>: align 16, size 4*16 = 64, stride 16.
// For mat3x4<f32>: align 16, size 3*16 = 48, stride 16.

function mat(cols: number, rows: number, el: WgslScalar = "f32"): WgslType {
  if (el !== "f32" && el !== "f16") {
    throw new Error(`wgsl: matrix element type must be f32 or f16, got ${el}`);
  }
  const elSize = el === "f16" ? 2 : 4;
  // Column type is vec<rows, el>. Its align and padded stride:
  let colAlign: number;
  let colStride: number;
  if (rows === 2) {
    colAlign = Math.max(8, elSize * 2);
    colStride = roundUp(16, elSize * 2);
  } else if (rows === 3) {
    colAlign = 16;
    colStride = 16; // vec3 size 12 → padded to 16
  } else if (rows === 4) {
    colAlign = 16;
    colStride = elSize * 4; // = 16 for f32
    colStride = roundUp(16, colStride);
  } else {
    throw new Error(`wgsl: unsupported matrix row count ${rows}`);
  }
  const size = cols * colStride;
  return makeType(`mat${cols}x${rows}<${el}>`, colAlign, size, colStride);
}

export const mat4x4f = mat(4, 4);
export const mat3x3f = mat(3, 3);
export const mat4x3f = mat(4, 3);
export const mat3x4f = mat(3, 4);
export const mat2x2f = mat(2, 2);
export const mat2x4f = mat(2, 4);
export const mat4x2f = mat(4, 2);

// ─── Array type descriptor ──────────────────────────────────────────────────

/** `array<T, N>` — fixed-size array. Stride = RoundUp(alignof(T), sizeOf(T)). */
export function arrayOf<T extends WgslType>(element: T, count: number): WgslType {
  const stride = roundUp(element.align, element.size);
  const size = stride * count;
  const wgsl = `array<${element.wgsl}, ${count}>`;
  return makeType(wgsl, element.align, size, stride, element.isInt);
}

// ─── Struct definition ──────────────────────────────────────────────────────

export interface WgslFieldLayout {
  /** Field name (as declared in the struct). */
  name: string;
  /** Byte offset from the start of the struct. */
  offset: number;
  /** The type descriptor. */
  type: WgslType;
  /** Whether this field is a u32/i32 (drives setU32 on the view). */
  isInt: boolean;
}

export interface WgslStruct<Fields extends string = string> {
  /** Struct name (as declared in WGSL). */
  readonly name: string;
  /** Byte size (including trailing pad to struct alignment). */
  readonly size: number;
  /** Byte alignment (max of member alignments). */
  readonly align: number;
  /** Number of float32 slots (size / 4). Convenience for buffer sizing. */
  readonly floatCount: number;
  /** Field layouts in declaration order. */
  readonly fields: ReadonlyArray<WgslFieldLayout>;
  /** Field names (for type-safe view access). */
  readonly fieldNames: readonly Fields[];
  /** Map field name → layout (for fast lookup by the view). */
  readonly fieldMap: ReadonlyMap<string, WgslFieldLayout>;
  /** WGSL struct declaration string (including `struct Name { ... }`). */
  readonly wgsl: string;
  /** Create a typed view over a Float32Array (zero-copy). */
  view(buffer: Float32Array): StructView<Fields>;
}

// ─── Struct builder ─────────────────────────────────────────────────────────

type WgslFieldDefs = Record<string, WgslType>;

/**
 * Define a WGSL struct. Layout is computed once at call time per WGSL §14.4
 * (uniform address space). Returns a frozen `WgslStruct` descriptor.
 *
 * @example
 * const CameraUniforms = wgsl.struct("CameraUniforms", {
 *   viewProj: wgsl.mat4x4f,
 *   prevViewProj: wgsl.mat4x4f,
 * });
 * CameraUniforms.size; // 128
 * CameraUniforms.wgsl; // "struct CameraUniforms {\n  viewProj: mat4x4<f32>,\n  ...\n}\n"
 */
export const wgsl = {
  // Scalar/vector/matrix/array descriptors re-exported for ergonomics.
  f32, u32, i32, f16,
  vec2f, vec3f, vec4f, vec2u, vec3u, vec4u, vec2i, vec3i, vec4i,
  mat4x4f, mat3x3f, mat4x3f, mat3x4f, mat2x2f, mat2x4f, mat4x2f,
  array: arrayOf,

  struct<T extends WgslFieldDefs>(name: string, fields: T): WgslStruct<keyof T & string> {
    const layouts: WgslFieldLayout[] = [];
    let offset = 0;
    let structAlign = 4; // minimum alignment is 4 (size of largest scalar)

    for (const [fieldName, type] of Object.entries(fields)) {
      // Advance offset to the field's alignment boundary.
      offset = roundUp(type.align, offset);
      layouts.push({
        name: fieldName,
        offset,
        type,
        isInt: type.isInt,
      });
      offset += type.size;
      if (type.align > structAlign) structAlign = type.align;
    }

    // Struct size = round up to struct alignment (trailing pad).
    const size = roundUp(structAlign, offset);

    // Build the WGSL declaration string.
    const fieldLines = layouts.map((f) => `  ${f.name}: ${f.type.wgsl},`).join("\n");
    const wgslStr = `struct ${name} {\n${fieldLines}\n}`;

    const fieldMap = new Map<string, WgslFieldLayout>();
    for (const f of layouts) fieldMap.set(f.name, f);
    const fieldNames = layouts.map((f) => f.name as (keyof T & string));

    const descriptor = {
      name,
      size,
      align: structAlign,
      floatCount: size / 4,
      fields: Object.freeze(layouts),
      fieldNames: Object.freeze(fieldNames) as readonly (keyof T & string)[],
      fieldMap,
      wgsl: wgslStr,
      view(buffer: Float32Array): StructView<keyof T & string> {
        return new StructViewImpl(descriptor, buffer) as unknown as StructView<keyof T & string>;
      },
    };

    return Object.freeze(descriptor) as WgslStruct<keyof T & string>;
  },
};

// ─── Typed view ─────────────────────────────────────────────────────────────

/**
 * Zero-copy typed view over a Float32Array backing a struct. Field setters
 * write at computed offsets; u32/i32 fields write through a shared Uint32Array
 * view (same ArrayBuffer) so the shader reads correct u32 bit patterns.
 *
 * Field accessors are type-checked at the TS level — the `Fields` generic
 * carries the struct's field names (inferred from the `wgsl.struct()` call).
 */
export interface StructView<Fields extends string = string> {
  /** The underlying Float32Array (writes via setters land here). */
  readonly floats: Float32Array;
  /** The struct descriptor. */
  readonly struct: WgslStruct<Fields>;
  /** Byte size of the struct (convenience). */
  readonly size: number;

  /** Set a float-typed field (f32, vec*, mat*). Value type depends on field. */
  set(field: Fields, value: number | ArrayLike<number> | Float32Array): void;

  /** Set a u32/i32 scalar field via the Uint32Array view (correct bit pattern). */
  setU32(field: Fields, value: number): void;

  /** Read a field as a Float32Array subarray view (zero-copy). */
  get(field: Fields): Float32Array;

  /** Read a u32/i32 scalar field. */
  getU32(field: Fields): number;

  /** Zero the entire struct region. */
  zero(): void;
}

class StructViewImpl {
  readonly struct: WgslStruct;
  readonly floats: Float32Array;
  private u32s: Uint32Array | null = null;

  constructor(struct: WgslStruct, buffer: Float32Array) {
    if (buffer.length * 4 < struct.size) {
      throw new Error(
        `StructView: buffer too small for struct "${struct.name}" ` +
          `(need ${struct.size} bytes / ${struct.floatCount} floats, got ${buffer.length} floats)`,
      );
    }
    this.struct = struct;
    this.floats = buffer;
  }

  private u32View(): Uint32Array {
    if (!this.u32s) {
      this.u32s = new Uint32Array(
        this.floats.buffer,
        this.floats.byteOffset,
        this.floats.length,
      );
    }
    return this.u32s;
  }

  private fieldOffset(field: string): number {
    const f = this.struct.fieldMap.get(field);
    if (!f) {
      throw new Error(
        `StructView("${this.struct.name}"): unknown field "${field}". ` +
          `Known: ${[...this.struct.fieldMap.keys()].join(", ")}`,
      );
    }
    return f.offset / 4; // float index
  }

  set(field: string, value: number | ArrayLike<number> | Float32Array): void {
    const f = this.struct.fieldMap.get(field);
    if (!f) {
      throw new Error(
        `StructView("${this.struct.name}"): unknown field "${field}"`,
      );
    }
    const start = f.offset / 4;
    if (typeof value === "number") {
      this.floats[start] = value;
    } else {
      this.floats.set(value as ArrayLike<number>, start);
    }
  }

  setU32(field: string, value: number): void {
    const f = this.struct.fieldMap.get(field);
    if (!f) {
      throw new Error(
        `StructView("${this.struct.name}"): unknown field "${field}"`,
      );
    }
    if (!f.isInt && f.type.wgsl !== "u32" && f.type.wgsl !== "i32") {
      // Allow setU32 on any field but warn in strict? For packed-handle fields
      // the engine uses u32. Keep it permissive — the caller knows the field.
    }
    const start = f.offset / 4;
    this.u32View()[start] = value >>> 0;
  }

  get(field: string): Float32Array {
    const f = this.struct.fieldMap.get(field);
    if (!f) {
      throw new Error(
        `StructView("${this.struct.name}"): unknown field "${field}"`,
      );
    }
    const start = f.offset / 4;
    const count = f.type.size / 4;
    return this.floats.subarray(start, start + count);
  }

  getU32(field: string): number {
    const f = this.struct.fieldMap.get(field);
    if (!f) {
      throw new Error(
        `StructView("${this.struct.name}"): unknown field "${field}"`,
      );
    }
    const start = f.offset / 4;
    return this.u32View()[start];
  }

  zero(): void {
    this.floats.fill(0, 0, this.struct.floatCount);
  }

  get size(): number {
    return this.struct.size;
  }
}
