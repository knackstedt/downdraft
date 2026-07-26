import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { resolve } from "path";

const log = createLogger();
const ROOT = resolve(import.meta.dir, "../../..");

export async function dev(args: string[]): Promise<void> {
  const watch = args.includes("--watch");

  log.info("DownDraft", "Starting in dev mode...");
  log.info("DownDraft", `Hot reload: ${watch}`);

  const entry = resolve(ROOT, "src", "bun", "index.ts");

  const child = spawn("bun", ["run", entry], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
    },
    detached: true,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("DownDraft", "Shutting down...");
    child.kill("SIGINT");
    setTimeout(() => {
      // Kill entire process group (child + renderer) as fallback
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
