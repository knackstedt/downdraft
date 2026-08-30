// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a renderer Web Worker
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// Uses the RPC layer (expose/exposeEvents) for typed async communication.
// ============================================================================

import { GCController, InputBufferReader, PLR_FLAG, SimBufferWriter, SimStateHelper, SimWorkerLoop, TransientStateRegistry, startGCProfiler, type GCControllerConfig, type GCControllerStats, type GCProfilerHandle, type GCStats, type LoadOptions, type SaveOptions } from "@downdraft/core";
import { expose, exposeEvents, getWorkerHost } from "@downdraft/core/worker/rpc";
import { OpfsSaveStore, type OpfsSaveStoreOptions } from "@downdraft/library-persistence/browser";
import { allocateDevToolsSAB, attachDevToolsSAB, devtools, exposeDevToolsApi } from "@downdraft/module-devtools";
import { WaterBufferWriter } from "@downdraft/library-water";
import { MAX_SIM_SPEED, MIN_SIM_SPEED, SIM_TICK_DT } from "@shared/constants/buffer";
import { SimToMainMessage } from "@shared/types";
import { Simulation } from "@sim/simulation";
import { BoatBufferWriter } from "@to-the-ocean/library-boats/boat-sab";

(globalThis as any).__ddThreadTag = "R1";

let simulation: Simulation | null = null;
let stateHelper: SimStateHelper | null = null;
let gcHandle: GCProfilerHandle | null = null;
let gcController: GCController | null = null;
let gcStatsTimer: ReturnType<typeof setInterval> | null = null;
let debugMode = false;
let perfTimer: ReturnType<typeof setInterval> | null = null;
let perfWallStart = 0;

let simLoop: SimWorkerLoop | null = null;
let opfsStore: OpfsSaveStore | null = null;

const events = exposeEvents();

const onEvent = (msg: SimToMainMessage) => { events.emit(msg.kind, msg.data); };

// Allocate and attach the devtools SAB for worker→renderer data feeds.
// Sim plugins write data feeds here via devtools.registerDataFeed(); the
// renderer reads them synchronously from the shared SAB.
const devtoolsSAB = allocateDevToolsSAB();
attachDevToolsSAB(devtoolsSAB);

