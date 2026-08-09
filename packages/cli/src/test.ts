import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const log = createLogger();

type Renderer = "gpu" | "cpu";

interface TestArgs {
  game: string;
  mcpPort: number;
  spec: string | null;
  renderer: Renderer;
  deterministic: boolean;
  headed: boolean;
  verbose: boolean;
}

function parseArgs(args: string[]): TestArgs {
  const opts: TestArgs = {
    game: "to-the-ocean",
    mcpPort: 9976,
    spec: null,
    renderer: "cpu",
    deterministic: true,
    headed: false,
    verbose: args.includes("--verbose") || args.includes("-v"),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--game" || arg === "-g") {
      opts.game = args[++i] ?? opts.game;
    } else if (arg === "--port" || arg === "-p") {
      opts.mcpPort = parseInt(args[++i] ?? "", 10) || opts.mcpPort;
    } else if (arg === "--spec" || arg === "-s") {
      opts.spec = args[++i] ?? null;
    } else if (arg === "--renderer" || arg === "-r") {
      const v = args[++i] as Renderer | undefined;
      if (v === "gpu" || v === "cpu") opts.renderer = v;
    } else if (arg.startsWith("--renderer=")) {
      const v = arg.slice("--renderer=".length) as Renderer;
      if (v === "gpu" || v === "cpu") opts.renderer = v;
    } else if (arg === "--no-deterministic") {
      opts.deterministic = false;
    } else if (arg === "--headed") {
      opts.headed = true;
    }
  }

  return opts;
}

/**
 * Check whether xvfb-run is available on the system.
 */
function hasXvfb(): boolean {
  try {
    return existsSync("/usr/bin/xvfb-run") || existsSync("/usr/local/bin/xvfb-run");
  } catch {
    return false;
  }
}

export async function runTest(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const ROOT = resolve(import.meta.dir, "../../..");

  const specPath = opts.spec
    ? resolve(opts.spec)
    : resolve(ROOT, "tests", "e2e", `${opts.game}-smoke.spec.ts`);

  log.info("test", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — E2E Test Runner     ║
  ╚══════════════════════════════════════════╝
  `);

  log.info("test", `  Game:          ${opts.game}`);
  log.info("test", `  Spec:          ${specPath}`);
  log.info("test", `  MCP port:      ${opts.mcpPort}`);
  log.info("test", `  Renderer:      ${opts.renderer === "cpu" ? "SwiftShader (software)" : "hardware GPU"}`);
  log.info("test", `  Deterministic: ${opts.deterministic}`);
  log.info("test", `  Headed:        ${opts.headed}`);
  log.info("test", "");

  const env: Record<string, string> = {
    ...process.env,
    DOWNDRAFT_GAME: opts.game,
    MCP_PORT: String(opts.mcpPort),
    MCP_TIMEOUT_MS: "120000",
  };

  if (opts.renderer === "cpu") {
    env.DOWNDRAFT_GPU = "swiftshader";
  } else {
    env.DOWNDRAFT_GPU = "hardware";
  }
  if (opts.deterministic) {
    env.DOWNDRAFT_DETERMINISTIC = "1";
  }
  if (opts.headed) {
    // Show the window instead of running headless.
    env.DOWNDRAFT_HEADED = "1";
  }
    env.DOWNDRAFT_DETERMINISTIC = "1";
  }

  // Critical: Electron must NOT run as Node.js.
  delete env.ELECTRON_RUN_AS_NODE;

  // If no display is available, wrap in xvfb-run (common in CI).
  let cmd = "bun";
  let cmdArgs = ["test", specPath];
  const noDisplay = !env.DISPLAY;
  if (noDisplay && hasXvfb()) {
    log.info("test", "No DISPLAY detected — wrapping in xvfb-run");
    cmd = "xvfb-run";
    cmdArgs = ["-a", "--", "bun", "test", specPath];
  } else if (noDisplay) {
    log.warn("test", "No DISPLAY and xvfb-run not found — Electron may fail to start.");
    log.warn("test", "Install xvfb with: sudo apt install xvfb");
  }

  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });

  child.on("exit", (code) => {
    if (code === 0) {
      log.info("test", "All tests passed.");
    } else {
      log.error("test", `Tests failed with exit code ${code}.`);
    }
    process.exit(code ?? 1);
  });

  const shutdown = () => {
    try { child.kill("SIGINT"); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
