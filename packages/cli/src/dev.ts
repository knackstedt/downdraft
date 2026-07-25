import { Builder } from "@downdraft/core";
import { spawn } from "child_process";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "../../..");

export async function dev(args: string[]): Promise<void> {
  const mode = args.includes("--debug") ? "debug" : "dev";
  const watch = args.includes("--watch");
  const builder = new Builder(mode);
  const config = builder.getConfig();

  console.log(`[DownDraft] Starting in ${mode} mode...`);
  console.log(`[DownDraft] Webview: ${config.webview}`);
  console.log(`[DownDraft] Devtools: ${config.devtools}`);
  console.log(`[DownDraft] Telemetry: ${config.telemetry}`);
  console.log(`[DownDraft] Hot reload: ${config.hotReload}`);

  const electrobunBin = resolve(ROOT, "node_modules", ".bin", "electrobun");
  const cmdArgs = ["dev"];
  if (watch) cmdArgs.push("--watch");

  console.log(`[DownDraft] Launching Electrobun...`);

  const child = spawn(electrobunBin, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTROBUN_BUILD_ENV: "dev",
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
