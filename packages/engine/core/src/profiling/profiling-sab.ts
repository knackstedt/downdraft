// ============================================================================
// ProfilingSAB — SharedArrayBuffer layout for the in-game profiling system.
//
// One global SAB allocated by the renderer, shared to all workers + the
// pixi-ui overlay worker. Contains:
//   - Header (magic, version, counts, global tick, warning seq)
//   - Slot table (per-worker metadata)
//   - Per-slot regions (ThreadMetrics + EventLoop block + IOPS ring + string table)
//   - Global warning ring (worker-fired warnings)
//
// All multi-byte fields use little-endian. Ring buffers use atomic head/count
// via Atomics for lock-free single-producer (worker) / single-consumer (reader).
// ============================================================================

/** Maximum number of worker slots in the SAB. */
export const PROFILING_MAX_SLOTS = 32;
/** IOPS ring buffer capacity per slot. */
export const PROFILING_IOPS_RING_CAP = 256;
/** Warning ring buffer capacity (global). */
export const PROFILING_WARNING_RING_CAP = 128;
/** String table capacity per slot (entries). */
export const PROFILING_STRING_TABLE_CAP = 64;
/** Max string length per interned tag (chars). */
export const PROFILING_STRING_MAX_LEN = 128;

/** Runtime type tag. */
export const RUNTIME_JS = 0;
export const RUNTIME_QUICKJS = 1;
export const RUNTIME_WASM = 2;
export type RuntimeKind = typeof RUNTIME_JS | typeof RUNTIME_QUICKJS | typeof RUNTIME_WASM;

/** IOPS storage type. */
export const STORE_OPFS = 0;
export const STORE_IDB = 1;

/** Warning severity levels. */
export const SEVERITY_INFO = 0;
export const SEVERITY_WARN = 1;
export const SEVERITY_ERROR = 2;
export const SEVERITY_CRITICAL = 3;
export type SeverityLevel = typeof SEVERITY_INFO | typeof SEVERITY_WARN | typeof SEVERITY_ERROR | typeof SEVERITY_CRITICAL;

/** Metric kinds for warning records. */
export const METRIC_TICK_LATENCY = 0;
export const METRIC_TASK_LATENCY = 1;
export const METRIC_IOPS_LATENCY = 2;
export const METRIC_HEAP_USAGE = 3;
export const METRIC_HEAP_PERCENT = 4;
export const METRIC_CPU_PERCENT = 5;
export const METRIC_GC_PAUSE = 6;
export const METRIC_RAF_JITTER = 7;
export const METRIC_LONGTASK = 8;
export const METRIC_GPU_TIME = 9;
export const METRIC_CUSTOM = 10;

// ─── Sizes (bytes) ──────────────────────────────────────────────────────────

const U32 = 4;
const F32 = 4;
const U16 = 2;
const U8 = 1;

/** Header size — 32 bytes. */
export const HEADER_SIZE = 32;

/** SlotHeader size — 24 bytes (6 × u32). */
export const SLOT_HEADER_SIZE = 6 * U32;

/** ThreadMetrics block size — 15 fields, 60 bytes. */
export const THREAD_METRICS_SIZE = 15 * U32; // all u32/f32 = 4 bytes each

/** EventLoop block size — 9 fields, 36 bytes. */
export const EVENT_LOOP_SIZE = 9 * U32;

/** IopsRecord size — 22 bytes, padded to 24 for alignment. */
export const IOPS_RECORD_SIZE = 24;

/** WarningRecord size — 20 bytes, padded to 24 for alignment. */
export const WARNING_RECORD_SIZE = 24;

/** String table entry: hash(u32) + len(u16) + chars (up to 128 × 2 bytes).
 * Padded to 4-byte alignment for correct Uint32Array indexing. */
export const STRING_ENTRY_SIZE = Math.ceil((U32 + U16 + PROFILING_STRING_MAX_LEN * 2) / 4) * 4; // 262 → 264

// ─── Header field offsets ───────────────────────────────────────────────────

export const HDR = {
  MAGIC: 0,           // u32 — 0x50524f46 ("PROF")
  VERSION: 1,         // u32
  MAX_SLOTS: 2,       // u32
  ACTIVE_SLOTS: 3,    // u32
  EPOCH: 4,           // u32 — bumped when slot table changes
  GLOBAL_TICK: 5,     // u32 — incremented each frame by renderer
  WARNING_SEQ: 6,     // u32 — bumped when a new warning is pushed
  PADDING: 7,         // u32 — reserved
} as const;

export const PROFILING_MAGIC = 0x50524f46;
export const PROFILING_VERSION = 1;

// ─── SlotHeader field offsets (relative to slot table start + slotIndex * SLOT_HEADER_SIZE) ──

