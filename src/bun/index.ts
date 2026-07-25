import { SharedMemoryIPC, parseShmPath } from "../../packages/core/src/ipc/shared-memory.ts";

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
    console.log("[DownDraft] Copied Ultralight resources to", localResources);
  } catch (e) {
    console.error("[DownDraft] Failed to copy Ultralight resources:", e);
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
  stderr: "inherit",
});

let ipc: SharedMemoryIPC | null = null;
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
          console.log("[DownDraft] Connected to renderer via shared memory:", shmPath);
        } else {
          console.error("[DownDraft] Failed to attach to shared memory");
          ipc = null;
        }
      }
      if (trimmed) console.log(`[renderer] ${trimmed}`);
    }
  }
})();

// Handle cleanup
process.on("exit", () => {
  ipc?.quit();
  proc.kill();
});

// Poll telemetry every 2 seconds for verification
setInterval(() => {
  if (ipc) {
    const tlm = ipc.readTelemetry();
    if (tlm) {
      console.log(`[DownDraft] Telemetry: FPS=${tlm.fps}, frameTime=${tlm.frameTimeUs}us, entities=${tlm.entityCount}, status=${tlm.status}`);
    }
  }
}, 2000);

console.log("[DownDraft] Native renderer spawned, waiting for shared memory connection...");
