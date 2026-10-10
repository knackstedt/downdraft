import { describeHeaderValidation, isDebug, warnOnce } from "./errors";
import type { ChannelLayout, HeaderViews, SlotAccessor, SlotViews } from "./types";

function createHeaderViews(sab: SharedArrayBuffer, headerSize: number): HeaderViews {
  const u32Length = headerSize / 4;
  return {
    u32: new Uint32Array(sab, 0, u32Length),
    i32: new Int32Array(sab, 0, u32Length),
    f32: new Float32Array(sab, 0, u32Length),
    f64: new Float64Array(sab, 0, Math.floor(headerSize / 8)),
  };
}

class SlotAccessorImpl implements SlotAccessor {
  private sab: SharedArrayBuffer;
  private cache: (SlotViews | null)[];
  private _maxSlots: number;
  private _slotSize: number;
  private _slotStride: number;
  private _byteOffset: number;
  private sectionName: string;

  constructor(
    sab: SharedArrayBuffer,
    byteOffset: number,
    maxSlots: number,
    slotSize: number,
    slotStride: number,
    sectionName: string,
  ) {
    this.sab = sab;
    this._byteOffset = byteOffset;
    this._maxSlots = maxSlots;
    this._slotSize = slotSize;
    this._slotStride = slotStride;
    this.sectionName = sectionName;
    this.cache = new Array(maxSlots).fill(null);
  }

  get maxSlots(): number { return this._maxSlots; }
  get slotSize(): number { return this._slotSize; }
  get slotStride(): number { return this._slotStride; }
  get byteOffset(): number { return this._byteOffset; }

  slot(index: number): SlotViews {
    if (index < 0 || index >= this._maxSlots) {
      if (isDebug()) {
        warnOnce(
          `slot-oob-${this.sectionName}-${index}`,
          `Slot index ${index} out of range [0, ${this._maxSlots}) for section "${this.sectionName}"`,
        );
      }
      throw new RangeError(`Slot index ${index} out of range [0, ${this._maxSlots}) for section "${this.sectionName}"`);
    }

    let views = this.cache[index];
    if (views) return views;

    const base = this._byteOffset + index * this._slotSize;
    const f32Len = this._slotSize / 4;
    views = {
      f32: new Float32Array(this.sab, base, f32Len),
      u32: new Uint32Array(this.sab, base, f32Len),
      i32: new Int32Array(this.sab, base, f32Len),
      f64: new Float64Array(this.sab, base, Math.floor(this._slotSize / 8)),
    };
    this.cache[index] = views;
    return views;
  }
}

export class SlotReader {
  header: HeaderViews;
  sections: Record<string, SlotAccessor>;
  private seqArr: Int32Array;
  private layout: ChannelLayout;

  constructor(sab: SharedArrayBuffer, layout: ChannelLayout) {
    this.layout = layout;
    this.header = createHeaderViews(sab, layout.header.size);
    this.seqArr = new Int32Array(sab, layout.header.sequenceIndex * 4, 1);

    this.sections = {};
    if (layout.sections) {
      layout.sections.forEach((section) => {
        this.sections[section.name] = new SlotAccessorImpl(
          sab,
          section.byteOffset,
          section.maxSlots,
          section.slotSize,
          section.slotStride,
          section.name,
        );
      });
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
    if (this.layout.sections) {
      this.layout.sections.forEach((section) => {
        const accessor = this.sections[section.name];
        const slots: Record<string, unknown>[] = [];
        const count = this.header.u32[0 + 4];
        for (let i = 0; i < Math.min(count, section.maxSlots); i++) {
          const slot = accessor.slot(i);
          const slotData: Record<string, unknown> = {};
          for (const [fname, flayout] of Object.entries(section.fields)) {
            const view = flayout.type === "f32" || flayout.type === "f64" ? slot.f32 : slot.u32;
            if (flayout.count === 1) {
              slotData[fname] = (view as Float32Array)[flayout.index];
            } else {
              const arr: number[] = [];
              for (let j = 0; j < flayout.count; j++) {
                arr.push((view as Float32Array)[flayout.index + j]);
              }
              slotData[fname] = arr;
            }
          }
          slots.push(slotData);
        }
        data[section.name] = slots;
      });
    }
    return data;
  }
}

export class SlotWriter {
  header: HeaderViews;
  sections: Record<string, SlotAccessor>;
  private seqArr: Int32Array;
  private layout: ChannelLayout;
  /** True while a beginWrite() window is open (sequence is odd). */
  private writeOpen = false;

  constructor(sab: SharedArrayBuffer, layout: ChannelLayout) {
    this.layout = layout;
    this.header = createHeaderViews(sab, layout.header.size);
    this.seqArr = new Int32Array(sab, layout.header.sequenceIndex * 4, 1);

    this.sections = {};
    if (layout.sections) {
      layout.sections.forEach((section) => {
        this.sections[section.name] = new SlotAccessorImpl(
          sab,
          section.byteOffset,
          section.maxSlots,
          section.slotSize,
          section.slotStride,
          section.name,
        );
      });
    }
  }

  init(): void {
    this.header.u32[this.layout.header.magicIndex] = this.layout.magic;
    this.header.u32[this.layout.header.versionIndex] = this.layout.version;
  }

  /**
   * Open a write window — marks the sequence word odd so readers know a
   * publish is in progress. Idempotent: nested/extra calls are free, so
   * mutating accessors can call it unconditionally on every write path.
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
   * Publish a commit. Legacy callers use this without a beginWrite()
   * window: it then steps +2 (even→even) so the sequence always lands on
   * a stable value while still advancing once per publish. Inside a
   * beginWrite() window it closes the window (+1, odd→even).
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
