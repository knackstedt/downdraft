import { Builder, createLogger } from "@downdraft/core";
import { watch } from "fs";

const log = createLogger();

export async function debug(args: string[]): Promise<void> {
  const projectPath = args[0] ?? ".";
  const verbose = args.includes("--verbose") || args.includes("-v");
  const noDevtools = args.includes("--no-devtools");
  const inspector = args.includes("--inspector");

  const builder = new Builder("debug");
  const config = builder.getConfig();

  console.log(`
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — Debug Mode          ║
  ╚══════════════════════════════════════════╝
  `);

  console.log(`  Project:  ${projectPath}`);
  console.log(`  Mode:     debug`);
  console.log(`  DevTools: ${noDevtools ? "disabled" : "enabled"}`);
  console.log(`  Verbose:  ${verbose ? "on" : "off"}`);
  console.log(`  Inspector: ${inspector ? "on" : "off"}`);
  console.log("");

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
