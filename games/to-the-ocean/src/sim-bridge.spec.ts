import { describe, expect, it, mock } from "bun:test";
import type { DowndraftBridge } from "@downdraft/app/renderer";
import { createSimBridge, type IRendererMeta, type ISimWorker } from "./sim-bridge";
import type { SimWebWorkerConfig, SimEventCallback, GCControllerConfig, GCControllerStats } from "./engine/sim-web-worker";

// ============================================================================
// Fakes
// ============================================================================

function makeFakeWorker(overrides: Partial<ISimWorker> = {}): ISimWorker {
  const calls: { method: string; args: unknown[] }[] = [];
  const worker: ISimWorker = {
    start: async (_config: SimWebWorkerConfig) => {},
    addPlayer: (id: number, name: string) => { calls.push({ method: "addPlayer", args: [id, name] }); },
    removePlayer: (id: number) => { calls.push({ method: "removePlayer", args: [id] }); },
    pause: () => { calls.push({ method: "pause", args: [] }); },
    resume: () => { calls.push({ method: "resume", args: [] }); },
    save: async (slotName: string) => {
      calls.push({ method: "save", args: [slotName] });
      return { slotName, stateJson: '{"world":{"tick":1}}' };
    },
    load: async (slotName: string, stateJson?: string) => {
      calls.push({ method: "load", args: [slotName, stateJson] });
      return true;
    },
    setGamemode: (mode: number) => { calls.push({ method: "setGamemode", args: [mode] }); },
    setSetting: (key: string, value: number | boolean) => { calls.push({ method: "setSetting", args: [key, value] }); },
    respawnPlayer: (id: number) => { calls.push({ method: "respawnPlayer", args: [id] }); },
    setDebugMode: (enabled: boolean) => { calls.push({ method: "setDebugMode", args: [enabled] }); },
    sendCommand: (cmd: any) => { calls.push({ method: "sendCommand", args: [cmd] }); },
    sendWorldCommand: (cmd: any) => { calls.push({ method: "sendWorldCommand", args: [cmd] }); },
    setWeather: (wt: number) => { calls.push({ method: "setWeather", args: [wt] }); },
    setTimeOfDay: (t: number) => { calls.push({ method: "setTimeOfDay", args: [t] }); },
    setSimSpeed: (s: number) => { calls.push({ method: "setSimSpeed", args: [s] }); },
    getSimSpeed: async () => 1.0,
    setPhysicsProfiler: (e: boolean) => { calls.push({ method: "setPhysicsProfiler", args: [e] }); },
    setGCConfig: (c: Partial<GCControllerConfig>) => { calls.push({ method: "setGCConfig", args: [c] }); },
    getGCStats: async () => null as GCControllerStats | null,
    forceMajorGC: () => { calls.push({ method: "forceMajorGC", args: [] }); },
    restoreFromState: async (_s: string) => {},
    hotReload: async (_c: SimWebWorkerConfig, _p: boolean) => {},
    stop: async () => {},
    onEvent: (_cb: SimEventCallback) => {},
    offEvent: (_cb: SimEventCallback) => {},
    getSimBuffer: () => new SharedArrayBuffer(0),
    getInputBuffer: () => new SharedArrayBuffer(0),
    getWaterBuffer: () => new SharedArrayBuffer(0),
    getBoatBuffer: () => new SharedArrayBuffer(0),
    isReady: () => true,
    ...overrides,
  };
  // Attach calls log for inspection
  (worker as any)._calls = calls;
  return worker;
}

function makeFakeRenderer(overrides: Partial<IRendererMeta> = {}): IRendererMeta & { _calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    serializeRendererMeta: () => {
      calls.push({ method: "serializeRendererMeta", args: [] });
      return { cameraPos: [1, 2, 3] };
    },
    restoreRendererMeta: (meta: Record<string, unknown>) => {
      calls.push({ method: "restoreRendererMeta", args: [meta] });
    },
    ...overrides,
    _calls: calls,
  } as any;
}

