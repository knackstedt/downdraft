import {
  computeProfilingSABLayout,
  allocateProfilingSAB,
  claimSlot,
  releaseSlot,
  ProfilingSABWriter,
  ProfilingSABReader,
  fnv1a32,
  PROFILING_MAX_SLOTS,
  PROFILING_IOPS_RING_CAP,
  PROFILING_WARNING_RING_CAP,
  RUNTIME_JS,
  RUNTIME_WASM,
  STORE_OPFS,
  SEVERITY_WARN,
  METRIC_TICK_LATENCY,
  HEADER_SIZE,
  SLOT_HEADER_SIZE,
} from "./profiling-sab";

describe("ProfilingSAB layout", () => {
  it("computeProfilingSABLayout produces a deterministic, aligned layout", () => {
    const layout = computeProfilingSABLayout(8, 64, 32, 16);
    expect(layout.maxSlots).toBe(8);
    expect(layout.iopsRingCap).toBe(64);
    expect(layout.warningRingCap).toBe(32);
    expect(layout.stringTableCap).toBe(16);
    expect(layout.byteLength).toBeGreaterThan(HEADER_SIZE + 8 * SLOT_HEADER_SIZE);
    // Offsets should be 4-byte aligned (u32 array indexing)
    expect(layout.slotTableOffset % 4).toBe(0);
    expect(layout.warnCtrlOffset % 4).toBe(0);
    for (let i = 0; i < 8; i++) {
      expect(layout.metricsOffset(i) % 4).toBe(0);
      expect(layout.eventLoopOffset(i) % 4).toBe(0);
      expect(layout.iopsCtrlOffset(i) % 4).toBe(0);
      expect(layout.strCtrlOffset(i) % 4).toBe(0);
    }
  });

  it("allocateProfilingSAB initializes the header", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const u32 = new Uint32Array(sab);
    expect(u32[0]).toBe(0x50524f46); // magic
    expect(u32[1]).toBe(1); // version
    expect(u32[2]).toBe(4); // maxSlots
    expect(u32[3]).toBe(0); // activeSlots
    // All slots should be free (alive = 0)
    for (let i = 0; i < 4; i++) {
      const base = (layout.slotTableOffset / 4) + i * (SLOT_HEADER_SIZE / 4);
      expect(u32[base + 5]).toBe(0); // ALIVE
    }
  });
});

describe("ProfilingSAB slot claiming", () => {
  it("claimSlot claims a free slot and fills the header", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const tagHash = fnv1a32("sim-worker");
    const idx = claimSlot(sab, layout, tagHash, RUNTIME_JS, "sim-worker");
    expect(idx).toBe(0);
    const u32 = new Uint32Array(sab);
    const base = (layout.slotTableOffset / 4) + 0 * (SLOT_HEADER_SIZE / 4);
    expect(u32[base + 5]).toBe(1); // ALIVE
    expect(u32[base + 0]).toBe(tagHash); // WORKER_TAG
    expect(u32[base + 1]).toBe(RUNTIME_JS); // RUNTIME
    // Active slots should be 1
    expect(u32[3]).toBe(1);
  });

  it("claimSlot returns -1 when all slots are taken", () => {
    const { sab, layout } = allocateProfilingSAB(2, 16, 8, 4);
    claimSlot(sab, layout, 1, RUNTIME_JS, "w1");
    claimSlot(sab, layout, 2, RUNTIME_JS, "w2");
    const idx = claimSlot(sab, layout, 3, RUNTIME_JS, "w3");
    expect(idx).toBe(-1);
  });

  it("releaseSlot marks the slot as free", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, 1, RUNTIME_JS, "w1");
    expect(idx).toBe(0);
    releaseSlot(sab, layout, 0);
    const u32 = new Uint32Array(sab);
    const base = (layout.slotTableOffset / 4) + 0 * (SLOT_HEADER_SIZE / 4);
    expect(u32[base + 5]).toBe(0); // ALIVE = 0
    expect(u32[3]).toBe(0); // activeSlots = 0
  });
});

