import { HotReloadPipeline } from "./hot-reload-pipeline";
import type { IWorkerManager } from "./types";

function createMockWorkerManager(): IWorkerManager & {
  saveCalls: number;
  stopCalls: number;
  startCalls: number;
  restoreCalls: number;
  startConfig: unknown;
  restoreStateJson: string | null;
  saveResult: { slotName: string; stateJson: string } | null;
  saveShouldThrow: boolean;
  restoreShouldThrow: boolean;
} {
  const mock = {
    saveCalls: 0,
    stopCalls: 0,
    startCalls: 0,
    restoreCalls: 0,
    startConfig: null as unknown,
    restoreStateJson: null as string | null,
    saveResult: { slotName: "hot-reload", stateJson: '{"players":[]}' } as { slotName: string; stateJson: string } | null,
    saveShouldThrow: false,
    restoreShouldThrow: false,

    async start(config: unknown): Promise<void> {
      mock.startCalls++;
      mock.startConfig = config;
    },
    async stop(): Promise<void> {
      mock.stopCalls++;
    },
    async save(slotName: string): Promise<{ slotName: string; stateJson: string } | null> {
      mock.saveCalls++;
      if (mock.saveShouldThrow) throw new Error("save failed");
      return mock.saveResult;
    },
    async restoreFromState(stateJson: string): Promise<void> {
      mock.restoreCalls++;
      mock.restoreStateJson = stateJson;
      if (mock.restoreShouldThrow) throw new Error("restore failed");
    },
  };
  return mock;
}

describe("HotReloadPipeline", () => {
  it("should execute save→stop→start→restore in order when preserveState is true", async () => {
    const wm = createMockWorkerManager();
    const pipeline = new HotReloadPipeline(wm);
    const config = { seed: 42 };

    await pipeline.hotReload(config, true);

    expect(wm.saveCalls).toBe(1);
    expect(wm.stopCalls).toBe(1);
    expect(wm.startCalls).toBe(1);
    expect(wm.restoreCalls).toBe(1);
    expect(wm.startConfig).toBe(config);
    expect(wm.restoreStateJson).toBe('{"players":[]}');
  });

  it("should skip save and restore when preserveState is false", async () => {
    const wm = createMockWorkerManager();
    const pipeline = new HotReloadPipeline(wm);

    await pipeline.hotReload({ seed: 1 }, false);

    expect(wm.saveCalls).toBe(0);
    expect(wm.stopCalls).toBe(1);
    expect(wm.startCalls).toBe(1);
    expect(wm.restoreCalls).toBe(0);
  });

  it("should continue with stop/start even if save fails", async () => {
    const wm = createMockWorkerManager();
    wm.saveShouldThrow = true;
    const pipeline = new HotReloadPipeline(wm);

    await pipeline.hotReload({ seed: 1 }, true);

    expect(wm.saveCalls).toBe(1);
    expect(wm.stopCalls).toBe(1);
    expect(wm.startCalls).toBe(1);
    expect(wm.restoreCalls).toBe(0);
  });

  it("should not restore if save returned null", async () => {
    const wm = createMockWorkerManager();
    wm.saveResult = null;
    const pipeline = new HotReloadPipeline(wm);

    await pipeline.hotReload({ seed: 1 }, true);

    expect(wm.saveCalls).toBe(1);
    expect(wm.stopCalls).toBe(1);
    expect(wm.startCalls).toBe(1);
    expect(wm.restoreCalls).toBe(0);
  });

  it("should start fresh if restore fails", async () => {
    const wm = createMockWorkerManager();
    wm.restoreShouldThrow = true;
    const pipeline = new HotReloadPipeline(wm);

    await pipeline.hotReload({ seed: 1 }, true);

    expect(wm.saveCalls).toBe(1);
    expect(wm.stopCalls).toBe(1);
    expect(wm.startCalls).toBe(1);
    expect(wm.restoreCalls).toBe(1);
  });
});
