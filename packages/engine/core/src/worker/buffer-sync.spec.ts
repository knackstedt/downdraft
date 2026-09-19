import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BufferSyncHost, BufferSyncWorker, isBufferSyncMessage, type BufferSyncConfig } from "./buffer-sync";

// `self` is a real global under bun — save it and restore rather than delete,
// so subsequent spec files see the original environment.
const origSelf = (globalThis as any).self;
function restoreSelf() {
  if (origSelf === undefined) delete (globalThis as any).self;
  else (globalThis as any).self = origSelf;
}

// Mock requestAnimationFrame / cancelAnimationFrame for the test environment.
// rAF callbacks are queued but NOT auto-executed (prevents infinite recursion).
// The first sync happens synchronously in start(); subsequent syncs are via rAF.
let rafCallbacks: (() => void)[] = [];
const mockRaf = (cb: () => void): number => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
const mockCancelRaf = (_id: number) => { /* no-op */ };

beforeEach(() => {
  rafCallbacks = [];
  (globalThis as any).requestAnimationFrame = mockRaf;
  (globalThis as any).cancelAnimationFrame = mockCancelRaf;
});

afterEach(() => {
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
  restoreSelf();
});

/**
 * Mock Worker that simulates postMessage + addEventListener.
 * Used to test the sync protocol without actual Web Workers.
 */
class MockWorker {
  private listeners: ((e: MessageEvent) => void)[] = [];
  sent: any[] = [];

  postMessage(msg: any, transfer?: Transferable[]): void {
    this.sent.push({ msg, transfer });
  }

  addEventListener(_type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.push(cb);
  }

  removeEventListener(_type: string, cb: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }

  terminate(): void { /* no-op */ }

  /** Simulate receiving a message from the worker. */
  receive(msg: any): void {
    for (const cb of this.listeners) {
      cb({ data: msg } as MessageEvent);
    }
  }
}

/**
 * Mock self for the worker side — simulates addEventListener + postMessage.
 */
class MockSelf {
  private listeners: ((e: MessageEvent) => void)[] = [];
  sent: any[] = [];

  postMessage(msg: any, transfer?: Transferable[]): void {
    this.sent.push({ msg, transfer });
  }

