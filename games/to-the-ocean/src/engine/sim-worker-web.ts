// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a renderer Web Worker
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// Uses the RPC layer (expose/exposeEvents) for typed async communication.
// ============================================================================

import { expose, exposeEvents, getWorkerHost } from "@downdraft/core/worker/rpc";
import { BoatBufferWriter } from "@shared/boat-buffer";
import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@shared/gc-profiler";
import { InputBufferReader } from "@shared/input-buffer";
import { SimBufferWriter } from "@shared/sim-buffer";
import { SimToMainMessage } from "@shared/types";
import { WaterBufferWriter } from "@shared/water-buffer";
import { Simulation } from "@sim/Simulation";

let simulation: Simulation | null = null;
let gcHandle: GCProfilerHandle | null = null;
let debugMode = false;
let running = true;
let paused = false;
let tickCount = 0;
let tickTimeAccum = 0;
let perfTimer: ReturnType<typeof setInterval> | null = null;
let perfWallStart = 0;

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

    // Push initial designs after init
    for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
      events.emit("boat_design_update", { entityId, designJson: JSON.stringify(design) });
    }
  },

  pause() { paused = true; },
  resume() { paused = false; },

  async save(slotName: string): Promise<{ slotName: string; stateJson: string }> {
    if (!simulation) throw new Error("Simulation not initialized");
    const stateJson = simulation.serializeState();
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
    running = false;
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
      tickTimeAccum = 0;
      perfWallStart = performance.now();
      perfTimer = setInterval(() => {
        const now = performance.now();
        const wallMs = now - perfWallStart;
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
        tickTimeAccum = 0;
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
});

const TICK_MS = 1000 / 60;
let lastTick = performance.now();

function loop(): void {
  if (!running) return;

  const now = performance.now();
  if (now - lastTick >= TICK_MS) {
    lastTick = now - ((now - lastTick) % TICK_MS);
    if (!paused && simulation) {
      try {
        const tickStart = performance.now();
        simulation.tick();
        tickTimeAccum += performance.now() - tickStart;
        tickCount++;

        // Forward terrain deformation broadcasts to renderer
        const deformBroadcasts = simulation.getTerrainSystem().drainBroadcasts();
        if (deformBroadcasts.length > 0) {
          events.emit("terrain_deformed", deformBroadcasts);
        }

        // Forward LOD changes to renderer
        const lodChanges = simulation.getTerrainSystem().drainLODChanges();
        if (lodChanges.length > 0) {
          events.emit("terrain_lod_changed", lodChanges);
        }

        // Post collision log every 30 ticks (~0.5s) when debug mode is on
        if (debugMode && tickCount % 30 === 0) {
          const log = simulation.getCollisionLog();
          if (log.length > 0) {
            events.emit("collision_log", log);
          }
        }
        if (tickCount % 300 === 0) {
          events.emit("performance", { tick: tickCount, msg: "sim ticking" });
        }
      } catch (err) {
        const errMsg = `Sim tick crashed at tick ${tickCount}: ${(err as Error).message}\n${(err as Error).stack}`;
        console.error(`[SIM WORKER] ${errMsg}`);
        events.emit("error", { message: errMsg });
        running = false;
        setTimeout(() => getWorkerHost().close(), 0);
        return;
      }
    }
  }

  setTimeout(loop, Math.max(1, TICK_MS - (performance.now() - now)));
}

// Error handlers
self.onerror = (e: ErrorEvent) => {
  const msg = `Sim worker uncaught error: ${e.message}`;
  console.error(`[SIM WORKER] ${msg}`);
  events.emit("error", { message: msg });
  running = false;
};

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
  const err = e.reason as Error;
  const msg = `Sim worker unhandled rejection: ${err?.message ?? err}\n${err?.stack ?? ""}`;
  console.error(`[SIM WORKER] ${msg}`);
  events.emit("error", { message: msg });
  running = false;
};

// Start the loop — init() is called via RPC when the main thread sends it
loop();