export const SH = {
  WORKER_TAG: 0,    // u32 — interned worker tag hash
  RUNTIME: 1,       // u32 — RuntimeKind
  SLOT_INDEX: 2,    // u32 — this slot's index
  NAME_OFFSET: 3,   // u32 — offset into the slot's string table for the worker name
  NAME_LEN: 4,      // u32 — length of the worker name
  ALIVE: 5,         // u32 — 0 = free, 1 = claimed (atomic CAS)
} as const;

// ─── ThreadMetrics field offsets (relative to slot region metrics start) ────

export const TM = {
  HEAP_USED: 0,        // u32 — bytes
  HEAP_TOTAL: 1,       // u32 — bytes
  RSS: 2,              // u32 — bytes
  CPU_TIME_MS: 3,      // f32 — ms
  CPU_PERCENT: 4,      // f32 — %
  GC_PAUSE_TOTAL: 5,   // u32 — us
  GC_PAUSE_COUNT: 6,   // u32
  GC_PAUSE_MAX: 7,     // u32 — us
  TICK: 8,             // u32 — tick counter
  TASK_COUNT: 9,       // u32
  TASK_LATENCY_P50: 10, // f32 — us
  TASK_LATENCY_P95: 11, // f32 — us
  TASK_LATENCY_P99: 12, // f32 — us
  TASK_LATENCY_MAX: 13, // u32 — us
  LAST_UPDATE_MS: 14,   // f32 — performance.now() at last write
} as const;

// ─── EventLoop block field offsets (relative to slot region event-loop start) ──

export const EL = {
  RAF_JITTER_P50: 0,    // f32 — us
  RAF_JITTER_P95: 1,    // f32 — us
  RAF_JITTER_MAX: 2,    // u32 — us
  LONGTASK_COUNT: 3,    // u32
  LONGTASK_TOTAL_MS: 4, // u32 — ms
  LONGTASK_MAX_MS: 5,   // u32 — ms
  IDLE_HEADROOM_MS: 6,  // u32 — ms
  EXPECTED_FRAME_MS: 7, // f32 — ms
  LAST_UPDATE_MS: 8,    // f32 — performance.now() at last write
} as const;

// ─── IopsRecord field offsets (relative to ring entry start) ────────────────

export const IR = {
  OP_KIND: 0,        // u16
  STORE: 2,          // u8
  _PAD: 3,           // u8
  TAG_HASH: 4,       // u32
  BYTES: 8,          // u32
  LATENCY_US: 12,    // u32
  TS: 16,            // u32 — performance.now() truncated to u32
  WORKER_TAG: 20,    // u32
} as const;

// ─── IOPS ring control (head + count atomics, at the start of the IOPS region) ──

export const IOPS_CTRL = {
  HEAD: 0,   // u32 — atomic write index
  COUNT: 1,  // u32 — atomic number of entries
} as const;
const IOPS_CTRL_SIZE = 2 * U32;

// ─── WarningRecord field offsets (relative to warning ring entry start) ─────

export const WR = {
  RULE_ID_HASH: 0,    // u32
  SEVERITY: 4,        // u8
  METRIC_KIND: 5,     // u8
  _PAD: 6,            // u16
  VALUE: 8,           // f32
  THRESHOLD: 12,      // f32
  WORKER_TAG: 16,     // u32
  TS: 20,             // u32
  // byte 23: autoTraceFired is packed into the high bit of TS for compactness
} as const;

// ─── Warning ring control (global, after all slot regions) ──────────────────

export const WARN_CTRL = {
  HEAD: 0,   // u32 — atomic write index
  COUNT: 1,  // u32 — atomic number of entries
  SEQ: 2,    // u32 — atomic sequence (also mirrored in header WARNING_SEQ)
} as const;
const WARN_CTRL_SIZE = 3 * U32;

// ─── String table control (per slot, at the start of the string-table region) ──

export const STR_CTRL = {
  HEAD: 0,   // u32 — next write index (entry count)
  COUNT: 1,  // u32 — number of entries
} as const;
const STR_CTRL_SIZE = 2 * U32;

// ─── Layout computation ─────────────────────────────────────────────────────

