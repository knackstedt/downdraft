import type { ChannelLayout, GridLayerLayout, HeaderViews } from "./types";

function createHeaderViews(sab: SharedArrayBuffer, headerSize: number): HeaderViews {
  const u32Length = headerSize / 4;
  return {
    u32: new Uint32Array(sab, 0, u32Length),
    i32: new Int32Array(sab, 0, u32Length),
    f32: new Float32Array(sab, 0, u32Length),
    f64: new Float64Array(sab, 0, Math.floor(headerSize / 8)),
  };
}

function createLayerView(
  sab: SharedArrayBuffer,
  layer: GridLayerLayout,
): Float32Array | Int32Array | Uint32Array | Float64Array {
  switch (layer.type) {
    case "f32": return new Float32Array(sab, layer.byteOffset, layer.length);
    case "i32": return new Int32Array(sab, layer.byteOffset, layer.length);
    case "u32": return new Uint32Array(sab, layer.byteOffset, layer.length);
    case "bool": return new Uint32Array(sab, layer.byteOffset, layer.length);
    case "f64": return new Float64Array(sab, layer.byteOffset, layer.length);
    default: return new Float32Array(sab, layer.byteOffset, layer.length);
  }
}

export class GridReader {
  header: HeaderViews;
  layers: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
  private seqArr: Int32Array;
  private layout: ChannelLayout;

  constructor(sab: SharedArrayBuffer, layout: ChannelLayout) {
    this.layout = layout;
    this.header = createHeaderViews(sab, layout.header.size);
    this.seqArr = new Int32Array(sab, layout.header.sequenceIndex * 4, 1);

    this.layers = {};
    if (layout.grid) {
      for (const [name, layer] of Object.entries(layout.grid.layers)) {
        this.layers[name] = createLayerView(sab, layer);
      }
    }
  }

  isValid(): boolean {
    return this.header.u32[this.layout.header.magicIndex] === this.layout.magic;
  }

  getSequence(): number {
    return Atomics.load(this.seqArr, 0);
  }

  hasChanged(lastSeen: number): boolean {
    return this.getSequence() !== lastSeen;
  }

  snapshot(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    data["sequence"] = this.getSequence();
    if (this.layout.grid) {
      for (const [name, layer] of Object.entries(this.layout.grid.layers)) {
        const view = this.layers[name];
        const copy: number[] = [];
        for (let i = 0; i < layer.length; i++) {
          copy.push((view as Float32Array)[i]);
        }
        data[name] = copy;
      }
    }
    return data;
  }
}

export class GridWriter {
  header: HeaderViews;
  layers: Record<string, Float32Array | Int32Array | Uint32Array | Float64Array>;
  private seqArr: Int32Array;
  private layout: ChannelLayout;

  constructor(sab: SharedArrayBuffer, layout: ChannelLayout) {
    this.layout = layout;
    this.header = createHeaderViews(sab, layout.header.size);
    this.seqArr = new Int32Array(sab, layout.header.sequenceIndex * 4, 1);

    this.layers = {};
    if (layout.grid) {
      for (const [name, layer] of Object.entries(layout.grid.layers)) {
        this.layers[name] = createLayerView(sab, layer);
      }
    }
  }

  init(): void {
    this.header.u32[this.layout.header.magicIndex] = this.layout.magic;
    this.header.u32[this.layout.header.versionIndex] = this.layout.version;
  }

  bumpSequence(): void {
    Atomics.add(this.seqArr, 0, 1);
  }

  getSequence(): number {
    return Atomics.load(this.seqArr, 0);
  }
}
