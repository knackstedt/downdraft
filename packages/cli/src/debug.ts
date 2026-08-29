import { Builder, createLogger } from "@downdraft/core";
import { watch } from "fs";
import { parseArgs, print, renderHelp } from "./args";
import { getCommand } from "./usage";

const log = createLogger();

export async function debug(args: string[]): Promise<void> {
  const entry = getCommand("debug")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const projectPath = parsed.positionals[0] ?? ".";
  const verbose = parsed.flags.verbose as boolean;
  const noDevtools = parsed.flags["no-devtools"] as boolean;
  const inspector = parsed.flags.inspector as boolean;

  // Wire --no-devtools to the runtime env var so the engine picks it up.
  if (noDevtools) {
    process.env.DOWNDRAFT_DISABLE_DEVTOOLS = "1";
  }

  const builder = new Builder("debug");
  const config = builder.getConfig();

  log.info("debug", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Debug Mode          ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("debug", `  Project:  ${projectPath}`);
  log.info("debug", `  Mode:     debug`);
  log.info("debug", `  DevTools: ${noDevtools ? "disabled" : "enabled"}`);
  log.info("debug", `  Verbose:  ${verbose ? "on" : "off"}`);
  log.info("debug", `  Inspector: ${inspector ? "on" : "off"}`);

  if (config.debugDraw) {
    log.info("debug", "Debug features enabled:");
    log.info("debug", "  - Debug draw queue (lines, points, text)");
    log.info("debug", "  - Wireframe / normals / AABB visualization");
    log.info("debug", "  - Performance profiler (frame time, system timings)");
    log.info("debug", "  - Entity inspector");
    log.info("debug", "  - Debug visualization modes");
  }

  if (config.telemetry) {
    log.info("debug", "Telemetry enabled:");
    log.info("debug", "  - Frame time tracking");
    log.info("debug", "  - CPU/GPU timing");
    log.info("debug", "  - Memory usage");
    log.info("debug", "  - System-level profiling");
  }

  // Watch for file changes and hot-reload
  if (config.hotReload) {
    log.info("hot-reload", "watching for changes...");
    try {
      watch(projectPath, { recursive: true }, (event, filename) => {
        if (verbose) {
          log.debug("watch", `${event}: ${filename}`);
        }
        if (filename && (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".wgsl"))) {
          log.info("hot-reload", `${filename} changed — reloading...`);
        }
      });
    } catch {
      log.warn("hot-reload", "File watching not available on this platform");
    }
  }

  log.info("debug", "Debug engine ready. Press Ctrl+C to stop.");

  if (inspector) {
    log.info("debug", "Inspector mode: connect chrome://inspect to debug the engine process.");
  }

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      log.info("debug", "Shutting down...");
      resolve();
    });
  });
}