expose(exposeDevToolsApi({
  async init(
    simBuffer: SharedArrayBuffer,
    inputBuffer: SharedArrayBuffer,
    waterBuffer: SharedArrayBuffer,
    boatBuffer: SharedArrayBuffer,
    config: { seed: number; gamemode: number; rules: Record<string, number | boolean>; isDev?: boolean },
  ): Promise<void> {
    const simWriter = new SimBufferWriter(simBuffer);
    simWriter.init();

    const inputReader = new InputBufferReader(inputBuffer);
    const waterWriter = new WaterBufferWriter(waterBuffer);
    waterWriter.init(4);

    const boatWriter = new BoatBufferWriter(boatBuffer);
    boatWriter.init();

    simulation = new Simulation(simWriter, inputReader, waterWriter, config, onEvent, boatWriter, boatBuffer);

    simulation.onDesignChanged = (entityId, designJson) => {
      events.emit("boat_design_update", { entityId, designJson });
    };

    simulation.onDesignRemoved = (entityId) => {
      events.emit("boat_design_remove", { entityId });
    };

    await simulation.init();

    // Set up SimStateHelper with transient state registry
    const registry = new TransientStateRegistry();
    // Player flags that depend on unserialized system internal state (BoatSystem, FishingSystem)
    // must be stripped during save to prevent frozen movement after hot-reload.
    registry.registerTransientFlags("players",
      PLR_FLAG.PILOTING | PLR_FLAG.CLIMBING | PLR_FLAG.ONBOARD | PLR_FLAG.FISHING);
    // Reset callbacks clear system-internal Maps/Sets that aren't part of serialized state.
    // Called after restoreState() but before rebuildAfterRestore().
    registry.registerResetCallback(() => simulation?.boatSystem.resetTransientState());
    registry.registerResetCallback(() => simulation?.playerManager.resetTransientState());
    registry.registerResetCallback(() => simulation?.portSystem.resetTransientState());
    registry.registerResetCallback(() => simulation?.fishingSystem.resetTransientState());
    stateHelper = new SimStateHelper(simulation, registry);

    // Push initial designs after init
    for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
      events.emit("boat_design_update", { entityId, designJson: JSON.stringify(design) });
    }

    // Create GC controller and attach to the sim loop
    gcController = new GCController("sim-worker");
    simLoop?.setGCController(gcController);
  },

  pause() { simLoop?.pause(); },
  resume() { simLoop?.resume(); },

  async save(slotName: string, opts?: SaveOptions): Promise<{ slotName: string; stateJson: string; success: boolean; gen?: number }> {
    if (!simulation || !stateHelper) throw new Error("Simulation not initialized");
    const stateJson = stateHelper.saveState();

    // If inline OPFS store is available, save directly to OPFS from this worker
    if (opfsStore) {
      const components = JSON.parse(stateJson);
      const result = await opfsStore.save(slotName, {
        components,
        meta: {
          engineVersion: opts?.properties?.engineVersion as string ?? "0.1.0",
          timestamp: Date.now() / 1000,
          entityCount: 0,
          playerCount: 0,
        },
      }, opts);
      events.emit("saved", { slotName, stateJson, success: result.success, gen: result.gen });
      return { slotName, stateJson, success: result.success, gen: result.gen };
    }

    // Fallback: return stateJson to the renderer for IPC-based saving
    events.emit("saved", { slotName, stateJson });
    return { slotName, stateJson, success: true };
  },

  async load(slotName: string, stateJson?: string, opts?: LoadOptions): Promise<boolean> {
    if (!simulation) throw new Error("Simulation not initialized");

    // If inline OPFS store is available, load directly from OPFS
    if (opfsStore && !stateJson) {
      const result = await opfsStore.load(slotName, opts);
      if (!result.state) {
        events.emit("loaded", { slotName, success: false });
        return false;
      }
      const loadedJson = JSON.stringify(result.state.components);
      simulation.restoreState(loadedJson);
      events.emit("loaded", { slotName, success: true, gen: result.gen });
      return true;
    }

    // Fallback: use provided stateJson (from IPC)
    if (stateJson) {
      simulation.restoreState(stateJson);
    }
    events.emit("loaded", { slotName, success: true });
    return true;
  },

  async initSaveStore(opts: OpfsSaveStoreOptions): Promise<void> {
    opfsStore = new OpfsSaveStore(opts);
    await opfsStore.init();
  },

  setGamemode(mode: number) { simulation?.setGamemode(mode); },
  addPlayer(playerId: number, name: string) { simulation?.addPlayer(playerId, name); },
  removePlayer(playerId: number) { simulation?.removePlayer(playerId); },
  setSetting(key: string, value: number | boolean) { simulation?.setSetting(key, value); },
  respawnPlayer(playerId: number) { simulation?.respawnPlayer(playerId); },

  shutdown() {
    simLoop?.stop();
    gcHandle?.stop();
    if (gcStatsTimer) { clearInterval(gcStatsTimer); gcStatsTimer = null; }
    gcController?.dispose();
    gcController = null;
    simulation?.shutdown();
    setTimeout(() => getWorkerHost().close(), 0);
  },

  setDebugMode(enabled: boolean) {
    debugMode = enabled;
    if (enabled && !gcHandle) {
      gcHandle = startGCProfiler('sim-worker', (stats: GCStats) => {
        events.emit("gc_stats", stats);
      });
    } else if (!enabled && gcHandle) {
      gcHandle.stop();
      gcHandle = null;
    }
    if (enabled && !perfTimer) {
      simLoop?.resetTickTimeAccum();
      perfWallStart = performance.now();
      perfTimer = setInterval(() => {
        const now = performance.now();
        const wallMs = now - perfWallStart;
        const tickTimeAccum = simLoop?.getTickTimeAccum() ?? 0;
        const cpuPercent = wallMs > 0 ? Math.min(100, (tickTimeAccum / wallMs) * 100) : 0;
        const mem = (performance as any).memory;
        events.emit("perf_stats", {
          process: "worker",
          cpuPercent,
          memUsedMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
          heapUsedMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
          heapTotalMB: mem ? mem.totalJSHeapSize / 1048576 : 0,
          timestamp: now,
        });
        simLoop?.resetTickTimeAccum();
        perfWallStart = now;
      }, 2000);
    } else if (!enabled && perfTimer) {
      clearInterval(perfTimer);
      perfTimer = null;
    }
    // GC controller stats forwarding
    if (enabled && !gcStatsTimer) {
      gcStatsTimer = setInterval(() => {
        if (gcController) events.emit("gc_controller_stats", gcController.getStats());
      }, 2000);
    } else if (!enabled && gcStatsTimer) {
      clearInterval(gcStatsTimer);
      gcStatsTimer = null;
    }
  },

  setGCConfig(config: Partial<GCControllerConfig>) {
    gcController?.setConfig(config);
  },

  getGCStats(): GCControllerStats | null {
    return gcController?.getStats() ?? null;
  },

  forceMajorGC() {
    gcController?.forceMajor();
  },

  sendCommand(cmd: any) {
    if (!simulation) return;
    try {
      const result = simulation.handleCommand(cmd);
      events.emit("performance", { commandResult: result, commandType: cmd.type });
    } catch (err) {
      events.emit("error", { message: `Command ${cmd.type} failed: ${(err as Error).message}` });
    }
  },

  sendWorldCommand(cmd: any) {
    if (!simulation) return;
    try {
      const result = simulation.handleWorldCommand(cmd);
      events.emit("performance", { worldCommandResult: result });
    } catch (err) {
      events.emit("error", { message: `World command failed: ${(err as Error).message}` });
    }
  },

  setWeather(weatherType: number) { simulation?.setWeather(weatherType); },
  setTimeOfDay(time: number) { simulation?.setTimeOfDay(time); },

  setSimSpeed(speed: number) {
    simLoop?.setSpeed(speed);
    events.emit("sim_speed_changed", { speed: simLoop?.getSpeed() ?? speed });
  },

  getSimSpeed(): number {
    return simLoop?.getSpeed() ?? 1.0;
  },

  setPhysicsProfiler(enabled: boolean) {
    simulation?.getPhysics()?.setProfilerEnabled(enabled);
  },

  async restoreFromState(stateJson: string): Promise<void> {
    if (!simulation || !stateHelper) throw new Error("Simulation not initialized");
    simLoop?.pause();
    await stateHelper.restoreState(stateJson);
    // Re-emit boat designs to renderer
    for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
      events.emit("boat_design_update", { entityId, designJson: JSON.stringify(design) });
    }
    simLoop?.resume();
    // Transition complete — trigger major GC to clean up restore allocations
    gcController?.collectMajor();
  },
}));

