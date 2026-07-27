import { SharedMemoryIPC, parseShmPath } from "../../packages/core/src/ipc/shared-memory.ts";
import { createLogger } from "../../packages/core/src/util/logger.ts";

const log = createLogger();

// Load the example game module
const examplePath = process.env.DOWNDRAFT_EXAMPLE ?? "examples/ocean-game/main.ts";
const exampleDir = `${import.meta.dir}/../..`;
const exampleModule = await import(`${exampleDir}/${examplePath}`);

// Spawn the native Rust renderer
const rendererDir = `${import.meta.dir}/../../native-renderer`;
const rendererPath = `${rendererDir}/target/debug/native-renderer`;
const SDK_DIR = `${rendererDir}/target/debug/build`;

// Find the Ultralight SDK lib directory
import { cpSync, existsSync, readdirSync } from "fs";
import { join } from "path";

let ulLibPath = "";
let ulResourcesPath = "";
try {
  const buildDirs = readdirSync(SDK_DIR).filter((d) => d.startsWith("ul-next-sys-"));
  for (const dir of buildDirs) {
    const candidate = join(SDK_DIR, dir, "out", "ul-sdk", "bin");
    const resCandidate = join(SDK_DIR, dir, "out", "ul-sdk", "resources");
    try {
      readdirSync(candidate);
      ulLibPath = candidate;
      ulResourcesPath = resCandidate;
      break;
    } catch {}
  }
} catch {}

// Copy Ultralight resources to the renderer working directory if not present
const localResources = join(rendererDir, "resources");
if (ulResourcesPath && !existsSync(localResources)) {
  try {
    cpSync(ulResourcesPath, localResources, { recursive: true });
    log.info("DownDraft", `Copied Ultralight resources to ${localResources}`);
  } catch (e) {
    log.error("DownDraft", `Failed to copy Ultralight resources: ${e}`);
  }
}

const env = { ...process.env };
if (ulLibPath) {
  env.LD_LIBRARY_PATH = `${ulLibPath}:${env.LD_LIBRARY_PATH ?? ""}`;
}

const proc = Bun.spawn([rendererPath], {
  env,
  cwd: rendererDir,
  stdout: "pipe",
  stderr: "pipe",
});

let ipc: SharedMemoryIPC | null = null;
let rendererReady = false;
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();

// Read stdout until we find the SHM_PATH line
(async () => {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      const shmPath = parseShmPath(trimmed);
      if (shmPath && !ipc) {
        ipc = new SharedMemoryIPC();
        if (ipc.attach(shmPath)) {
          log.info("DownDraft", `Connected to renderer via shared memory: ${shmPath}`);
          rendererReady = true;
        } else {
          log.error("DownDraft", "Failed to attach to shared memory");
          ipc = null;
        }
      }
      if (trimmed) log.info("renderer", trimmed.replace(/^\[renderer\]\s*/, ""));
    }
  }
})();

// Read stderr and forward through the formatted logger at warn level
(async () => {
  const stderrReader = proc.stderr.getReader();
  let stderrBuffer = "";
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    stderrBuffer += decoder.decode(value, { stream: true });
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const modMatch = trimmed.match(/^\[(.+?)\]\s*(.*)/);
      if (modMatch) {
        log.warn(modMatch[1], modMatch[2]);
      } else {
        log.warn("renderer", trimmed);
      }
    }
  }
})();

// Handle cleanup
process.on("exit", () => {
  if (exampleModule.dispose) exampleModule.dispose({});
  ipc?.quit();
  try { proc.kill(); } catch {}
});

// Forceful shutdown: kill renderer immediately then exit
function forceShutdown(code: number) {
  try { proc.kill(); } catch {}
  ipc?.quit();
  process.exit(code);
}

// Handle Ctrl+C — registered at top level so it works even before the renderer connects
process.on("SIGINT", () => {
  log.info("DownDraft", "Received SIGINT, shutting down...");
  forceShutdown(130);
});
process.on("SIGTERM", () => {
  log.info("DownDraft", "Received SIGTERM, shutting down...");
  forceShutdown(143);
});