export interface ProfilingSABLayout {
  byteLength: number;
  headerOffset: number;
  slotTableOffset: number;
  slotRegionSize: number;
  /** Offset of a slot's region from the buffer start. */
  slotRegionOffset: (slotIndex: number) => number;
  /** Offset of a slot's ThreadMetrics block from the buffer start. */
  metricsOffset: (slotIndex: number) => number;
  /** Offset of a slot's EventLoop block from the buffer start. */
  eventLoopOffset: (slotIndex: number) => number;
  /** Offset of a slot's IOPS ring control from the buffer start. */
  iopsCtrlOffset: (slotIndex: number) => number;
  /** Offset of a slot's IOPS ring data (first entry) from the buffer start. */
  iopsDataOffset: (slotIndex: number) => number;
  /** Offset of a slot's string table control from the buffer start. */
  strCtrlOffset: (slotIndex: number) => number;
  /** Offset of a slot's string table data (first entry) from the buffer start. */
  strDataOffset: (slotIndex: number) => number;
  /** Offset of the global warning ring control from the buffer start. */
  warnCtrlOffset: number;
  /** Offset of the global warning ring data (first entry) from the buffer start. */
  warnDataOffset: number;
  maxSlots: number;
  iopsRingCap: number;
  warningRingCap: number;
  stringTableCap: number;
}

/**
 * Compute the byte layout of the ProfilingSAB.
 * The layout is deterministic given the capacity parameters.
 */
export function computeProfilingSABLayout(
  maxSlots: number = PROFILING_MAX_SLOTS,
  iopsRingCap: number = PROFILING_IOPS_RING_CAP,
  warningRingCap: number = PROFILING_WARNING_RING_CAP,
  stringTableCap: number = PROFILING_STRING_TABLE_CAP,
): ProfilingSABLayout {
  const headerOffset = 0;
  const slotTableOffset = HEADER_SIZE;
  const slotTableSize = maxSlots * SLOT_HEADER_SIZE;

  // Each slot region: metrics + event-loop + IOPS (ctrl + data) + string table (ctrl + data)
  const slotRegionSize =
    THREAD_METRICS_SIZE +
    EVENT_LOOP_SIZE +
    IOPS_CTRL_SIZE +
    iopsRingCap * IOPS_RECORD_SIZE +
    STR_CTRL_SIZE +
    stringTableCap * STRING_ENTRY_SIZE;

  const slotRegionsStart = slotTableOffset + slotTableSize;

  const slotRegionOffset = (si: number) => slotRegionsStart + si * slotRegionSize;
  const metricsOffset = (si: number) => slotRegionOffset(si);
  const eventLoopOffset = (si: number) => slotRegionOffset(si) + THREAD_METRICS_SIZE;
  const iopsCtrlOffset = (si: number) => slotRegionOffset(si) + THREAD_METRICS_SIZE + EVENT_LOOP_SIZE;
  const iopsDataOffset = (si: number) => iopsCtrlOffset(si) + IOPS_CTRL_SIZE;
  const strCtrlOffset = (si: number) =>
    iopsDataOffset(si) + iopsRingCap * IOPS_RECORD_SIZE;
  const strDataOffset = (si: number) => strCtrlOffset(si) + STR_CTRL_SIZE;

  const warnCtrlOffset = slotRegionsStart + maxSlots * slotRegionSize;
  const warnDataOffset = warnCtrlOffset + WARN_CTRL_SIZE;
  const byteLength = warnDataOffset + warningRingCap * WARNING_RECORD_SIZE;

  return {
    byteLength,
    headerOffset,
    slotTableOffset,
    slotRegionSize,
    slotRegionOffset,
    metricsOffset,
    eventLoopOffset,
    iopsCtrlOffset,
    iopsDataOffset,
    strCtrlOffset,
    strDataOffset,
    warnCtrlOffset,
    warnDataOffset,
    maxSlots,
    iopsRingCap,
    warningRingCap,
    stringTableCap,
  };
}

/**
 * Allocate a new ProfilingSAB and initialize the header.
 * Returns the SharedArrayBuffer + its layout.
 */
export function allocateProfilingSAB(
  maxSlots: number = PROFILING_MAX_SLOTS,
  iopsRingCap: number = PROFILING_IOPS_RING_CAP,
  warningRingCap: number = PROFILING_WARNING_RING_CAP,
  stringTableCap: number = PROFILING_STRING_TABLE_CAP,
): { sab: SharedArrayBuffer; layout: ProfilingSABLayout } {
  const layout = computeProfilingSABLayout(maxSlots, iopsRingCap, warningRingCap, stringTableCap);
  const sab = new SharedArrayBuffer(layout.byteLength);
  const view = new Uint32Array(sab);

  // Initialize header
  view[HDR.MAGIC] = PROFILING_MAGIC;
  view[HDR.VERSION] = PROFILING_VERSION;
  view[HDR.MAX_SLOTS] = maxSlots;
  view[HDR.ACTIVE_SLOTS] = 0;
  view[HDR.EPOCH] = 0;
  view[HDR.GLOBAL_TICK] = 0;
  view[HDR.WARNING_SEQ] = 0;

  // Initialize slot table — all slots free (alive = 0)
  for (let i = 0; i < maxSlots; i++) {
    const base = (layout.slotTableOffset / U32) + i * (SLOT_HEADER_SIZE / U32);
    view[base + SH.WORKER_TAG] = 0;
    view[base + SH.RUNTIME] = RUNTIME_JS;
    view[base + SH.SLOT_INDEX] = i;
    view[base + SH.NAME_OFFSET] = 0;
    view[base + SH.NAME_LEN] = 0;
    view[base + SH.ALIVE] = 0;
  }

  return { sab, layout };
}

