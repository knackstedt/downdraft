import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RealmTier } from "./interface";
import { RealmWorker, supportsNestedWorkers, supportsSharedArrayBuffer } from "./realm-worker";
import { RealmWorkerPool } from "./realm-worker-pool";
import type { RealmWorkerResponse } from "./worker-protocol";

// `Worker` is a real global under bun — save and restore so the mock
// doesn't leak into later spec files in this process.
const origWorker = (globalThis as any).Worker;

/**
 * Mock Worker that captures postMessage traffic and lets tests drive
 * responses through `respond()` / `fail()`.
 */
class MockWorker {
  static instances: MockWorker[] = [];
  sent: { msg: any; transfer?: Transferable[] }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  terminated = false;
  url: string | URL;

  constructor(url: string | URL) {
    this.url = url;
    MockWorker.instances.push(this);
  }

  postMessage(msg: any, transfer?: Transferable[]): void {
    this.sent.push({ msg, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate a worker-side response with the matching requestId. */
  respond(requestId: number, resp: RealmWorkerResponse): void {
    this.onmessage?.({ data: { ...resp, requestId } } as MessageEvent);
  }

  /** Simulate an uncaught worker error. */
  fail(message = "boom"): void {
    this.onerror?.({ message });
  }
}

beforeEach(() => {
  MockWorker.instances = [];
  (globalThis as any).Worker = MockWorker;
});

afterEach(() => {
  if (origWorker === undefined) delete (globalThis as any).Worker;
  else (globalThis as any).Worker = origWorker;
});

const NOOP_RESP: RealmWorkerResponse = { type: "ERROR", message: "unhandled" };

function autoRespond(worker: MockWorker, fn: (msg: any) => RealmWorkerResponse): void {
  const orig = worker.postMessage.bind(worker);
  worker.postMessage = (msg: any, transfer?: Transferable[]) => {
    orig(msg, transfer);
    if (msg.requestId !== undefined) worker.respond(msg.requestId, fn(msg));
  };
}

describe("RealmWorker", () => {
  it("correlates responses to pending requests by requestId", async () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    const w = MockWorker.instances[0];
    const p1 = rw.request({ type: "SNAPSHOT_REALM", realmId: 1 });
    const p2 = rw.request({ type: "SNAPSHOT_REALM", realmId: 2 });
    // Respond out of order — each promise must get its own response.
    w.respond(1, { type: "SNAPSHOT_RESULT", realmId: 2, data: new Uint8Array([2]) });
    w.respond(0, { type: "SNAPSHOT_RESULT", realmId: 1, data: new Uint8Array([1]) });
    expect((await p1).realmId).toBe(1);
    expect((await p2).realmId).toBe(2);
    expect(w.sent[0].msg.requestId).toBe(0);
    expect(w.sent[1].msg.requestId).toBe(1);
  });

  it("ignores responses with no matching pending request", () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    const w = MockWorker.instances[0];
    expect(() => w.respond(99, NOOP_RESP)).not.toThrow();
  });

  it("notify() sends fire-and-forget without requestId", () => {
    const rw = new RealmWorker("worker.js", RealmTier.Far);
    const w = MockWorker.instances[0];
    rw.notify({ type: "DESTROY_ALL" });
    expect(w.sent.length).toBe(1);
    expect(w.sent[0].msg.requestId).toBeUndefined();
  });

  it("passes transferables through to postMessage", () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    const w = MockWorker.instances[0];
    const buf = new ArrayBuffer(16);
    rw.notify({ type: "DESTROY_ALL" }, [buf]);
    expect(w.sent[0].transfer).toEqual([buf]);
  });

  it("rejects all pending requests on worker error", async () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    const w = MockWorker.instances[0];
    const p1 = rw.request({ type: "SNAPSHOT_REALM", realmId: 1 });
    const p2 = rw.request({ type: "SNAPSHOT_REALM", realmId: 2 });
    w.fail("segfault");
    await expect(p1).rejects.toThrow("Worker error: segfault");
    await expect(p2).rejects.toThrow("Worker error: segfault");
  });

