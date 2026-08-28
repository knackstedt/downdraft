import { createLogger } from "@downdraft/core";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectGame } from "./detect-game";

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
  /** When true, build the game with electron-vite before running tests.
   *  The harness then launches the built app (dist/main/index.cjs) instead
   *  of the dev server. */
  build: boolean;
  /** When true, skip the dev server entirely — only run against a pre-built app.
   *  Requires the game to have been built already. */
  buildOnly: boolean;
}

function parseArgs(args: string[]): TestArgs {
  const opts: TestArgs = {
    game: detectGame() ?? "to-the-ocean",
    mcpPort: 9976,
    spec: null,
    renderer: "cpu",
    deterministic: true,
    headed: false,
    verbose: args.includes("--verbose") || args.includes("-v"),
    build: false,
    buildOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue; // skip bun run -- separator
    if (arg === "--game" || arg === "-g") {
      opts.game = args[++i] ?? opts.game;
    } else if (arg.startsWith("--game=")) {
      opts.game = arg.slice("--game=".length);
    } else if (arg === "--port" || arg === "-p") {
      opts.mcpPort = parseInt(args[++i] ?? "", 10) || opts.mcpPort;
    } else if (arg === "--spec" || arg === "-s") {
      opts.spec = args[++i] ?? null;
    } else if (arg.startsWith("--spec=")) {
      opts.spec = arg.slice("--spec=".length);
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
    } else if (arg === "--build") {
      opts.build = true;
    } else if (arg === "--build-only") {
      opts.buildOnly = true;
      opts.build = true; // build-only implies build
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

/**
 * Build the game with electron-vite before running tests.
 * Returns true if the build succeeded, false otherwise.
 */
function buildGame(root: string, game: string): boolean {
  const configPath = resolve(root, "games", game, "electron.vite.config.ts");
  if (!existsSync(configPath)) {
    log.error("test", `No electron.vite.config.ts found for game "${game}" at ${configPath}`);
    return false;
  }
  log.info("test", `Building game "${game}" with electron-vite...`);
  try {
    const result = spawnSync("npx", ["electron-vite", "build", "--config", configPath], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      log.error("test", `Build failed with exit code ${result.status}`);
      return false;
    }
    // Verify the build output exists
    const distMain = resolve(root, "dist", "main", "index.cjs");
    if (!existsSync(distMain)) {
      log.error("test", `Build completed but dist/main/index.cjs not found at ${distMain}`);
      return false;
    }
    log.info("test", "Build succeeded.");
    return true;
  } catch (e) {
    log.error("test", `Build failed: ${(e as Error).message}`);
    return false;
  }
}

// Use spawnSync for the build step (blocking — we need it done before tests)
import { spawnSync } from "child_process";

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
  log.info("test", `  Mode:          ${opts.build ? "built" : "dev"}${opts.buildOnly ? " (build-only)" : ""}`);
  log.info("test", "");

  // If --build or --build-only is specified, build the game first.
  if (opts.build) {
    const buildOk = buildGame(ROOT, opts.game);
    if (!buildOk) {
      process.exit(1);
    }
  }

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
  // Tell the harness to launch the built app instead of the dev server.
  if (opts.build) {
    env.DOWNDRAFT_TEST_BUILT = "1";
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