describe("ProfilingSABWriter/Reader", () => {
  it("writes and reads ThreadMetrics", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    writer.writeThreadMetrics({
      heapUsed: 1000, heapTotal: 2000, rss: 3000,
      cpuTimeMs: 10.5, cpuPercent: 50,
      gcPauseTotalUs: 100, gcPauseCount: 2, gcPauseMaxUs: 60,
      tick: 42, taskCount: 5,
      taskLatencyP50Us: 100, taskLatencyP95Us: 200, taskLatencyP99Us: 300, taskLatencyMaxUs: 400,
    });
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots.length).toBe(1);
    const m = snap.slots[0].metrics;
    expect(m.heapUsed).toBe(1000);
    expect(m.heapTotal).toBe(2000);
    expect(m.cpuPercent).toBeCloseTo(50, 1);
    expect(m.tick).toBe(42);
    expect(m.taskLatencyMaxUs).toBe(400);
  });

  it("writes and reads EventLoop block", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    writer.writeEventLoop({
      rafJitterP50Us: 100, rafJitterP95Us: 500, rafJitterMaxUs: 1000,
      longtaskCount: 2, longtaskTotalMs: 120, longtaskMaxMs: 80,
      idleHeadroomMs: 5, expectedFrameMs: 16.67,
    });
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    const el = snap.slots[0].eventLoop;
    expect(el.rafJitterP50Us).toBeCloseTo(100, 1);
    expect(el.rafJitterMaxUs).toBe(1000);
    expect(el.longtaskCount).toBe(2);
    expect(el.expectedFrameMs).toBeCloseTo(16.67, 1);
  });

  it("pushes and drains IOPS records", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    const tagHash = writer.internTag("save.dat");
    writer.pushIopsRecord({
      opKind: 1, store: STORE_OPFS, tagHash, bytes: 1024,
      latencyUs: 500, ts: performance.now(), workerTag: fnv1a32("test"),
    });
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].iopsRecords.length).toBe(1);
    const rec = snap.slots[0].iopsRecords[0];
    expect(rec.opKind).toBe(1);
    expect(rec.store).toBe(STORE_OPFS);
    expect(rec.bytes).toBe(1024);
    expect(rec.latencyUs).toBe(500);
    // Tag should be resolvable
    expect(snap.slots[0].tagTable.get(tagHash)).toBe("save.dat");
  });

  it("IOPS ring wraps around without crashing", () => {
    const { sab, layout } = allocateProfilingSAB(4, 4, 8, 4); // small ring cap=4
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    for (let i = 0; i < 10; i++) {
      writer.pushIopsRecord({
        opKind: i, store: STORE_OPFS, tagHash: 0, bytes: i,
        latencyUs: i * 100, ts: performance.now(), workerTag: 0,
      });
    }
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    // Ring cap is 4, so we get at most 4 records
    expect(snap.slots[0].iopsRecords.length).toBeLessThanOrEqual(4);
  });

  it("pushes and drains warning records", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    writer.pushWarningRecord({
      ruleIdHash: fnv1a32("dd:tick-slow"),
      severity: SEVERITY_WARN,
      metricKind: METRIC_TICK_LATENCY,
      value: 60000,
      threshold: 50000,
      workerTag: fnv1a32("test"),
      ts: performance.now(),
      autoTraceFired: true,
    });
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.warnings.length).toBe(1);
    expect(snap.warnings[0].severity).toBe(SEVERITY_WARN);
    expect(snap.warnings[0].value).toBeCloseTo(60000, 1);
    expect(snap.warnings[0].autoTraceFired).toBe(true);
  });

  it("internTag returns the same hash for the same string", () => {
    const { sab, layout } = allocateProfilingSAB(4, 16, 8, 4);
    const idx = claimSlot(sab, layout, fnv1a32("test"), RUNTIME_JS, "test");
    const writer = new ProfilingSABWriter(sab, layout, idx);
    const h1 = writer.internTag("foo/bar.dat");
    const h2 = writer.internTag("foo/bar.dat");
    expect(h1).toBe(h2);
    const reader = new ProfilingSABReader(sab, layout);
    const snap = reader.readSnapshot();
    expect(snap.slots[0].tagTable.get(h1)).toBe("foo/bar.dat");
  });

  it("fnv1a32 is deterministic and unsigned", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
    expect(fnv1a32("test")).toBeGreaterThanOrEqual(0); // unsigned
  });
});