  it("rejects pending requests on terminate", async () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    const w = MockWorker.instances[0];
    const p = rw.request({ type: "SNAPSHOT_REALM", realmId: 1 });
    rw.terminate();
    await expect(p).rejects.toThrow("Worker terminated");
    expect(w.terminated).toBe(true);
  });

  it("tracks realm membership", () => {
    const rw = new RealmWorker("worker.js", RealmTier.Mid);
    expect(rw.hasRealm(7)).toBe(false);
    rw.addRealm(7);
    expect(rw.hasRealm(7)).toBe(true);
    rw.removeRealm(7);
    expect(rw.hasRealm(7)).toBe(false);
  });
});

describe("RealmWorkerPool", () => {
  it("falls back to single-threaded when workerCount is 0", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 0 });
    expect(await pool.init()).toBe(false);
    expect(pool.isInitialized()).toBe(true);
    expect(pool.isParallel()).toBe(false);
    pool.destroy();
  });

  it("creates workers for mid/far tiers on init", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 2 });
    expect(await pool.init()).toBe(true);
    expect(pool.hasWorkerForTier(RealmTier.Mid)).toBe(true);
    expect(pool.hasWorkerForTier(RealmTier.Far)).toBe(true);
    expect(pool.hasWorkerForTier(RealmTier.Near)).toBe(false);
    expect(pool.isParallel()).toBe(true);
    pool.destroy();
  });

  it("caps workers at the number of delegable tiers", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 8 });
    await pool.init();
    expect(MockWorker.instances.length).toBe(2);
    pool.destroy();
  });

  it("routes realm ops to the worker for that tier", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 1 });
    await pool.init();
    const w = MockWorker.instances[0];
    autoRespond(w, (msg) =>
      msg.type === "STEP_REALM"
        ? { type: "STEP_RESULT", realmId: msg.realmId, wallTimeMs: 1.5 }
        : NOOP_RESP);

    expect(await pool.initRealm(RealmTier.Mid, 3, [0, -9.81, 0])).toBe(true);
    expect(w.sent[0].msg).toMatchObject({ type: "INIT_REALM", realmId: 3, tier: RealmTier.Mid });
    expect(await pool.stepRealm(RealmTier.Mid, 3, 1 / 60, 4)).toBe(1.5);
    pool.destroy();
  });

  it("returns defaults for tiers with no worker", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 1 });
    await pool.init();
    expect(await pool.initRealm(RealmTier.Far, 1, [0, 0, 0])).toBe(false);
    expect(await pool.stepRealm(RealmTier.Far, 1, 1, 1)).toBe(0);
    expect(await pool.snapshotRealm(RealmTier.Far, 1)).toBeNull();
    pool.destroy();
  });

  it("stepRealm returns 0 for realms the worker doesn't own", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 1 });
    await pool.init();
    expect(await pool.stepRealm(RealmTier.Mid, 42, 1, 1)).toBe(0);
    pool.destroy();
  });

  it("destroy() terminates all workers", async () => {
    const pool = new RealmWorkerPool({ workerUrl: "w.js", workerCount: 2 });
    await pool.init();
    pool.destroy();
    expect(MockWorker.instances.every((w) => w.terminated)).toBe(true);
    expect(pool.isInitialized()).toBe(false);
    expect(pool.hasWorkerForTier(RealmTier.Mid)).toBe(false);
  });
});

describe("capability probes", () => {
  it("supportsSharedArrayBuffer reflects the global", () => {
    expect(supportsSharedArrayBuffer()).toBe(typeof SharedArrayBuffer !== "undefined");
  });

  it("supportsNestedWorkers reflects the Worker constructor", () => {
    expect(supportsNestedWorkers()).toBe(true); // mocked in beforeEach
  });
});
