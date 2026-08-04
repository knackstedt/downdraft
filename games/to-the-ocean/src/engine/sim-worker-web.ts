// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a renderer Web Worker
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// Uses the RPC layer (expose/exposeEvents) for typed async communication.
// ============================================================================

import { SimStateHelper, SimWorkerLoop, TransientStateRegistry, startGCProfiler, type GCProfilerHandle, type GCStats } from "@downdraft/core";
import { expose, exposeEvents, getWorkerHost } from "@downdraft/core/worker/rpc";
import { BoatBufferWriter } from "@shared/boat-buffer";
import { MAX_SIM_SPEED, MIN_SIM_SPEED, SIM_TICK_DT } from "@shared/constants/buffer";
import { InputBufferReader } from "@shared/input-buffer";
import { PLR_FLAG, SimBufferWriter } from "@shared/sim-buffer";
import { SimToMainMessage } from "@shared/types";
import { WaterBufferWriter } from "@shared/water-buffer";
import { Simulation } from "@sim/simulation";

let simulation: Simulation | null = null;
let stateHelper: SimStateHelper | null = null;
let gcHandle: GCProfilerHandle | null = null;
let debugMode = false;
let perfTimer: ReturnType<typeof setInterval> | null = null;
let perfWallStart = 0;

let simLoop: SimWorkerLoop | null = null;

const events = exposeEvents();

const onEvent = (msg: SimToMainMessage) => { events.emit(msg.kind, msg.data); };

expose({
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
  },

  pause() { simLoop?.pause(); },
  resume() { simLoop?.resume(); },

  async save(slotName: string): Promise<{ slotName: string; stateJson: string }> {
    if (!simulation || !stateHelper) throw new Error("Simulation not initialized");
    const stateJson = stateHelper.saveState();
    events.emit("saved", { slotName, stateJson });
    return { slotName, stateJson };
  },

  async load(slotName: string, stateJson?: string): Promise<boolean> {
    if (!simulation) throw new Error("Simulation not initialized");
    if (stateJson) {
      simulation.restoreState(stateJson);
    }
    events.emit("loaded", { slotName });
    return true;
  },

  setGamemode(mode: number) { simulation?.setGamemode(mode); },
  addPlayer(playerId: number, name: string) { simulation?.addPlayer(playerId, name); },
  removePlayer(playerId: number) { simulation?.removePlayer(playerId); },
  setSetting(key: string, value: number | boolean) { simulation?.setSetting(key, value); },
  respawnPlayer(playerId: number) { simulation?.respawnPlayer(playerId); },

  shutdown() {
    simLoop?.stop();
    gcHandle?.stop();
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

  async restoreFromState(stateJson: string): Promise<void> {
    if (!simulation || !stateHelper) throw new Error("Simulation not initialized");
    simLoop?.pause();
    await stateHelper.restoreState(stateJson);
    // Re-emit boat designs to renderer
    for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
      events.emit("boat_design_update", { entityId, designJson: JSON.stringify(design) });
    }
    simLoop?.resume();
  },
});

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