// ─── ProfilingSABWriter (worker side) ───────────────────────────────────────

/**
 * Writer for a single worker slot. Each worker claims a slot via claimSlot()
 * then uses the writer to update metrics, push IOPS records, and intern tags.
 */
export class ProfilingSABWriter {
  private u32: Uint32Array;
  private f32: Float32Array;
  private u16: Uint16Array;
  private u8: Uint8Array;
  private layout: ProfilingSABLayout;
  private slotIndex: number;

  constructor(sab: SharedArrayBuffer, layout: ProfilingSABLayout, slotIndex: number) {
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.u16 = new Uint16Array(sab);
    this.u8 = new Uint8Array(sab);
    this.layout = layout;
    this.slotIndex = slotIndex;
  }

  getSlotIndex(): number {
    return this.slotIndex;
  }

  /** Write the ThreadMetrics block for this slot. */
  writeThreadMetrics(m: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    cpuTimeMs: number;
    cpuPercent: number;
    gcPauseTotalUs: number;
    gcPauseCount: number;
    gcPauseMaxUs: number;
    tick: number;
    taskCount: number;
    taskLatencyP50Us: number;
    taskLatencyP95Us: number;
    taskLatencyP99Us: number;
    taskLatencyMaxUs: number;
  }): void {
    const base = this.layout.metricsOffset(this.slotIndex) / U32;
    this.u32[base + TM.HEAP_USED] = m.heapUsed;
    this.u32[base + TM.HEAP_TOTAL] = m.heapTotal;
    this.u32[base + TM.RSS] = m.rss;
    this.f32[base + TM.CPU_TIME_MS] = m.cpuTimeMs;
    this.f32[base + TM.CPU_PERCENT] = m.cpuPercent;
    this.u32[base + TM.GC_PAUSE_TOTAL] = m.gcPauseTotalUs;
    this.u32[base + TM.GC_PAUSE_COUNT] = m.gcPauseCount;
    this.u32[base + TM.GC_PAUSE_MAX] = m.gcPauseMaxUs;
    this.u32[base + TM.TICK] = m.tick;
    this.u32[base + TM.TASK_COUNT] = m.taskCount;
    this.f32[base + TM.TASK_LATENCY_P50] = m.taskLatencyP50Us;
    this.f32[base + TM.TASK_LATENCY_P95] = m.taskLatencyP95Us;
    this.f32[base + TM.TASK_LATENCY_P99] = m.taskLatencyP99Us;
    this.u32[base + TM.TASK_LATENCY_MAX] = m.taskLatencyMaxUs;
    this.f32[base + TM.LAST_UPDATE_MS] = performance.now();
  }

  /** Write the EventLoop block for this slot. */
  writeEventLoop(e: {
    rafJitterP50Us: number;
    rafJitterP95Us: number;
    rafJitterMaxUs: number;
    longtaskCount: number;
    longtaskTotalMs: number;
    longtaskMaxMs: number;
    idleHeadroomMs: number;
    expectedFrameMs: number;
  }): void {
    const base = this.layout.eventLoopOffset(this.slotIndex) / U32;
    this.f32[base + EL.RAF_JITTER_P50] = e.rafJitterP50Us;
    this.f32[base + EL.RAF_JITTER_P95] = e.rafJitterP95Us;
    this.u32[base + EL.RAF_JITTER_MAX] = e.rafJitterMaxUs;
    this.u32[base + EL.LONGTASK_COUNT] = e.longtaskCount;
    this.u32[base + EL.LONGTASK_TOTAL_MS] = e.longtaskTotalMs;
    this.u32[base + EL.LONGTASK_MAX_MS] = e.longtaskMaxMs;
    this.u32[base + EL.IDLE_HEADROOM_MS] = e.idleHeadroomMs;
    this.f32[base + EL.EXPECTED_FRAME_MS] = e.expectedFrameMs;
    this.f32[base + EL.LAST_UPDATE_MS] = performance.now();
  }

  /**
   * Push an IOPS record to this slot's ring buffer.
   * Lock-free: uses Atomics on head/count. If the ring is full, the oldest
   * entry is overwritten (the consumer must handle this).
   */
  pushIopsRecord(rec: {
    opKind: number;
    store: number;
    tagHash: number;
    bytes: number;
    latencyUs: number;
    ts: number;
    workerTag: number;
  }): void {
    const ctrlBase = this.layout.iopsCtrlOffset(this.slotIndex) / U32;
    const cap = this.layout.iopsRingCap;
    const head = Atomics.add(this.u32, ctrlBase + IOPS_CTRL.HEAD, 1) % cap;
    // Increment count up to cap
    const curCount = Atomics.load(this.u32, ctrlBase + IOPS_CTRL.COUNT);
    if (curCount < cap) {
      Atomics.add(this.u32, ctrlBase + IOPS_CTRL.COUNT, 1);
    }
    const entryBase = this.layout.iopsDataOffset(this.slotIndex) + head * IOPS_RECORD_SIZE;
    this.u16[entryBase / U16 + IR.OP_KIND / U16] = rec.opKind;
    this.u8[entryBase + IR.STORE] = rec.store;
    this.u32[(entryBase + IR.TAG_HASH) / U32] = rec.tagHash;
    this.u32[(entryBase + IR.BYTES) / U32] = rec.bytes;
    this.u32[(entryBase + IR.LATENCY_US) / U32] = rec.latencyUs;
    this.u32[(entryBase + IR.TS) / U32] = rec.ts;
    this.u32[(entryBase + IR.WORKER_TAG) / U32] = rec.workerTag;
  }

  /**
   * Intern a string tag into this slot's string table.
   * Returns the hash of the string (used as tagHash in IOPS records).
   * If the string is already in the table, returns its existing hash.
   * Uses FNV-1a hashing for compact, collision-resistant 32-bit hashes.
   */
  internTag(str: string): number {
    const hash = fnv1a32(str);
    // Check if already interned
    const ctrlBase = this.layout.strCtrlOffset(this.slotIndex) / U32;
    const count = Atomics.load(this.u32, ctrlBase + STR_CTRL.COUNT);
    const dataBase = this.layout.strDataOffset(this.slotIndex);
    for (let i = 0; i < count; i++) {
      const entryBase = dataBase + i * STRING_ENTRY_SIZE;
      const existingHash = this.u32[entryBase / U32];
      if (existingHash === hash) return hash;
    }
    // Add new entry
    const idx = Atomics.add(this.u32, ctrlBase + STR_CTRL.HEAD, 1);
    if (idx >= this.layout.stringTableCap) {
      // Table full — return hash anyway (reader won't resolve, but record is still useful)
      return hash;
    }
    Atomics.add(this.u32, ctrlBase + STR_CTRL.COUNT, 1);
    const entryBase = dataBase + idx * STRING_ENTRY_SIZE;
    this.u32[entryBase / U32] = hash;
    const chars = str.slice(0, PROFILING_STRING_MAX_LEN);
    this.u16[(entryBase + U32) / U16] = chars.length;
    // Write UTF-16 chars directly (matches JS string internal encoding)
    for (let i = 0; i < chars.length; i++) {
      this.u16[(entryBase + U32 + U16) / U16 + i] = chars.charCodeAt(i);
    }
    return hash;
  }

  /**
   * Push a warning record to the global warning ring.
   * Called from any worker or the renderer.
   */
  pushWarningRecord(rec: {
    ruleIdHash: number;
    severity: number;
    metricKind: number;
    value: number;
    threshold: number;
    workerTag: number;
    ts: number;
    autoTraceFired: boolean;
  }): void {
    const ctrlBase = this.layout.warnCtrlOffset / U32;
    const cap = this.layout.warningRingCap;
    const head = Atomics.add(this.u32, ctrlBase + WARN_CTRL.HEAD, 1) % cap;
    const curCount = Atomics.load(this.u32, ctrlBase + WARN_CTRL.COUNT);
    if (curCount < cap) {
      Atomics.add(this.u32, ctrlBase + WARN_CTRL.COUNT, 1);
    }
    // Bump the sequence number
    Atomics.add(this.u32, ctrlBase + WARN_CTRL.SEQ, 1);
    // Also bump the header's WARNING_SEQ for fast polling
    Atomics.add(this.u32, HDR.WARNING_SEQ, 1);

    const entryBase = this.layout.warnDataOffset + head * WARNING_RECORD_SIZE;
    this.u32[(entryBase + WR.RULE_ID_HASH) / U32] = rec.ruleIdHash;
    this.u8[entryBase + WR.SEVERITY] = rec.severity;
    this.u8[entryBase + WR.METRIC_KIND] = rec.metricKind;
    this.f32[(entryBase + WR.VALUE) / U32] = rec.value;
    this.f32[(entryBase + WR.THRESHOLD) / U32] = rec.threshold;
    this.u32[(entryBase + WR.WORKER_TAG) / U32] = rec.workerTag;
    // Pack autoTraceFired into the high bit of TS
    const ts = (rec.ts & 0x7fffffff) | (rec.autoTraceFired ? 0x80000000 : 0);
    this.u32[(entryBase + WR.TS) / U32] = ts;
  }
}

