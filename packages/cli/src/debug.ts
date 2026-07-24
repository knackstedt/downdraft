import { Builder, type BuilderMode } from "@downdraft/core";
import { watch } from "fs";

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
    console.log("  Debug features enabled:");
    console.log("    - Debug draw queue (lines, points, text)");
    console.log("    - Wireframe / normals / AABB visualization");
    console.log("    - Performance profiler (frame time, system timings)");
    console.log("    - Entity inspector");
    console.log("    - Debug visualization modes");
    console.log("");
  }

  if (config.telemetry) {
    console.log("  Telemetry enabled:");
    console.log("    - Frame time tracking");
    console.log("    - CPU/GPU timing");
    console.log("    - Memory usage");
    console.log("    - System-level profiling");
    console.log("");
  }

  // Watch for file changes and hot-reload
  if (config.hotReload) {
    console.log("  Hot reload: watching for changes...");
    try {
      watch(projectPath, { recursive: true }, (event, filename) => {
        if (verbose) {
          console.log(`  [watch] ${event}: ${filename}`);
        }
        if (filename && (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".wgsl"))) {
          console.log(`  [hot-reload] ${filename} changed — reloading...`);
        }
      });
    } catch {
      console.log("  [hot-reload] File watching not available on this platform");
    }
  }

  console.log("");
  console.log("  Debug engine ready. Press Ctrl+C to stop.");
  console.log("");

  if (inspector) {
    console.log("  Inspector mode: connect chrome://inspect to debug the engine process.");
    }

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\n  [debug] Shutting down...");
      resolve();
    });
  });
}
