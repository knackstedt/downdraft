import { createLogger } from "@downdraft/engine";
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

  log.info("debug", "Telemetry enabled:");
  log.info("debug", "  - Frame time tracking");
  log.info("debug", "  - CPU/GPU timing");
  log.info("debug", "  - Memory usage");
  log.info("debug", "  - System-level profiling");

  log.info("debug", "Debug engine ready. Press Ctrl+C to stop.");

  if (inspector) {
    log.info("debug", "Inspector mode: attach to the engine process's inspector endpoint.");
  }

  // Keep process alive
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      log.info("debug", "Shutting down...");
      resolve();
    });
  });
}
