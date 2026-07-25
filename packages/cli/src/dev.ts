import { spawn } from "child_process";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "../../..");

export async function dev(args: string[]): Promise<void> {
  const watch = args.includes("--watch");

  console.log("[DownDraft] Starting in dev mode...");
  console.log("[DownDraft] Hot reload:", watch);

  const entry = resolve(ROOT, "src", "bun", "index.ts");

  const child = spawn("bun", ["run", entry], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
}