// ─── Slot claiming (worker side) ────────────────────────────────────────────

/**
 * Attempt to claim a free slot in the SAB.
 * Uses atomic CAS on the slot's ALIVE field. Returns the slot index or -1
 * if all slots are taken.
 */
export function claimSlot(
  sab: SharedArrayBuffer,
  layout: ProfilingSABLayout,
  workerTagHash: number,
  runtime: RuntimeKind,
  name: string,
): number {
  const u32 = new Uint32Array(sab);
  const u16 = new Uint16Array(sab);
  for (let i = 0; i < layout.maxSlots; i++) {
    const base = (layout.slotTableOffset / U32) + i * (SLOT_HEADER_SIZE / U32);
    const expected = 0;
    const got = Atomics.compareExchange(u32, base + SH.ALIVE, expected, 1);
    if (got === expected) {
      // Claimed! Fill in the slot header.
      u32[base + SH.WORKER_TAG] = workerTagHash;
      u32[base + SH.RUNTIME] = runtime;
      u32[base + SH.SLOT_INDEX] = i;
      // Write the name into the slot's string table (first entry)
      const strDataBase = layout.strDataOffset(i);
      const nameHash = fnv1a32(name);
      u32[strDataBase / U32] = nameHash;
      const chars = name.slice(0, PROFILING_STRING_MAX_LEN);
      u16[(strDataBase + U32) / U16] = chars.length;
      for (let j = 0; j < chars.length; j++) {
        u16[(strDataBase + U32 + U16) / U16 + j] = chars.charCodeAt(j);
      }
      u32[base + SH.NAME_OFFSET] = 0; // name is at string table index 0
      u32[base + SH.NAME_LEN] = chars.length;
      // Set string table count to 1
      const strCtrlBase = layout.strCtrlOffset(i) / U32;
      Atomics.store(u32, strCtrlBase + STR_CTRL.HEAD, 1);
      Atomics.store(u32, strCtrlBase + STR_CTRL.COUNT, 1);
      // Bump epoch + active slots
      Atomics.add(u32, HDR.EPOCH, 1);
      Atomics.add(u32, HDR.ACTIVE_SLOTS, 1);
      return i;
    }
  }
  return -1;
}

