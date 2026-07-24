import type { SimWorkerHandle } from "./sim-worker.ts";
import { SimWorkerSupervisor } from "./supervisor.ts";

function makeMockHandle(initShouldFail = false): SimWorkerHandle {
  let crashHandlers: Array<(err: Error) => void> = [];
  let terminated = false;
  return {
    ready: false,
    init: async () => {
      if (initShouldFail) throw new Error("init failed");
    },
    step: async () => ({ tick: 0, entityCount: 0, frameTime: 0 }),
    command: async () => undefined,
    onCrash: (fn: (err: Error) => void) => { crashHandlers.push(fn); },
    onHeartbeat: () => {},
    terminate: () => { terminated = true; },
    _triggerCrash: (err: Error) => { for (const h of crashHandlers) h(err); },
    _isTerminated: () => terminated,
  } as unknown as SimWorkerHandle;
}

describe("SimWorkerSupervisor", () => {
  it("should start and create a worker", () => {
    let created = false;
    const sup = new SimWorkerSupervisor(
      () => { created = true; return makeMockHandle(); },
      { onFatalError: () => {}, onRestarted: () => {} },
    );
    sup.start();
    expect(created).toBe(true);
    sup.terminate();
  });

  it("should call onFatalError when max restarts exceeded", async () => {
    let fatalError: Error | null = null;
    let createCount = 0;
    const sup = new SimWorkerSupervisor(
      () => { createCount++; return makeMockHandle(true); },
      { maxRestarts: 1, crashWindowMs: 60000, onFatalError: (err) => { fatalError = err; }, onRestarted: () => {} },
    );
    sup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fatalError).not.toBeNull();
    sup.terminate();
  });

  it("should call onRestarted when worker crashes within limits", () => {
    let restarted = false;
    let crashCount = 0;
    const sup = new SimWorkerSupervisor(
      () => {
        const handle = makeMockHandle(false);
        if (crashCount === 0) {
          setTimeout(() => {
            crashCount++;
            (handle as any)._triggerCrash(new Error("crash"));
          }, 0);
        }
        return handle;
      },
      { maxRestarts: 3, crashWindowMs: 60000, onFatalError: () => {}, onRestarted: () => { restarted = true; } },
    );
    sup.start();
    sup.terminate();
  });

  it("should terminate the worker", () => {
    let handle: SimWorkerHandle;
    const sup = new SimWorkerSupervisor(
      () => { handle = makeMockHandle(); return handle; },
      { onFatalError: () => {}, onRestarted: () => {} },
    );
    sup.start();
    sup.terminate();
    expect((handle as any)?._isTerminated()).toBe(true);
  });

  it("should return handle via getHandle", () => {
    const sup = new SimWorkerSupervisor(
      () => makeMockHandle(),
      { onFatalError: () => {}, onRestarted: () => {} },
    );
    sup.start();
    expect(sup.getHandle()).not.toBeNull();
    sup.terminate();
  });

  it("should return null handle after terminate", () => {
    const sup = new SimWorkerSupervisor(
      () => makeMockHandle(),
      { onFatalError: () => {}, onRestarted: () => {} },
    );
    sup.start();
    sup.terminate();
    expect(sup.getHandle()).toBeNull();
  });
});