function makeFakeDowndraft(overrides: Partial<DowndraftBridge> = {}): DowndraftBridge & { _calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const dd: any = {
    isAvailable: true,
    saveGameState: (slotName: string, stateJson: string) => {
      calls.push({ method: "saveGameState", args: [slotName, stateJson] });
      return Promise.resolve(true);
    },
    loadGameState: (slotName: string) => {
      calls.push({ method: "loadGameState", args: [slotName] });
      return Promise.resolve('{"world":{"tick":5},"renderer":{"v":1,"data":{"cameraPos":[9,8,7]}}}');
    },
    deleteGameState: async () => false,
    listSaveSlots: async () => [],
    quit: async () => { calls.push({ method: "quit", args: [] }); },
    setDebugMode: (e: boolean) => { calls.push({ method: "setDebugMode", args: [e] }); },
    toggleDevtools: () => { calls.push({ method: "toggleDevtools", args: [] }); },
    toggleFullscreen: () => { calls.push({ method: "toggleFullscreen", args: [] }); },
    getDisplayInfo: async () => ({ refreshRate: 60 }),
    openExternal: () => {},
    getGPUSystemInfo: async () => null,
    getElectronGPUInfo: async () => null,
    getVulkanValidationStatus: async () => ({ enabled: false, envVar: null }),
    openChromeUrl: () => {},
    importCacheGet: async () => null,
    importCacheSet: async () => {},
    importCacheInvalidate: async () => {},
    onSimReady: () => {},
    onDisplayInfo: () => {},
    onDisplayMetricsChanged: () => {},
    onGCStats: () => {},
    onPerfStats: () => {},
    removeAllListeners: () => {},
    log: () => {},
    deterministic: false,
    onMcpRequest: () => {},
    ...overrides,
    _calls: calls,
  };
  return dd;
}

// ============================================================================
// Tests
// ============================================================================