/** Release a slot (mark it as free). Called on worker shutdown. */
export function releaseSlot(sab: SharedArrayBuffer, layout: ProfilingSABLayout, slotIndex: number): void {
  const u32 = new Uint32Array(sab);
  const base = (layout.slotTableOffset / U32) + slotIndex * (SLOT_HEADER_SIZE / U32);
  Atomics.store(u32, base + SH.ALIVE, 0);
  Atomics.add(u32, HDR.EPOCH, 1);
  Atomics.sub(u32, HDR.ACTIVE_SLOTS, 1);
}

// ─── ProfilingSABReader (renderer / pixi-ui side) ───────────────────────────

export interface SlotSnapshot {
  slotIndex: number;
  alive: boolean;
  workerTag: number;
  runtime: RuntimeKind;
  name: string;
  metrics: ThreadMetricsSnapshot;
  eventLoop: EventLoopSnapshot;
  iopsRecords: IopsRecordSnapshot[];
  tagTable: Map<number, string>;
}

export interface ThreadMetricsSnapshot {
  heapUsed: number;
  heapTotal: number;
  rss: number;
  cpuTimeMs: number;
  cpuPercent: number;
  gcPauseTotalUs: number;
  gcPauseCount: number;
  gcPauseMaxUs: number;
  tick: number;
  taskCount: number;
  taskLatencyP50Us: number;
  taskLatencyP95Us: number;
  taskLatencyP99Us: number;
  taskLatencyMaxUs: number;
  lastUpdateMs: number;
}

export interface EventLoopSnapshot {
  rafJitterP50Us: number;
  rafJitterP95Us: number;
  rafJitterMaxUs: number;
  longtaskCount: number;
  longtaskTotalMs: number;
  longtaskMaxMs: number;
  idleHeadroomMs: number;
  expectedFrameMs: number;
  lastUpdateMs: number;
}

export interface IopsRecordSnapshot {
  opKind: number;
  store: number;
  tagHash: number;
  bytes: number;
  latencyUs: number;
  ts: number;
  workerTag: number;
}

export interface WarningRecordSnapshot {
  ruleIdHash: number;
  severity: number;
  metricKind: number;
  value: number;
  threshold: number;
  workerTag: number;
  ts: number;
  autoTraceFired: boolean;
}