  addEventListener(_type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Simulate receiving a message from the main thread. */
  receive(msg: any): void {
    for (const cb of this.listeners) {
      cb({ data: msg } as MessageEvent);
    }
  }
}

describe("buffer-sync", () => {
  describe("isBufferSyncMessage", () => {
    it("identifies buffer-sync messages", () => {
      expect(isBufferSyncMessage({ __bufferSync: true, regions: {} })).toBe(true);
      expect(isBufferSyncMessage({ foo: "bar" })).toBe(false);
      expect(isBufferSyncMessage(null)).toBe(false);
      expect(isBufferSyncMessage(undefined)).toBe(false);
      expect(isBufferSyncMessage(42)).toBe(false);
    });
  });

  describe("BufferSyncHost", () => {
    it("copies write regions to the worker on rAF", () => {
      // Set up: 1KB buffer, main writes [0, 64) (input), worker writes [64, 1024) (sim)
      const mainBuf = new ArrayBuffer(1024);
      const mockWorker = new MockWorker();

      const config: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 0, length: 64, name: "input" }],
            readRegions: [{ offset: 64, length: 960, name: "sim" }],
          },
        },
      };

      // Write some data to the input region
      const mainI32 = new Int32Array(mainBuf, 0, 16);
      mainI32[0] = 42;
      mainI32[1] = 99;

      const host = new BufferSyncHost(mockWorker as unknown as Worker, config);
      host.start();

      // The host should have posted a message with the input region
      expect(mockWorker.sent.length).toBe(1);
      const { msg, transfer } = mockWorker.sent[0];
      expect(msg.__bufferSync).toBe(true);
      expect(msg.regions.sim).toBeDefined();
      expect(msg.regions.sim.length).toBe(1);
      expect(msg.regions.sim[0].offset).toBe(0);
      expect(msg.regions.sim[0].data.byteLength).toBe(64);

      // Verify the copied bytes match
      const copiedI32 = new Int32Array(msg.regions.sim[0].data);
      expect(copiedI32[0]).toBe(42);
      expect(copiedI32[1]).toBe(99);

      // Transfer list should contain the copied ArrayBuffer
      expect(transfer).toBeDefined();
      expect(transfer!.length).toBe(1);
      expect(transfer![0]).toBe(msg.regions.sim[0].data);

      host.stop();
    });

    it("copies received sim regions into the local buffer", () => {
      const mainBuf = new ArrayBuffer(1024);
      const mockWorker = new MockWorker();

      const config: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 0, length: 64, name: "input" }],
            readRegions: [{ offset: 64, length: 960, name: "sim" }],
          },
        },
      };

      const host = new BufferSyncHost(mockWorker as unknown as Worker, config);
      host.start();
      // Clear the initial input sync
      mockWorker.sent.length = 0;

      // Simulate the worker sending sim data
      const simData = new ArrayBuffer(960);
      const simI32 = new Int32Array(simData, 0, 240);
      simI32[0] = 777;
      simI32[1] = 888;

      mockWorker.receive({
        __bufferSync: true,
        regions: {
          sim: [{ offset: 64, data: simData }],
        },
      });

      // The main buffer should now have the sim data at offset 64
      const mainI32 = new Int32Array(mainBuf, 64, 240);
      expect(mainI32[0]).toBe(777);
      expect(mainI32[1]).toBe(888);

      host.stop();
    });

    it("clearAfterSend zeros the local buffer after sending", () => {
      const mainBuf = new ArrayBuffer(1024);
      const mockWorker = new MockWorker();

      const config: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 0, length: 64, name: "input", clearAfterSend: true }],
            readRegions: [{ offset: 64, length: 960, name: "sim" }],
          },
        },
      };

      // Write input data
      const mainI32 = new Int32Array(mainBuf, 0, 16);
      mainI32[0] = 42; // e.g. ACTION=1
      mainI32[1] = 99; // e.g. click coords

      const host = new BufferSyncHost(mockWorker as unknown as Worker, config);
      host.start();

      // The host should have sent the input data
      expect(mockWorker.sent.length).toBe(1);
      const sentI32 = new Int32Array(mockWorker.sent[0].msg.regions.sim[0].data);
      expect(sentI32[0]).toBe(42);
      expect(sentI32[1]).toBe(99);

      // The local buffer should now be zeroed (clearAfterSend)
      expect(mainI32[0]).toBe(0);
      expect(mainI32[1]).toBe(0);

      host.stop();
    });

    it("skips buffers with no write regions", () => {
      const mainBuf = new ArrayBuffer(1024);
      const mockWorker = new MockWorker();

      const config: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: {
          sim: {
            writeRegions: [], // no write regions — nothing to send
            readRegions: [{ offset: 0, length: 1024, name: "all" }],
          },
        },
      };

      const host = new BufferSyncHost(mockWorker as unknown as Worker, config);
      host.start();

      // No message should be posted (no write regions)
      expect(mockWorker.sent.length).toBe(0);

      host.stop();
    });
  });

  describe("BufferSyncWorker", () => {
    it("copies write regions to the main thread on syncToMain()", () => {
      // Use a mock self object
      const mockSelf = new MockSelf();
      const workerBuf = new ArrayBuffer(1024);

      const config: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 64, length: 960, name: "sim" }],
            readRegions: [{ offset: 0, length: 64, name: "input" }],
          },
        },
      };

      // Write some data to the sim region
      const workerI32 = new Int32Array(workerBuf, 64, 240);
      workerI32[0] = 555;
      workerI32[1] = 666;

      const worker = new BufferSyncWorker(config);
      // Patch self for the worker
      (globalThis as any).self = mockSelf;
      worker.start();

      mockSelf.sent.length = 0;
      worker.syncToMain();

      expect(mockSelf.sent.length).toBe(1);
      const { msg, transfer } = mockSelf.sent[0];
      expect(msg.__bufferSync).toBe(true);
      expect(msg.regions.sim).toBeDefined();
      expect(msg.regions.sim[0].offset).toBe(64);
      expect(msg.regions.sim[0].data.byteLength).toBe(960);

      const copiedI32 = new Int32Array(msg.regions.sim[0].data);
      expect(copiedI32[0]).toBe(555);
      expect(copiedI32[1]).toBe(666);

      expect(transfer).toBeDefined();
      expect(transfer!.length).toBe(1);

      // Restore self
      restoreSelf();
    });

    it("copies received input regions into the local buffer", () => {
      const mockSelf = new MockSelf();
      const workerBuf = new ArrayBuffer(1024);

      const config: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 64, length: 960, name: "sim" }],
            readRegions: [{ offset: 0, length: 64, name: "input" }],
          },
        },
      };

      const worker = new BufferSyncWorker(config);
      (globalThis as any).self = mockSelf;
      worker.start();

      // Simulate the main thread sending input data
      const inputData = new ArrayBuffer(64);
      const inputI32 = new Int32Array(inputData, 0, 16);
      inputI32[0] = 111;
      inputI32[1] = 222;

      mockSelf.receive({
        __bufferSync: true,
        regions: {
          sim: [{ offset: 0, data: inputData }],
        },
      });

      // The worker buffer should now have the input data at offset 0
      const workerI32 = new Int32Array(workerBuf, 0, 16);
      expect(workerI32[0]).toBe(111);
      expect(workerI32[1]).toBe(222);

      restoreSelf();
    });

    it("sequence gating skips unchanged buffers", () => {
      const mockSelf = new MockSelf();
      const workerBuf = new ArrayBuffer(1024);

      const config: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: 64, length: 960, name: "sim" }],
            readRegions: [{ offset: 0, length: 64, name: "input" }],
          },
        },
        // Sequence field at offset 0 (i32) — sim bumps it each tick
        seqFields: { sim: { offset: 0 } },
      };

      const worker = new BufferSyncWorker(config);
      (globalThis as any).self = mockSelf;
      worker.start();

      // First sync: seq = 0, should send
      mockSelf.sent.length = 0;
      worker.syncToMain();
      expect(mockSelf.sent.length).toBe(1);

      // Second sync: seq still 0, should skip
      mockSelf.sent.length = 0;
      worker.syncToMain();
      expect(mockSelf.sent.length).toBe(0);

      // Bump the sequence
      const seqView = new Int32Array(workerBuf, 0, 1);
      seqView[0] = 1;

      // Third sync: seq = 1, should send
      mockSelf.sent.length = 0;
      worker.syncToMain();
      expect(mockSelf.sent.length).toBe(1);

      restoreSelf();
    });

    it("filtered sync does not starve regions sharing the same seq field", () => {
      // Overburden pattern: fast regions sync every tick batch; a slow region
      // syncs on an interval — both gated by the same HDR_TICK seq field.
      // The filtered fast sync must not consume the seq gate for the slow
      // region.
      const mockSelf = new MockSelf();
      const workerBuf = new ArrayBuffer(1024);

      const config: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: {
          sim: {
            writeRegions: [
              { offset: 64, length: 64, name: "fast" },
              { offset: 128, length: 128, name: "slow" },
            ],
            readRegions: [],
          },
        },
        seqFields: { sim: { offset: 0 } },
      };

      const worker = new BufferSyncWorker(config);
      (globalThis as any).self = mockSelf;
      worker.start();

      const seqView = new Int32Array(workerBuf, 0, 1);
      seqView[0] = 1;

      // Tick: fast sync first (filtered), then the periodic full sync.
      mockSelf.sent.length = 0;
      worker.syncToMain(["fast"]);
      expect(mockSelf.sent.length).toBe(1);
      expect(mockSelf.sent[0].msg.regions.sim.length).toBe(1);
      expect(mockSelf.sent[0].msg.regions.sim[0].offset).toBe(64);

      mockSelf.sent.length = 0;
      worker.syncToMain();
      // The slow region MUST still be sent — same seq, but it wasn't part of
      // the filtered sync.
      expect(mockSelf.sent.length).toBe(1);
      const slowRegions = mockSelf.sent[0].msg.regions.sim;
      expect(slowRegions.some((r: any) => r.offset === 128)).toBe(true);
      // The already-synced fast region is skipped (per-region seq unchanged).
      expect(slowRegions.some((r: any) => r.offset === 64)).toBe(false);

      // Next tick, seq bumped: fast sync sends fast again.
      seqView[0] = 2;
      mockSelf.sent.length = 0;
      worker.syncToMain(["fast"]);
      expect(mockSelf.sent.length).toBe(1);
      expect(mockSelf.sent[0].msg.regions.sim[0].offset).toBe(64);

      // Interval hit again: slow syncs once more with the new seq.
      mockSelf.sent.length = 0;
      worker.syncToMain();
      expect(mockSelf.sent.length).toBe(1);
      expect(mockSelf.sent[0].msg.regions.sim.some((r: any) => r.offset === 128)).toBe(true);

      restoreSelf();
    });
  });

  describe("embedded input pattern (sandjongg)", () => {
    it("main sends only 64-byte input region, worker sends everything else", () => {
      const TOTAL = 1024;
      const INPUT_OFFSET = 512;
      const INPUT_BYTES = 64;

      const mainBuf = new ArrayBuffer(TOTAL);
      const workerBuf = new ArrayBuffer(TOTAL);
      const mockWorker = new MockWorker();
      const mockSelf = new MockSelf();

      // Main side config: writes input region, reads everything else
      const mainConfig: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: {
          sim: {
            writeRegions: [{ offset: INPUT_OFFSET, length: INPUT_BYTES, name: "input" }],
            readRegions: [
              { offset: 0, length: INPUT_OFFSET, name: "pre-input" },
              { offset: INPUT_OFFSET + INPUT_BYTES, length: TOTAL - INPUT_OFFSET - INPUT_BYTES, name: "post-input" },
            ],
          },
        },
      };

      // Worker side config: writes everything except input, reads input
      const workerConfig: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: {
          sim: {
            writeRegions: [
              { offset: 0, length: INPUT_OFFSET, name: "pre-input" },
              { offset: INPUT_OFFSET + INPUT_BYTES, length: TOTAL - INPUT_OFFSET - INPUT_BYTES, name: "post-input" },
            ],
            readRegions: [{ offset: INPUT_OFFSET, length: INPUT_BYTES, name: "input" }],
          },
        },
      };

      // Write input on main side
      const mainInput = new Int32Array(mainBuf, INPUT_OFFSET, 16);
      mainInput[0] = 42;

      // Write sim data on worker side
      const workerSim = new Int32Array(workerBuf, 0, 128);
      workerSim[0] = 999;

      // Start host
      const host = new BufferSyncHost(mockWorker as unknown as Worker, mainConfig);
      host.start();

      // Main should have sent only the 64-byte input region
      expect(mockWorker.sent.length).toBe(1);
      const mainMsg = mockWorker.sent[0].msg;
      expect(mainMsg.regions.sim[0].offset).toBe(INPUT_OFFSET);
      expect(mainMsg.regions.sim[0].data.byteLength).toBe(INPUT_BYTES);

      host.stop();

      // Start worker
      const worker = new BufferSyncWorker(workerConfig);
      (globalThis as any).self = mockSelf;
      worker.start();
      mockSelf.sent.length = 0;
      worker.syncToMain();

      // Worker should have sent 2 regions (pre-input + post-input), NOT the input region
      expect(mockSelf.sent.length).toBe(1);
      const workerMsg = mockSelf.sent[0].msg;
      expect(workerMsg.regions.sim.length).toBe(2);
      expect(workerMsg.regions.sim[0].offset).toBe(0);
      expect(workerMsg.regions.sim[0].data.byteLength).toBe(INPUT_OFFSET);
      expect(workerMsg.regions.sim[1].offset).toBe(INPUT_OFFSET + INPUT_BYTES);
      expect(workerMsg.regions.sim[1].data.byteLength).toBe(TOTAL - INPUT_OFFSET - INPUT_BYTES);

      // Verify the worker did NOT send the input region
      for (const r of workerMsg.regions.sim) {
        expect(r.offset).not.toBe(INPUT_OFFSET);
      }

      restoreSelf();
    });

    it("applies chunked large transfers atomically — no partial buffer updates", async () => {
      const mockSelf = new MockSelf();
      const mockWorker = new MockWorker();
      const TOTAL = 320 * 1024; // > 256KB → chunked path (5 × 64KB chunks)
      const workerBuf = new ArrayBuffer(TOTAL);
      const mainBuf = new ArrayBuffer(TOTAL);

      const workerConfig: BufferSyncConfig = {
        buffers: { sim: workerBuf },
        regions: { sim: { writeRegions: [{ offset: 0, length: TOTAL, name: "grid" }], readRegions: [] } },
      };
      const mainConfig: BufferSyncConfig = {
        buffers: { sim: mainBuf },
        regions: { sim: { writeRegions: [], readRegions: [{ offset: 0, length: TOTAL, name: "grid" }] } },
      };

      new Uint8Array(workerBuf).fill(0xab);

      const worker = new BufferSyncWorker(workerConfig);
      (globalThis as any).self = mockSelf;
      worker.start();
      mockSelf.sent.length = 0;
      worker.syncToMain();

      // Chunked path posts the first chunk immediately, rest via setTimeout.
      expect(mockSelf.sent.length).toBe(1);
      expect(mockSelf.sent[0].msg.batch).toBeDefined();
      const total = mockSelf.sent[0].msg.batch.total;
      expect(total).toBe(5);

      // Host receives chunks as they arrive — feed through the real handler.
      const host = new BufferSyncHost(mockWorker as unknown as Worker, mainConfig);
      host.start();
      rafCallbacks = []; // host's start() posts an input sync — ignore it

      const local = new Uint8Array(mainBuf);
      // Deliver chunk 0: buffer must remain untouched (no partial apply).
      mockWorker.receive(mockSelf.sent[0].msg);
      expect(local[0]).toBe(0);

      // Deliver the rest as they arrive over the next ~80ms.
      for (let i = 0; i < total - 1; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const next = mockSelf.sent[i + 1];
        expect(next).toBeDefined();
        expect(next.msg.batch.id).toBe(mockSelf.sent[0].msg.batch.id);
        if (i < total - 2) {
          mockWorker.receive(next.msg);
          expect(local[0]).toBe(0); // still torn — not applied yet
        }
      }
      mockWorker.receive(mockSelf.sent[total - 1].msg);
      expect(local[0]).toBe(0xab);
      expect(local[TOTAL - 1]).toBe(0xab);

      host.stop();
      restoreSelf();
    });
  });
});