describe("createSimBridge", () => {
  it("saveGame merges renderer meta and calls downdraft.saveGameState", async () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.saveGame("quicksave");

    expect(result).toBe(true);
    // Worker save was called
    expect((worker as any)._calls.some((c: any) => c.method === "save")).toBe(true);
    // Renderer meta was serialized
    expect(renderer._calls.some((c) => c.method === "serializeRendererMeta")).toBe(true);
    // Downdraft saved with merged JSON containing renderer section
    const saveCall = dd._calls.find((c) => c.method === "saveGameState");
    expect(saveCall).toBeDefined();
    const savedJson = JSON.parse(saveCall!.args[1] as string);
    expect(savedJson.world).toBeDefined();
    expect(savedJson.renderer).toBeDefined();
    expect(savedJson.renderer.v).toBe(1);
    expect(savedJson.renderer.data).toEqual({ cameraPos: [1, 2, 3] });
  });

  it("saveGame returns false when worker.save returns null", async () => {
    const worker = makeFakeWorker({ save: async () => null });
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.saveGame("quicksave");

    expect(result).toBe(false);
    // Downdraft saveGameState should NOT have been called
    expect(dd._calls.some((c) => c.method === "saveGameState")).toBe(false);
  });

  it("loadGame loads state and restores renderer meta", async () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.loadGame("quicksave");

    expect(result).toBe(true);
    // Worker load was called with the stateJson from downdraft
    const loadCall = (worker as any)._calls.find((c: any) => c.method === "load");
    expect(loadCall).toBeDefined();
    expect(loadCall.args[0]).toBe("quicksave");
    expect(loadCall.args[1]).toContain('"renderer"');
    // Renderer meta was restored
    const restoreCall = renderer._calls.find((c) => c.method === "restoreRendererMeta");
    expect(restoreCall).toBeDefined();
    expect(restoreCall!.args[0]).toEqual({ cameraPos: [9, 8, 7] });
  });

  it("loadGame returns false when downdraft has no saved state", async () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft({ loadGameState: async () => null });
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.loadGame("quicksave");

    expect(result).toBe(false);
    // Worker load should NOT have been called
    expect((worker as any)._calls.some((c: any) => c.method === "load")).toBe(false);
  });

  it("loadGame handles state without renderer meta without calling restoreRendererMeta", async () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft({
      loadGameState: async () => '{"world":{"tick":5}}',
    });
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.loadGame("quicksave");

    expect(result).toBe(true);
    // Renderer meta should NOT have been restored (no renderer section in state)
    expect(renderer._calls.some((c) => c.method === "restoreRendererMeta")).toBe(false);
  });

  it("loadGame returns false and does not restore when worker.load fails", async () => {
    const worker = makeFakeWorker({ load: async () => false });
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    const result = await bridge.loadGame("quicksave");

    expect(result).toBe(false);
    expect(renderer._calls.some((c) => c.method === "restoreRendererMeta")).toBe(false);
  });

  it("sendCommand forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.sendCommand({ type: "transfer_to_ship", playerId: 0 });

    const cmdCall = (worker as any)._calls.find((c: any) => c.method === "sendCommand");
    expect(cmdCall).toBeDefined();
    expect(cmdCall.args[0]).toEqual({ type: "transfer_to_ship", playerId: 0 });
  });

  it("setWeather forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.setWeather(3);

    const call = (worker as any)._calls.find((c: any) => c.method === "setWeather");
    expect(call).toBeDefined();
    expect(call.args[0]).toBe(3);
  });

  it("setTimeOfDay forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.setTimeOfDay(0.5);

    const call = (worker as any)._calls.find((c: any) => c.method === "setTimeOfDay");
    expect(call).toBeDefined();
    expect(call.args[0]).toBe(0.5);
  });

  it("setDebugMode calls both worker and downdraft", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.setDebugMode(true);

    expect((worker as any)._calls.some((c: any) => c.method === "setDebugMode" && c.args[0] === true)).toBe(true);
    expect(dd._calls.some((c) => c.method === "setDebugMode" && c.args[0] === true)).toBe(true);
  });

  it("pauseGame and resumeGame forward to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.pauseGame();
    bridge.resumeGame();

    expect((worker as any)._calls.some((c: any) => c.method === "pause")).toBe(true);
    expect((worker as any)._calls.some((c: any) => c.method === "resume")).toBe(true);
  });

  it("quit forwards to downdraft", async () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.quit();

    // quit is async on downdraft — just verify it was called
    expect(dd._calls.some((c) => c.method === "quit")).toBe(true);
  });

  it("respawnPlayer forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.respawnPlayer(42);

    const call = (worker as any)._calls.find((c: any) => c.method === "respawnPlayer");
    expect(call).toBeDefined();
    expect(call.args[0]).toBe(42);
  });

  it("setSetting forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.setSetting("collisionLodDistance", 500);

    const call = (worker as any)._calls.find((c: any) => c.method === "setSetting");
    expect(call).toBeDefined();
    expect(call.args[0]).toBe("collisionLodDistance");
    expect(call.args[1]).toBe(500);
  });

  it("sendWorldCommand forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.sendWorldCommand({ action: "spawn" });

    const call = (worker as any)._calls.find((c: any) => c.method === "sendWorldCommand");
    expect(call).toBeDefined();
    expect(call.args[0]).toEqual({ action: "spawn" });
  });

  it("toggleFullscreen forwards to downdraft", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.toggleFullscreen();

    expect(dd._calls.some((c) => c.method === "toggleFullscreen")).toBe(true);
  });

  it("forceWorkerMajorGC forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.forceWorkerMajorGC();

    expect((worker as any)._calls.some((c: any) => c.method === "forceMajorGC")).toBe(true);
  });

  it("setPhysicsProfiler forwards to worker", () => {
    const worker = makeFakeWorker();
    const renderer = makeFakeRenderer();
    const dd = makeFakeDowndraft();
    const bridge = createSimBridge({ worker, renderer, downdraft: dd });

    bridge.setPhysicsProfiler(true);

    const call = (worker as any)._calls.find((c: any) => c.method === "setPhysicsProfiler");
    expect(call).toBeDefined();
    expect(call.args[0]).toBe(true);
  });
});
