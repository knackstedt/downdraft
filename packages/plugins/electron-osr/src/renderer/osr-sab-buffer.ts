// ============================================================================
// OSR SAB Ring Buffer — Lock-free single-producer/single-consumer ring buffer
// for transferring decompressed pixel data from a Worker to the main thread.
// ============================================================================
// Layout:
//   [0..3]   WRITE_INDEX (u32 atomic) — worker writes next slot
//   [4..7]   READ_INDEX  (u32 atomic) — main thread reads next slot
//   [8..11]  FRAME_SEQ   (u32 atomic) — incremented per completed frame
//   [12..15] SLOT_SIZE   (u32)         — bytes per slot (max region size)
//   [16..19] SLOT_COUNT  (u32)         — number of slots in the ring
//   [20..23] ACTIVE      (u32 atomic)  — 1 = active, 0 = shutdown
//   [24..63] reserved
//   [64..]   SLOT_DATA   — slot_count * slot_size bytes
//
// Each slot also has a 16-byte metadata header:
//   [0..3]   regionX (u32)
//   [4..7]   regionY (u32)
//   [8..11]  regionW (u32)
//   [12..15] regionH (u32)
// Followed by the raw BGRA pixel data.
// ============================================================================

const HEADER_BYTES = 64;
const SLOT_META_BYTES = 16;

export interface OSRSABRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
  slotIndex: number;
}

export class OSRSABRingBuffer {
  readonly sab: SharedArrayBuffer;
  readonly slotSize: number;
  readonly slotCount: number;
  private readonly i32: Int32Array;
  private readonly dataOffset: number;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.i32 = new Int32Array(sab);
    this.slotSize = Atomics.load(this.i32, 12 / 4) || 0;
    this.slotCount = Atomics.load(this.i32, 16 / 4) || 0;
    this.dataOffset = HEADER_BYTES;
  }

  static allocate(slotSize: number, slotCount: number): SharedArrayBuffer {
    const totalBytes = HEADER_BYTES + slotCount * (SLOT_META_BYTES + slotSize);
    const sab = new SharedArrayBuffer(totalBytes);
    const i32 = new Int32Array(sab);
    i32[12 / 4] = slotSize;
    i32[16 / 4] = slotCount;
    Atomics.store(i32, 20 / 4, 1);
    return sab;
  }

  get totalSlots(): number {
    return this.slotCount;
  }

  get availableSlots(): number {
    const writeIdx = Atomics.load(this.i32, 0);
    const readIdx = Atomics.load(this.i32, 4 / 4);
    return this.slotCount - ((writeIdx - readIdx + this.slotCount) % this.slotCount);
  }

  private slotByteOffset(slotIndex: number): number {
    return this.dataOffset + slotIndex * (SLOT_META_BYTES + this.slotSize);
  }

  writeSlot(slotIndex: number, x: number, y: number, w: number, h: number, data: Uint8Array): void {
    const offset = this.slotByteOffset(slotIndex);
    const u32 = new Uint32Array(this.sab, offset, 4);
    u32[0] = x;
    u32[1] = y;
    u32[2] = w;
    u32[3] = h;
    const dataBytes = new Uint8Array(this.sab, offset + SLOT_META_BYTES, this.slotSize);
    dataBytes.set(data.subarray(0, Math.min(data.length, this.slotSize)));
  }

  readSlot(slotIndex: number): OSRSABRegion | null {
    const offset = this.slotByteOffset(slotIndex);
    const u32 = new Uint32Array(this.sab, offset, 4);
    const x = u32[0];
    const y = u32[1];
    const w = u32[2];
    const h = u32[3];
    if (w === 0 || h === 0) return null;
    const byteLen = w * h * 4;
    const data = new Uint8Array(this.sab, offset + SLOT_META_BYTES, byteLen);
    return { x, y, width: w, height: h, data, slotIndex };
  }

  nextWriteSlot(): number | null {
    const writeIdx = Atomics.load(this.i32, 0);
    const readIdx = Atomics.load(this.i32, 4 / 4);
    const next = (writeIdx + 1) % this.slotCount;
    if (next === readIdx) return null;
    return writeIdx;
  }

  publishSlot(slotIndex: number): void {
    const writeIdx = Atomics.load(this.i32, 0);
    const next = (writeIdx + 1) % this.slotCount;
    Atomics.store(this.i32, 0, next);
    Atomics.add(this.i32, 8 / 4, 1);
    Atomics.notify(this.i32, 8 / 4, 1);
  }

  nextReadSlot(): number | null {
    const writeIdx = Atomics.load(this.i32, 0);
    const readIdx = Atomics.load(this.i32, 4 / 4);
    if (readIdx === writeIdx) return null;
    return readIdx;
  }

  consumeSlot(): void {
    const readIdx = Atomics.load(this.i32, 4 / 4);
    const next = (readIdx + 1) % this.slotCount;
    Atomics.store(this.i32, 4 / 4, next);
  }

  waitForData(timeoutMs: number = 100): boolean {
    const writeIdx = Atomics.load(this.i32, 0);
    const readIdx = Atomics.load(this.i32, 4 / 4);
    if (writeIdx !== readIdx) return true;
    const seq = Atomics.load(this.i32, 8 / 4);
    Atomics.wait(this.i32, 8 / 4, seq, timeoutMs);
    return Atomics.load(this.i32, 0) !== Atomics.load(this.i32, 4 / 4);
  }

  shutdown(): void {
    Atomics.store(this.i32, 20 / 4, 0);
    Atomics.notify(this.i32, 8 / 4, Infinity);
  }

  isAlive(): boolean {
    return Atomics.load(this.i32, 20 / 4) === 1;
  }
}

export { HEADER_BYTES as SAB_HEADER_BYTES, SLOT_META_BYTES as SAB_SLOT_META_BYTES };
