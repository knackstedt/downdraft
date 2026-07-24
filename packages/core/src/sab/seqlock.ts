export interface BufferField {
  name: string;
  offset: number;
  type: "f32" | "f64" | "i32" | "u32" | "bool";
  count: number;
}

export interface BufferLayout {
  totalBytes: number;
  seqOffset: number;
  fields: BufferField[];
}

const TYPE_SIZES: Record<string, number> = {
  f32: 4,
  f64: 8,
  i32: 4,
  u32: 4,
  bool: 4,
};

const TYPE_ARRAY_CTOR: Record<string, (buffer: ArrayBufferLike, byteOffset: number, length: number) => any> = {
  f32: (b, o, l) => new Float32Array(b, o, l),
  f64: (b, o, l) => new Float64Array(b, o, l),
  i32: (b, o, l) => new Int32Array(b, o, l),
  u32: (b, o, l) => new Uint32Array(b, o, l),
  bool: (b, o, l) => new Int32Array(b, o, l),
};

export function createLayout(fields: Omit<BufferField, "offset">[]): BufferLayout {
  const SEQ_BYTES = 4;
  let offset = SEQ_BYTES;
  const layoutFields: BufferField[] = [];

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const size = TYPE_SIZES[f.type] * f.count;
    layoutFields.push({ ...f, offset });
    offset += size;
  }

  return {
    totalBytes: offset,
    seqOffset: 0,
    fields: layoutFields,
  };
}

export class SeqlockBuffer<T = Record<string, unknown>> {
  private sab: SharedArrayBuffer | ArrayBuffer;
  private view: DataView;
  private layout: BufferLayout;
  private seqOffset: number;
  private fieldArrays: Map<string, { array: any; type: string; count: number }> = new Map();
  private lastReadData: T | null = null;
  private maxRetries: number;
  private seqArr: Int32Array;

  constructor(
    sab: SharedArrayBuffer | ArrayBuffer,
    layout: BufferLayout,
    maxRetries: number = 8,
  ) {
    this.sab = sab;
    this.view = new DataView(sab);
    this.layout = layout;
    this.seqOffset = layout.seqOffset;
    this.maxRetries = maxRetries;
    this.seqArr = new Int32Array(sab, this.seqOffset, 1);

    for (let i = 0; i < layout.fields.length; i++) {
      const f = layout.fields[i];
      const ctor = TYPE_ARRAY_CTOR[f.type];
      this.fieldArrays.set(f.name, {
        array: ctor(sab, f.offset, f.count),
        type: f.type,
        count: f.count,
      });
    }
  }

  beginWrite(): void {
    const seq = Atomics.load(this.seqArr, 0);
    Atomics.store(this.seqArr, 0, seq + 1);
  }

  endWrite(): void {
    const seq = Atomics.load(this.seqArr, 0);
    Atomics.store(this.seqArr, 0, seq + 1);
  }

  writeField(name: string, values: number[] | number): void {
    const info = this.fieldArrays.get(name);
    if (!info) return;
    const arr = info.array;
    if (Array.isArray(values)) {
      for (let i = 0; i < info.count; i++) {
        arr[i] = i < values.length ? values[i] : 0;
      }
    } else {
      arr[0] = values;
    }
  }

  writeFloat32(name: string, values: number[]): void {
    const info = this.fieldArrays.get(name);
    if (!info) return;
    const arr = info.array as Float32Array;
    for (let i = 0; i < values.length && i < arr.length; i++) {
      arr[i] = values[i];
    }
  }

  read(): T | null {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const s1 = Atomics.load(this.seqArr, 0);
      if (s1 & 1) continue;

      const data: Record<string, unknown> = {};
      for (const [name, info] of this.fieldArrays) {
        if (info.type === "bool") {
          const arr = info.array as Int32Array;
          data[name] = arr[0] !== 0;
        } else {
          const arr = info.array;
          const copy: number[] = [];
          for (let i = 0; i < info.count; i++) {
            copy.push(arr[i]);
          }
          data[name] = info.count === 1 ? copy[0] : copy;
        }
      }

      const s2 = Atomics.load(this.seqArr, 0);
      if (s1 === s2 && !(s2 & 1)) {
        this.lastReadData = data as T;
        return data as T;
      }
    }

    return this.lastReadData;
  }

  readInto(target: T): boolean {
    const result = this.read();
    if (result === null) return false;
    Object.assign(target, result);
    return true;
  }

  getSequence(): number {
    return Atomics.load(this.seqArr, 0);
  }

  hasChanged(lastSeen: number): boolean {
    return this.getSequence() !== lastSeen;
  }

  getBuffer(): SharedArrayBuffer | ArrayBuffer {
    return this.sab;
  }

  getLayout(): BufferLayout {
    return this.layout;
  }
}