export interface ProfilingSnapshot {
  slots: SlotSnapshot[];
  warnings: WarningRecordSnapshot[];
  globalTick: number;
  warningSeq: number;
}

/**
 * Reader for the ProfilingSAB. Used by the renderer's ProfilingBridge and
 * the pixi-ui overlay scene to read all slots + drain the warning ring.
 */
export class ProfilingSABReader {
  private u32: Uint32Array;
  private f32: Float32Array;
  private u16: Uint16Array;
  private u8: Uint8Array;
  private layout: ProfilingSABLayout;
  private lastWarningCount: number = 0;

  constructor(sab: SharedArrayBuffer, layout: ProfilingSABLayout) {
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
    this.u16 = new Uint16Array(sab);
    this.u8 = new Uint8Array(sab);
    this.layout = layout;
  }

  getLayout(): ProfilingSABLayout {
    return this.layout;
  }

  /** Read a full snapshot of all alive slots + new warnings. */
  readSnapshot(): ProfilingSnapshot {
    const slots: SlotSnapshot[] = [];
    for (let i = 0; i < this.layout.maxSlots; i++) {
      const base = (this.layout.slotTableOffset / U32) + i * (SLOT_HEADER_SIZE / U32);
      const alive = Atomics.load(this.u32, base + SH.ALIVE) === 1;
      if (!alive) continue;
      const workerTag = this.u32[base + SH.WORKER_TAG];
      const runtime = this.u32[base + SH.RUNTIME] as RuntimeKind;
      const name = this.readSlotName(i);
      const metrics = this.readMetrics(i);
      const eventLoop = this.readEventLoop(i);
      const iopsRecords = this.drainIops(i);
      const tagTable = this.readTagTable(i);
      slots.push({ slotIndex: i, alive, workerTag, runtime, name, metrics, eventLoop, iopsRecords, tagTable });
    }
    const warnings = this.drainWarnings();
    const globalTick = Atomics.load(this.u32, HDR.GLOBAL_TICK);
    const warningSeq = Atomics.load(this.u32, HDR.WARNING_SEQ);
    return { slots, warnings, globalTick, warningSeq };
  }

  /** Increment the global tick counter (renderer calls this each frame). */
  bumpGlobalTick(): void {
    Atomics.add(this.u32, HDR.GLOBAL_TICK, 1);
  }

  private readSlotName(slotIndex: number): string {
    const base = (this.layout.slotTableOffset / U32) + slotIndex * (SLOT_HEADER_SIZE / U32);
    const nameLen = this.u32[base + SH.NAME_LEN];
    if (nameLen === 0) return "";
    const strDataBase = this.layout.strDataOffset(slotIndex);
    let s = "";
    for (let j = 0; j < nameLen; j++) {
      s += String.fromCharCode(this.u16[(strDataBase + U32 + U16) / U16 + j]);
    }
    return s;
  }

  private readMetrics(slotIndex: number): ThreadMetricsSnapshot {
    const base = this.layout.metricsOffset(slotIndex) / U32;
    return {
      heapUsed: this.u32[base + TM.HEAP_USED],
      heapTotal: this.u32[base + TM.HEAP_TOTAL],
      rss: this.u32[base + TM.RSS],
      cpuTimeMs: this.f32[base + TM.CPU_TIME_MS],
      cpuPercent: this.f32[base + TM.CPU_PERCENT],
      gcPauseTotalUs: this.u32[base + TM.GC_PAUSE_TOTAL],
      gcPauseCount: this.u32[base + TM.GC_PAUSE_COUNT],
      gcPauseMaxUs: this.u32[base + TM.GC_PAUSE_MAX],
      tick: this.u32[base + TM.TICK],
      taskCount: this.u32[base + TM.TASK_COUNT],
      taskLatencyP50Us: this.f32[base + TM.TASK_LATENCY_P50],
      taskLatencyP95Us: this.f32[base + TM.TASK_LATENCY_P95],
      taskLatencyP99Us: this.f32[base + TM.TASK_LATENCY_P99],
      taskLatencyMaxUs: this.u32[base + TM.TASK_LATENCY_MAX],
      lastUpdateMs: this.f32[base + TM.LAST_UPDATE_MS],
    };
  }

  private readEventLoop(slotIndex: number): EventLoopSnapshot {
    const base = this.layout.eventLoopOffset(slotIndex) / U32;
    return {
      rafJitterP50Us: this.f32[base + EL.RAF_JITTER_P50],
      rafJitterP95Us: this.f32[base + EL.RAF_JITTER_P95],
      rafJitterMaxUs: this.u32[base + EL.RAF_JITTER_MAX],
      longtaskCount: this.u32[base + EL.LONGTASK_COUNT],
      longtaskTotalMs: this.u32[base + EL.LONGTASK_TOTAL_MS],
      longtaskMaxMs: this.u32[base + EL.LONGTASK_MAX_MS],
      idleHeadroomMs: this.u32[base + EL.IDLE_HEADROOM_MS],
      expectedFrameMs: this.f32[base + EL.EXPECTED_FRAME_MS],
      lastUpdateMs: this.f32[base + EL.LAST_UPDATE_MS],
    };
  }

