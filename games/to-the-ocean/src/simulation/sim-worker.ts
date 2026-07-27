// ============================================================================
// Simulation Worker — authoritative game state, runs in a worker thread
// ============================================================================

import { parentPort, workerData } from "worker_threads";
import { Simulation } from "./Simulation";
import { SimBufferWriter } from "../shared/sim-buffer";
import { InputBufferReader } from "../shared/input-buffer";
import { WaterBufferWriter } from "../shared/water-buffer";
import { BoatBufferWriter } from "../shared/boat-buffer";
import { MainToSimMessage, SimToMainMessage, SimCommand } from "../shared/types";
import { startGCProfiler, type GCProfilerHandle, type GCStats } from "../shared/gc-profiler";

const data = workerData as {
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

const onEvent = (msg: SimToMainMessage) => { parentPort?.postMessage(msg); };
const simulation = new Simulation(simWriter, inputReader, waterWriter, data.config, onEvent, boatWriter, data.boatBuffer);

simulation.onDesignChanged = (entityId, designJson) => {
  parentPort?.postMessage({ kind: "boat_design_update", data: { entityId, designJson } } as SimToMainMessage);
};

simulation.onDesignRemoved = (entityId) => {
  parentPort?.postMessage({ kind: "boat_design_remove", data: { entityId } } as SimToMainMessage);
};

let gcHandle: GCProfilerHandle | null = null;
let debugMode = false;

let running = true;
let paused = false;
let tickCount = 0;

process.on("uncaughtException", (err) => {
  const msg = `Sim worker uncaughtException: ${err.message}\n${err.stack}`;
  console.error(`[SIM WORKER] ${msg}`);
  parentPort?.postMessage({ kind: "error", data: { message: msg } } as SimToMainMessage);
  running = false;
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  const msg = `Sim worker unhandledRejection: ${(err as Error)?.message ?? err}\n${(err as Error)?.stack ?? ""}`;
  console.error(`[SIM WORKER] ${msg}`);
  parentPort?.postMessage({ kind: "error", data: { message: msg } } as SimToMainMessage);
  running = false;
  process.exit(1);
});

process.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[SIM WORKER] Process exiting with code ${code}`);
  }
});

async function init(): Promise<void> {
  await simulation.init();
  parentPort?.postMessage({ kind: "ready", data: {} } as SimToMainMessage);

  // Push initial designs after the ready signal so main/renderer listeners are attached.
  for (const { entityId, design } of simulation.getBoatDesignSystem().getDesigns()) {
    parentPort?.postMessage({ kind: "boat_design_update", data: { entityId, designJson: JSON.stringify(design) } } as SimToMainMessage);
  }
}

const TICK_MS = 1000 / 60;
let lastTick = performance.now();

function loop(): void {
  if (!running) return;

  const now = performance.now();
  if (now - lastTick >= TICK_MS) {
    lastTick = now - ((now - lastTick) % TICK_MS);
    if (!paused) {
      try {
        simulation.tick();
        tickCount++;

        // Forward terrain deformation broadcasts to renderer
        const deformBroadcasts = simulation.getTerrainSystem().drainBroadcasts();
        if (deformBroadcasts.length > 0) {
          console.log(`[SIM WORKER] Broadcasting ${deformBroadcasts.length} terrain deformations`);
          parentPort?.postMessage({ kind: "terrain_deformed", data: deformBroadcasts } as SimToMainMessage);
        }

        // Forward LOD changes to renderer (island resolution changes)
        const lodChanges = simulation.getTerrainSystem().drainLODChanges();
        if (lodChanges.length > 0) {
          parentPort?.postMessage({ kind: "terrain_lod_changed", data: lodChanges } as SimToMainMessage);
        }

        // Post collision log every 30 ticks (~0.5s) when debug mode is on
        if (debugMode && tickCount % 30 === 0) {
          const log = simulation.getCollisionLog();
          if (log.length > 0) {
            parentPort?.postMessage({ kind: "collision_log", data: log } as SimToMainMessage);
          }
        }
        if (tickCount % 300 === 0) {
          parentPort?.postMessage({ kind: "performance", data: { tick: tickCount, msg: "sim ticking" } } as SimToMainMessage);
        }
      } catch (err) {
        const msg = `Sim tick crashed at tick ${tickCount}: ${(err as Error).message}\n${(err as Error).stack}`;
        console.error(`[SIM WORKER] ${msg}`);
        parentPort?.postMessage({ kind: "error", data: { message: msg } } as SimToMainMessage);
        running = false;
        process.exit(1);
      }
    }
  }

  setTimeout(loop, Math.max(1, TICK_MS - (performance.now() - now)));
}

parentPort?.on("message", (msg: MainToSimMessage) => {
  switch (msg.kind) {
    case "pause":
      paused = true;
      break;
    case "resume":
      paused = false;
      break;
    case "save":
      simulation.save(msg.data.slotName).then(() => {
        parentPort?.postMessage({ kind: "saved", data: { slotName: msg.data.slotName, stateJson: simulation.serializeState() } } as SimToMainMessage);
      }).catch((err) => {
        parentPort?.postMessage({ kind: "error", data: { message: `Save failed: ${err.message}` } } as SimToMainMessage);
      });
      break;
    case "load":
      try {
        if (msg.data.stateJson) {
          simulation.restoreState(msg.data.stateJson);
        }
        parentPort?.postMessage({ kind: "loaded", data: { slotName: msg.data.slotName } } as SimToMainMessage);
      } catch (err) {
        parentPort?.postMessage({ kind: "error", data: { message: `Load failed: ${(err as Error).message}` } } as SimToMainMessage);
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
      parentPort?.close();
      break;
    case "debug_mode": {
      const enabled = msg.data?.enabled === true;
      debugMode = enabled;
      if (enabled && !gcHandle) {
        gcHandle = startGCProfiler('sim-worker', (stats: GCStats) => {
          parentPort?.postMessage({ kind: "gc_stats", data: stats } as SimToMainMessage);
        });
      } else if (!enabled && gcHandle) {
        gcHandle.stop();
        gcHandle = null;
      }
      break;
    }
    case "command": {
      const cmd = msg.data as SimCommand;
      try {
        const result = simulation.handleCommand(cmd);
        parentPort?.postMessage({ kind: "performance", data: { commandResult: result, commandType: cmd.type } } as SimToMainMessage);
      } catch (err) {
        parentPort?.postMessage({ kind: "error", data: { message: `Command ${cmd.type} failed: ${(err as Error).message}` } } as SimToMainMessage);
      }
      break;
    }
    case "world_command": {
      try {
        const result = simulation.handleWorldCommand(msg.data);
        parentPort?.postMessage({ kind: "performance", data: { worldCommandResult: result } } as SimToMainMessage);
      } catch (err) {
        parentPort?.postMessage({ kind: "error", data: { message: `World command failed: ${(err as Error).message}` } } as SimToMainMessage);
      }
      break;
    }
    case "set_weather": {
      simulation.setWeather(msg.data.weatherType);
      break;
    }
    case "set_time_of_day": {
      simulation.setTimeOfDay(msg.data.time);
      break;
    }
  }
});

init().then(() => {
  loop();
}).catch((err) => {
  const msg = `Sim init failed: ${err.message}\n${err.stack}`;
  console.error(`[SIM WORKER] ${msg}`);
  parentPort?.postMessage({ kind: "error", data: { message: msg } } as SimToMainMessage);
});