// Detect renderer exit
proc.exited.then((code) => {
  log.info("DownDraft", `Renderer exited with code ${code}`);
  if (exampleModule.dispose) exampleModule.dispose({});
  process.exit(code ?? 0);
});

log.info("DownDraft", "Native renderer spawned, waiting for shared memory connection...");

// Wait for renderer to be ready, then init the game and start the game loop
const SIM_TICK_DT = 1 / 60;

(async () => {
  // Wait for IPC connection
  while (!rendererReady) {
    await Bun.sleep(10);
  }

  // Send LoadScene command to renderer (once)
  ipc!.loadScene("ocean-survival");

  // Initialize the game (async — yields between island generations)
  if (exampleModule.init) {
    await exampleModule.init({ device: null });
  }

  // Game loop
  let lastTime = performance.now();
  let running = true;

  while (running) {
    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    if (dt < SIM_TICK_DT) {
      await Bun.sleep(SIM_TICK_DT * 1000 - dt * 1000);
      dt = SIM_TICK_DT;
    }
    dt = Math.min(SIM_TICK_DT, dt);
    lastTime = performance.now();

    if (exampleModule.tick) {
      // Read keyboard input from shared memory (written by Rust renderer)
      if (ipc) {
        const inputState = ipc.readInput();
        // The game's init() sets up the input resource; we update it here
        // The game systems read from ecsWorld.getResource("input")
        // We pass it via ctx so the game can pick it up
        exampleModule.tick({ device: null, ipc: ipc, input: inputState }, dt);
      } else {
        exampleModule.tick({ device: null, ipc: ipc }, dt);
      }
    }

    // Write island mesh data to shared memory whenever new islands have been generated
    if (ipc && exampleModule.getMeshData && (exampleModule as any).consumeMeshesDirty) {
      if ((exampleModule as any).consumeMeshesDirty()) {
        const meshData = exampleModule.getMeshData();
        if (meshData && meshData.length > 0) {
          log.info("DownDraft", `Writing ${meshData.length} island meshes to shared memory`);
          ipc.writeMeshData(meshData);
        }
      }
    }

    // Write render data to shared memory for the renderer
    if (exampleModule.getRenderData && ipc) {
      const renderData = exampleModule.getRenderData();
      ipc.writeRenderData(renderData);
    }

    // Write water heightfield data to shared memory for the renderer
    if (exampleModule.getWaterData && ipc) {
      const waterData = exampleModule.getWaterData();
      if (waterData.chunks.length === 0) {
        log.warn("DownDraft", `getWaterData returned 0 chunks!`);
      }
      ipc.writeWaterData(waterData);
    }

    // Write weather visual data to shared memory for the renderer
    if (exampleModule.getWeatherVisual && ipc) {
      const weatherVisual = exampleModule.getWeatherVisual();
      ipc.writeWeatherVisual(weatherVisual);
    }

    // Write game state (death overlay) to shared memory for the renderer
    if (exampleModule.getGameState && ipc) {
      const gameState = exampleModule.getGameState();
      ipc.writeGameState(gameState.isDead, gameState.cause, gameState.biome ?? 0);
    }

    // Write inventory data to shared memory for the renderer UI
    if (exampleModule.getInventoryState && ipc) {
      const invJson = exampleModule.getInventoryState();
      ipc.writeInventory(invJson);
    }

    // Poll for respawn request from the renderer UI
    if (ipc && ipc.readRespawnRequest()) {
      if (exampleModule.respawn) {
        exampleModule.respawn();
        log.info("DownDraft", "Respawn triggered by player");
      }
    }

    // Poll for craft request from the renderer UI (recipe click)
    if (ipc) {
      const recipeId = ipc.readCraftRequest();
      if (recipeId && (exampleModule as any).craftByRecipeId) {
        (exampleModule as any).craftByRecipeId(recipeId);
      }
    }

    // Check if renderer is still alive
    if (proc.killed || proc.exitCode !== null) {
      running = false;
    }
  }

  if (exampleModule.dispose) {
    exampleModule.dispose({});
  }
  ipc?.quit();
  process.exit(0);
})();
