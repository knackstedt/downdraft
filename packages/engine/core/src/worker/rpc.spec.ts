// Regression coverage for worker-RPC teardown semantics: session teardown
// marks a tracked worker __ddExpectTerminate, then dispatches synthetic
// "error"/"exit" events so waiters settle. Rejections from that expected
// teardown must not escape as unhandledRejection when the in-flight call
// was fire-and-forget — that used to crash dev-shell HMR restarts.

import { wrap, type WorkerApi } from "./rpc";

class MockWorker {
  listeners = new Map<string, Set<(e: any) => void>>();
  posted: any[] = [];
  terminated = false;
  addEventListener(type: string, cb: (e: any) => void) {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(cb);
  }
  removeEventListener(type: string, cb: (e: any) => void) {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(ev: { type: string; message?: string }) {
    this.listeners.get(ev.type)?.forEach((cb) => cb(ev));
    return true;
  }
  postMessage(msg: any) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
  unref() {}
}

function collectUnhandled(): { list: unknown[]; stop: () => void } {
  const list: unknown[] = [];
  const onUnhandled = (e: unknown) => list.push(e);
  process.on("unhandledRejection", onUnhandled);
  return { list, stop: () => process.off("unhandledRejection", onUnhandled) };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("worker wrap() teardown semantics", () => {
  it("rejects in-flight calls with a teardown message (not [object Event])", async () => {
    const w = new MockWorker();
    const wp = wrap<WorkerApi>(w);
    const pr = wp.proxy.getDetails(1);
    (w as any).__ddExpectTerminate = true;
    w.dispatchEvent({ type: "error" });
    await expect(pr).rejects.toThrow("Worker terminated by session teardown");
  });

  it("marks fire-and-forget rejections handled during expected teardown", async () => {
    const u = collectUnhandled();
    try {
      const w = new MockWorker();
      const wp = wrap<WorkerApi>(w);
      void wp.proxy.getDetails(1); // never awaited — the crash vector
      (w as any).__ddExpectTerminate = true;
      w.dispatchEvent({ type: "error" });
      await settle();
      expect(u.list).toHaveLength(0);
    } finally {
      u.stop();
    }
  });

  it("marks post-terminate calls handled when the kill was expected", async () => {
    const u = collectUnhandled();
    try {
      const w = new MockWorker();
      const wp = wrap<WorkerApi>(w);
      (w as any).__ddExpectTerminate = true;
      wp.terminate();
      void wp.proxy.getDetails(2); // call landing on the dead proxy
      await settle();
      expect(u.list).toHaveLength(0);
    } finally {
      u.stop();
    }
  });

  it("awaits still see the real worker error message", async () => {
    const w = new MockWorker();
    const wp = wrap<WorkerApi>(w);
    const pr = wp.proxy.getDetails(1);
    w.dispatchEvent({ type: "error", message: "boom" });
    await expect(pr).rejects.toThrow("Worker error: boom");
  });

  it("post-terminate calls reject with the terminated-worker message", async () => {
    const w = new MockWorker();
    const wp = wrap<WorkerApi>(w);
    wp.terminate();
    await expect(wp.proxy.getDetails(1)).rejects.toThrow(
      "RPC 'getDetails' on terminated worker");
  });
});