  /**
   * Drain IOPS records from a slot's ring.
   * Returns all available records and resets the count to 0.
   * The head continues to advance (we read from 0..count).
   */
  private drainIops(slotIndex: number): IopsRecordSnapshot[] {
    const ctrlBase = this.layout.iopsCtrlOffset(slotIndex) / U32;
    const count = Atomics.load(this.u32, ctrlBase + IOPS_CTRL.COUNT);
    if (count === 0) return [];
    const cap = this.layout.iopsRingCap;
    const head = Atomics.load(this.u32, ctrlBase + IOPS_CTRL.HEAD);
    // Read the last `count` entries (they wrap around the ring)
    const records: IopsRecordSnapshot[] = [];
    const readCount = Math.min(count, cap);
    for (let i = 0; i < readCount; i++) {
      // Most recent entries are at (head - 1 - i) mod cap
      const idx = (head - 1 - i + cap * 2) % cap;
      const entryBase = this.layout.iopsDataOffset(slotIndex) + idx * IOPS_RECORD_SIZE;
      records.push({
        opKind: this.u16[entryBase / U16 + IR.OP_KIND / U16],
        store: this.u8[entryBase + IR.STORE],
        tagHash: this.u32[(entryBase + IR.TAG_HASH) / U32],
        bytes: this.u32[(entryBase + IR.BYTES) / U32],
        latencyUs: this.u32[(entryBase + IR.LATENCY_US) / U32],
        ts: this.u32[(entryBase + IR.TS) / U32],
        workerTag: this.u32[(entryBase + IR.WORKER_TAG) / U32],
      });
    }
    // Reset count (we've consumed them)
    Atomics.store(this.u32, ctrlBase + IOPS_CTRL.COUNT, 0);
    return records;
  }

  private readTagTable(slotIndex: number): Map<number, string> {
    const ctrlBase = this.layout.strCtrlOffset(slotIndex) / U32;
    const count = Atomics.load(this.u32, ctrlBase + STR_CTRL.COUNT);
    const table = new Map<number, string>();
    const dataBase = this.layout.strDataOffset(slotIndex);
    for (let i = 0; i < count; i++) {
      const entryBase = dataBase + i * STRING_ENTRY_SIZE;
      const hash = this.u32[entryBase / U32];
      const len = this.u16[(entryBase + U32) / U16];
      let s = "";
      for (let j = 0; j < len; j++) {
        s += String.fromCharCode(this.u16[(entryBase + U32 + U16) / U16 + j]);
      }
      table.set(hash, s);
    }
    return table;
  }

  /**
   * Drain new warnings from the global warning ring.
   * Tracks how many we've already consumed; returns only new entries.
   */
  drainWarnings(): WarningRecordSnapshot[] {
    const ctrlBase = this.layout.warnCtrlOffset / U32;
    const count = Atomics.load(this.u32, ctrlBase + WARN_CTRL.COUNT);
    if (count <= this.lastWarningCount) return [];
    const cap = this.layout.warningRingCap;
    const head = Atomics.load(this.u32, ctrlBase + WARN_CTRL.HEAD);
    const newCount = count - this.lastWarningCount;
    const warnings: WarningRecordSnapshot[] = [];
    for (let i = 0; i < newCount; i++) {
      const idx = (head - 1 - i + cap * 2) % cap;
      const entryBase = this.layout.warnDataOffset + idx * WARNING_RECORD_SIZE;
      const ts = this.u32[(entryBase + WR.TS) / U32];
      warnings.push({
        ruleIdHash: this.u32[(entryBase + WR.RULE_ID_HASH) / U32],
        severity: this.u8[entryBase + WR.SEVERITY],
        metricKind: this.u8[entryBase + WR.METRIC_KIND],
        value: this.f32[(entryBase + WR.VALUE) / U32],
        threshold: this.f32[(entryBase + WR.THRESHOLD) / U32],
        workerTag: this.u32[(entryBase + WR.WORKER_TAG) / U32],
        ts: ts & 0x7fffffff,
        autoTraceFired: (ts & 0x80000000) !== 0,
      });
    }
    this.lastWarningCount = count;
    return warnings;
  }
}

// ─── Hashing ────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash. Fast, good distribution for short strings. */
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned
  return hash >>> 0;
}
