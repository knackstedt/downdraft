// ============================================================================
// Simulation Web Worker — runs the authoritative sim inside a renderer Web Worker
// Replaces the Node.js worker_threads sim-worker.ts for the renderer process.
// SharedArrayBuffers are shared directly with the renderer — zero-copy state.
// ============================================================================

import { BoatBufferWriter } from "@shared/boat-buffer";
import { startGCProfiler, type GCProfilerHandle, type GCStats } from "@shared/gc-profiler";
import { InputBufferReader } from "@shared/input-buffer";
import { SimBufferWriter } from "@shared/sim-buffer";
import { MainToSimMessage, SimToMainMessage } from "@shared/types";
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

const onEvent = (msg: SimToMainMessage) => { (self as unknown as Worker).postMessage(msg); };

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  // Initial init message carries SharedArrayBuffers + config
  if (msg.kind === "init") {
    const data = msg as {
      simBuffer: SharedArrayBuffer;
      inputBuffer: SharedArrayBuffer;
      waterBuffer: SharedArrayBuffer;
      boatBuffer: SharedArrayBuffer;
      config: { seed: number; gamemode: number; rules: Record<string, number | boolean>; isDev?: boolean };
    };

    const simWriter = new SimBufferWriter(data.simBuffer);
    simWriter.init();

    const inputReader = new InputBufferReader(data.inputBuffer);
    const waterWriter = new WaterBufferWriter(data.waterBuffer);
    waterWriter.init(4);

    const boatWriter = new BoatBufferWriter(data.boatBuffer);
    boatWriter.init();

    simulation = new Simulation(simWriter, inputReader, waterWriter, data.config, onEvent, boatWriter, data.boatBuffer);

    simulation.onDesignChanged = (entityId, designJson) => {
      (self as unknown as Worker).postMessage({ kind: "boat_design_update", data: { entityId, designJson } } as SimToMainMessage);
    };

    simulation.onDesignRemoved = (entityId) => {
      (self as unknown as Worker).postMessage({ kind: "boat_design_remove", data: { entityId } } as SimToMainMessage);
    };

    init();
    return;
  }

  // All other messages are MainToSimMessage commands
  handleCommand(msg as MainToSimMessage);
};

async function init(): Promise<void> {
  if (!simulation) return;
  await simulation.init();
  (self as unknown as Worker).postMessage({ kind: "ready", data: {} } as SimToMainMessage);

  // Push initial designs after the ready signal
  for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
    (self as unknown as Worker).postMessage({ kind: "boat_design_update", data: { entityId, designJson: JSON.stringify(design) } } as SimToMainMessage);
  }
}

function handleCommand(msg: MainToSimMessage): void {
  if (!simulation) return;

  switch (msg.kind) {
    case "pause":
      paused = true;
      break;
    case "resume":
      paused = false;
      break;
    case "save":
      simulation.save(msg.data.slotName).catch((err) => {
        onEvent({ kind: "error", data: { message: `Save failed: ${err.message}` } });
      });
      break;
    case "load":
      try {
        if (msg.data.stateJson) {
          simulation.restoreState(msg.data.stateJson);
        }
        onEvent({ kind: "loaded", data: { slotName: msg.data.slotName } });
      } catch (err) {
        onEvent({ kind: "error", data: { message: `Load failed: ${(err as Error).message}` } });
      }
      break;
    case "set_gamemode":
      simulation.setGamemode(msg.data.mode);
      break;
    case "add_player":
      simulation.addPlayer(msg.data.playerId, msg.data.name);
      break;
    case "remove_player":
      simulation.removePlayer(msg.data.playerId);
      break;
    case "set_setting":
      simulation.setSetting(msg.data.key, msg.data.value);
      break;
    case "respawn":
      simulation.respawnPlayer(msg.data.playerId);
      break;
    case "shutdown":
      running = false;
      gcHandle?.stop();
      simulation.shutdown();
      (self as unknown as Worker).close();
      break;
    case "debug_mode": {
      const enabled = msg.data?.enabled === true;
      debugMode = enabled;
      if (enabled && !gcHandle) {
        gcHandle = startGCProfiler('sim-worker', (stats: GCStats) => {
          onEvent({ kind: "gc_stats", data: stats } as SimToMainMessage);
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
          onEvent({ kind: "perf_stats", data: {
            process: "worker",
            cpuPercent,
            memUsedMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
            heapUsedMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
            heapTotalMB: mem ? mem.totalJSHeapSize / 1048576 : 0,
            timestamp: now,
          } } as SimToMainMessage);
          tickTimeAccum = 0;
          perfWallStart = now;
        }, 2000);
      } else if (!enabled && perfTimer) {
        clearInterval(perfTimer);
        perfTimer = null;
      }
      break;
    }
    case "command": {
      const cmd = msg.data;
      try {
        const result = simulation.handleCommand(cmd);
        onEvent({ kind: "performance", data: { commandResult: result, commandType: cmd.type } });
      } catch (err) {
        onEvent({ kind: "error", data: { message: `Command ${cmd.type} failed: ${(err as Error).message}` } });
      }
      break;
    }
    case "world_command": {
      try {
        const result = simulation.handleWorldCommand(msg.data);
        onEvent({ kind: "performance", data: { worldCommandResult: result } });
      } catch (err) {
        onEvent({ kind: "error", data: { message: `World command failed: ${(err as Error).message}` } });
      }
      break;
    }
    case "set_weather":
      simulation.setWeather(msg.data.weatherType);
      break;
    case "set_time_of_day":
      simulation.setTimeOfDay(msg.data.time);
      break;
  }
}

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
          onEvent({ kind: "terrain_deformed", data: deformBroadcasts } as SimToMainMessage);
        }

        // Forward LOD changes to renderer
        const lodChanges = simulation.getTerrainSystem().drainLODChanges();
        if (lodChanges.length > 0) {
          onEvent({ kind: "terrain_lod_changed", data: lodChanges } as SimToMainMessage);
        }

        // Post collision log every 30 ticks (~0.5s) when debug mode is on
        if (debugMode && tickCount % 30 === 0) {
          const log = simulation.getCollisionLog();
          if (log.length > 0) {
            onEvent({ kind: "collision_log", data: log } as SimToMainMessage);
          }
        }
        if (tickCount % 300 === 0) {
          onEvent({ kind: "performance", data: { tick: tickCount, msg: "sim ticking" } } as SimToMainMessage);
        }
      } catch (err) {
        const errMsg = `Sim tick crashed at tick ${tickCount}: ${(err as Error).message}\n${(err as Error).stack}`;
        console.error(`[SIM WORKER] ${errMsg}`);
        onEvent({ kind: "error", data: { message: errMsg } });
        running = false;
        (self as unknown as Worker).close();
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
  onEvent({ kind: "error", data: { message: msg } });
  running = false;
};

self.onunhandledrejection = (e: PromiseRejectionEvent) => {
  const err = e.reason as Error;
  const msg = `Sim worker unhandled rejection: ${err?.message ?? err}\n${err?.stack ?? ""}`;
  console.error(`[SIM WORKER] ${msg}`);
  onEvent({ kind: "error", data: { message: msg } });
  running = false;
};

// Start the loop — init() is called when the init message arrives
loop();
