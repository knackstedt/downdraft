import { addLogSink } from "../util/logger";
import type { SimWorkerControlApi } from "./sim-worker-host";
import { RawInputRegionWriter, SimWorkerHost } from "./sim-worker-host";

// ============================================================================
// Mock worker: answers RPC requests immediately and can emit events.
// ============================================================================

interface TestApi extends SimWorkerControlApi {
  init(sab: SharedArrayBuffer): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; tickMs: number; frame: number }>;
  explode(x: number): Promise<void>;
  getThing(): Promise<{ value: number }>;
}

class MockWorker {
  private listeners: ((e: MessageEvent) => void)[] = [];
  calls: { method: string; args: any[] }[] = [];
  terminated = false;
  stats = { fps: 60, tick: 42, tickMs: 16.7, frame: 10 };
  failNext: string | null = null;

  postMessage(msg: any): void {
    if (msg?.__rpc === true && typeof msg.method === "string") {
      const { id, method, args } = msg;
      this.calls.push({ method, args });
      queueMicrotask(() => {
        if (this.failNext === method) {
          this.failNext = null;
          this.receive({ __rpc: true, id, error: "boom" });
          return;
        }
        if (method === "getStats") this.receive({ __rpc: true, id, result: this.stats });
        else if (method === "getThing") this.receive({ __rpc: true, id, result: { value: 7 } });
        else this.receive({ __rpc: true, id, result: undefined });
      });
    }
  }

  addEventListener(_type: string, cb: (e: MessageEvent) => void): void {
    this.listeners.push(cb);
  }

  removeEventListener(_type: string, cb: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }

  terminate(): void {
    this.terminated = true;
  }

  receive(msg: any): void {
    for (const cb of this.listeners) cb({ data: msg } as MessageEvent);
  }

  emit(kind: string, data?: unknown): void {
    this.receive({ __event: true, kind, data });
  }
}

class TestHost extends SimWorkerHost<TestApi> {
  mock: MockWorker;
  inited = false;

  constructor() {
    const sab = new SharedArrayBuffer(256);
    super(sab);
    this.mock = new MockWorker();
    this.setInputWriter(new RawInputRegionWriter(sab, 0, 64));
  }

  protected createWorker(): Worker {
    return this.mock as unknown as Worker;
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer());
    this.inited = true;
  }

  // Expose protected helpers for tests
  callThing(): Promise<{ value: number } | null> {
    return this.apiCall((api) => api.getThing());
  }
  sendExplode(x: number): void {
    this.apiSend((api) => api.explode(x));
  }
}

describe("SimWorkerHost", () => {
  it("runs onInit during start and exposes the SAB", async () => {
    const host = new TestHost();
    await host.start();
    expect(host.inited).toBe(true);
    expect(host.getSimBuffer().byteLength).toBe(256);
    expect(host.mock.calls[0].method).toBe("init");
    await host.stop();
  });

  it("tracks the ready handshake via the ready event", async () => {
    const host = new TestHost();
    expect(host.isReady()).toBe(false);
    const p = host.start();
    host.mock.emit("ready");
    await p;
    expect(host.isReady()).toBe(true);
    await host.stop();
  });

  it("fire-and-forget control methods post pause/resume/step/setSpeed", async () => {
    const host = new TestHost();
    await host.start();
    host.mock.calls.length = 0;
    host.pause();
    host.resume();
    host.step();
    host.setSpeed(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.mock.calls.map((c) => c.method)).toEqual(["pause", "resume", "step", "setSpeed"]);
    expect(host.mock.calls[3].args).toEqual([2]);
    await host.stop();
  });

  it("control methods are safe before start()", () => {
    const host = new TestHost();
    // No worker — should not throw
    host.pause();
    host.resume();
    host.step();
    host.setSpeed(4);
  });

  it("getStats returns worker stats and null after stop", async () => {
    const host = new TestHost();
    await host.start();
    const stats = await host.getStats();
    expect(stats).toEqual({ fps: 60, tick: 42, tickMs: 16.7, frame: 10 });
    await host.stop();
    expect(await host.getStats()).toBeNull();
  });

  it("apiCall returns the RPC result and null on failure", async () => {
    const host = new TestHost();
    await host.start();
    expect(await host.callThing()).toEqual({ value: 7 });
    host.mock.failNext = "getThing";
    expect(await host.callThing()).toBeNull();
    await host.stop();
    expect(await host.callThing()).toBeNull();
  });

  it("apiSend swallows RPC rejections", async () => {
    const host = new TestHost();
    await host.start();
    host.mock.failNext = "explode";
    host.sendExplode(3); // rejects — must not throw unhandled
    await new Promise((r) => setTimeout(r, 0));
    expect(host.mock.calls.some((c) => c.method === "explode")).toBe(true);
    await host.stop();
  });

  it("writeInput/writeInputF32 write to the input region", async () => {
    const sab = new SharedArrayBuffer(256);
    const host = new (class extends SimWorkerHost<TestApi> {
      constructor() {
        super(sab);
        this.setInputWriter(new RawInputRegionWriter(sab, 0, 64));
      }
      protected createWorker(): Worker {
        return new MockWorker() as unknown as Worker;
      }
      protected async onInit(): Promise<void> {}
    })();
    host.writeInput(8, 5);
    host.writeInputF32(12, 1.5);
    const i32 = new Int32Array(sab);
    const f32 = new Float32Array(sab);
    expect(i32[2]).toBe(5);
    expect(f32[3]).toBe(1.5);
  });

  it("onSimEvent dispatches by kind, supports wildcard, and unsubscribes", async () => {
    const host = new TestHost();
    await host.start();
    const collected: unknown[] = [];
    const all: string[] = [];
    const unsub = host.onSimEvent("collected", (d) => collected.push(d));
    host.onSimEvent("*", (_d, kind) => all.push(kind));

    host.mock.emit("collected", { items: 3 });
    host.mock.emit("matched", { x: 1 });
    expect(collected).toEqual([{ items: 3 }]);
    expect(all).toEqual(["collected", "matched"]);

    unsub();
    host.mock.emit("collected", { items: 9 });
    expect(collected.length).toBe(1);
    await host.stop();
  });

  it("a throwing event handler does not break other subscribers", async () => {
    const host = new TestHost();
    await host.start();
    const seen: unknown[] = [];
    host.onSimEvent("ev", () => {
      throw new Error("handler boom");
    });
    host.onSimEvent("ev", (d) => seen.push(d));
    let logged = 0;
    const unbindSink = addLogSink((e) => {
      if (e.level === "error") logged++;
    });
    try {
      host.mock.emit("ev", 1);
    } finally {
      unbindSink();
    }
    expect(seen).toEqual([1]);
    expect(logged).toBeGreaterThan(0);
    await host.stop();
  });

  it("attachProfilingSAB forwards __profilingAttach with defaults", async () => {
    const host = new TestHost();
    await host.start();
    const sab = new SharedArrayBuffer(64);
    await host.attachProfilingSAB(sab, { workerTag: "sim" });
    const call = host.mock.calls.find((c) => c.method === "__profilingAttach");
    expect(call).toBeTruthy();
    expect(call!.args[0]).toBe(sab);
    expect(call!.args[1]).toMatchObject({ workerTag: "sim", runtime: 0, opfs: true, idb: true, defaultWarningRules: true });
    await host.stop();
  });
});