// --- Event forwarding ---

function drainAndForwardEvents(): void {
  if (!simulation) return;
  const tickCount = simLoop?.getTickCount() ?? 0;
  const deformBroadcasts = simulation.getTerrainSystem().drainBroadcasts();
  if (deformBroadcasts.length > 0) {
    events.emit("terrain_deformed", deformBroadcasts);
  }
  const lodChanges = simulation.getTerrainSystem().drainLODChanges();
  if (lodChanges.length > 0) {
    events.emit("terrain_lod_changed", lodChanges);
  }
  if (debugMode && tickCount % 30 === 0) {
    const log = simulation.getCollisionLog();
    if (log.length > 0) {
      events.emit("collision_log", log);
    }
  }
  if (tickCount % 300 === 0) {
    events.emit("performance", { tick: tickCount, msg: "sim ticking" });
  }
}

// --- SimWorkerLoop setup ---

simLoop = new SimWorkerLoop({
  fixedDt: SIM_TICK_DT,
  maxSpeed: MAX_SIM_SPEED,
  minSpeed: MIN_SIM_SPEED,
  tick: async (dt: number) => {
    if (simulation) await simulation.tick(dt);
  },
  onAfterTicks: (_ticksThisIteration: number) => {
    drainAndForwardEvents();
    // Flush devtools data feeds to SAB so the renderer can read them
    // synchronously (zero-copy, no IPC polling).
    devtools.flushDataFeeds();
  },
  onError: (err: Error) => {
    const errMsg = `Sim tick crashed at tick ${simLoop?.getTickCount()}: ${err.message}\n${err.stack}`;
    console.error(`[SIM WORKER] ${errMsg}`);
    events.emit("error", { message: errMsg });
    setTimeout(() => getWorkerHost().close(), 0);
  },
});

// Error handlers
self.onerror = ((e: ErrorEvent) => {
  const msg = `Sim worker uncaught error: ${e.message}`;
  console.error(`[SIM WORKER] ${msg}`);
  events.emit("error", { message: msg });
  simLoop?.stop();
}) as any;

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
  const err = e.reason as Error;
  const msg = `Sim worker unhandled rejection: ${err?.message ?? err}\n${err?.stack ?? ""}`;
  console.error(`[SIM WORKER] ${msg}`);
  events.emit("error", { message: msg });
  simLoop?.stop();
};

// Start the loop — init() is called via RPC when the main thread sends it
simLoop.start();
