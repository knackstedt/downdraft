import { describeHeaderValidation } from "./errors";
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
    return this.validationError() === null;
  }

  validationError(): string | null {
    return describeHeaderValidation(
      this.header.u32,
      this.layout.header.magicIndex,
      this.layout.header.versionIndex,
      this.layout.magic,
      this.layout.version,
    );
  }

  getSequence(): number {
    return Atomics.load(this.seqArr, 0);
  }

  hasChanged(lastSeen: number): boolean {
    return this.getSequence() !== lastSeen;
  }

  /**
   * True while the writer holds an open write window (sequence is odd).
   * Readers can use this to cheaply defer sync work past a publish.
   */
  isWriteInProgress(): boolean {
    return (Atomics.load(this.seqArr, 0) & 1) !== 0;
  }

  /**
   * Run `fn` against a consistent snapshot of the channel. The sequence
   * word is a seqlock: odd while the writer is publishing, even when the
   * data is stable. The read is retried while the word is odd or changes
   * mid-read; after maxRetries it returns whatever the last attempt read
   * rather than starving the reader (writers publish every tick).
   */
  readConsistent<T>(fn: () => T, maxRetries = 64): T {
    for (let i = 0; i < maxRetries; i++) {
      const s1 = Atomics.load(this.seqArr, 0);
      if ((s1 & 1) === 0) {
        const out = fn();
        if (Atomics.load(this.seqArr, 0) === s1) return out;
      }
    }
    return fn();
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
  /** True while a beginWrite() window is open (sequence is odd). */
  private writeOpen = false;

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

  /**
   * Open a write window — marks the sequence word odd so readers know a
   * publish is in progress. Idempotent so mutating paths can call it
   * unconditionally.
   */
  beginWrite(): void {
    if (this.writeOpen) return;
    this.writeOpen = true;
    Atomics.add(this.seqArr, 0, 1);
  }

  /** Close the write window opened by beginWrite() — sequence back to even. */
  endWrite(): void {
    if (!this.writeOpen) return;
    this.writeOpen = false;
    Atomics.add(this.seqArr, 0, 1);
  }

  /**
   * Publish a commit. Without an open write window it steps +2 (even→even)
   * so the sequence always lands on a stable value while still advancing
   * once per publish; inside a window it closes it (+1, odd→even).
   */
  bumpSequence(): void {
    const step = this.writeOpen ? 1 : 2;
    this.writeOpen = false;
    Atomics.add(this.seqArr, 0, step);
  }

  getSequence(): number {
    return Atomics.load(this.seqArr, 0);
  }
}
