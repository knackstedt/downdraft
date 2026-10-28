import { createLogger } from "@downdraft/engine";
import { spawn } from "child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, print, renderHelp } from "./args";
import { formatAppsList } from "./list-apps";
import { buildCwd, findMonorepoRoot, readAppConfig } from "./paths";
import { killProcessTree } from "./process-utils";
import { getCommand } from "./usage";

const log = createLogger();
const APP_CONFIG = "downdraft.config.json";
const NATIVE_ENTRY = "src/native-entry.ts";

/**
 * Exit code the dev shell uses to request a clean process restart
 * (Tier-5: dev-shell/loader/config changes, unrecoverable teardown failure).
 * Duplicated from platform-native's dev-constants.mjs — the CLI cannot import
 * engine package internals at type-check time in every layout, so keep the
 * literal in sync.
 */
const DD_RESTART_EXIT = 75;

/** Resolve packages/platform-native/src/dev/ — via package resolution first
 *  (standalone installs), then the monorepo layout. */
function resolveDevShellDir(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@downdraft/platform-native/package.json");
    const dir = join(dirname(pkgJson), "src", "dev");
    if (existsSync(join(dir, "dev-shell.mjs"))) return dir;
  } catch { /* fall through to monorepo guess */ }
  const root = findMonorepoRoot();
  if (root) return join(root, "packages/platform-native/src/dev");
  return join(dirname(fileURLToPath(import.meta.url)), "../../platform-native/src/dev");
}

/**
 * Resolve the app directory by walking up from `process.cwd()` looking for
 * `downdraft.config.json`, falling back to `src/native-entry.ts` presence.
 * This lets apps run `draft dev` from their own directory (the scaffolded
 * `package.json` already sets `"dev": "draft dev"`).
 *
 * Returns `{ app, appDir }` or `null` if no app could be found.
 */
function resolveAppDir(): { app: string; appDir: string } | null {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, APP_CONFIG)) || existsSync(resolve(dir, NATIVE_ENTRY))) {
      return { app: basename(dir), appDir: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

export async function dev(args: string[]): Promise<void> {
  const entry = getCommand("dev")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  return devNative(parsed);
}

/**
 * Native dev mode — runs the app with winit + wgpu under Bun, Node, or Deno.
 * Looks for `src/native-entry.ts` in the app directory. `overrideDir` lets a
 * sibling command (`draft devtools`) run a package directory as the app.
 */
export async function devNative(parsed: any, overrideDir?: string): Promise<void> {
  const resolved = overrideDir
    ? { app: basename(overrideDir), appDir: overrideDir }
    : resolveAppDir();
  if (!resolved) {
    log.error("draft", `No app directory found (looking for downdraft.config.json or src/native-entry.ts from "${process.cwd()}").`);
    log.error("draft", `Run "draft dev" from an app directory.`);
    print(formatAppsList(findMonorepoRoot() ?? process.cwd()));
    process.exit(1);
  }

  const { app, appDir } = resolved;
  const nativeEntry = resolve(appDir, NATIVE_ENTRY);

  if (!existsSync(nativeEntry)) {
    log.error("draft", `No native entry point found at "${nativeEntry}".`);
    log.error("draft", `The app "${app}" needs a src/native-entry.ts to run on the native runtime.`);
    process.exit(1);
  }

  const verbose = parsed.flags.verbose as boolean;
  const noHmr = parsed.flags["no-hmr"] as boolean;

  const env = { ...process.env };
  const port = parsed.flags.port as number;
  if (port) env.MCP_PORT = String(port);
  // --native-debug → the runtime resolves <plat>-<arch>-debug/ lib dirs
  // (staged by build-native.mjs --debug) instead of release artifacts.
  if (parsed.flags["native-debug"]) env.DD_NATIVE_PROFILE = "debug";

  // Signal handling lives outside the respawn loop — each spawn registers
  // itself as the current child so SIGINT/SIGTERM always hit the live one.
  let currentChild: import("child_process").ChildProcess | null = null;
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("draft", "Shutting down...");
    const child = currentChild;
    try { child?.kill("SIGINT"); } catch {}
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
    setTimeout(() => {
      if (child?.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        killProcessTree(child.pid);
      }
      process.exit(130);
    }, 2000);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  // WebUI backend: --webui flag → DD_WEBUI_BACKEND → config webui.backend.
  // Forwarded into the shell env; the host resolves final precedence
  // (createWebUi opts still outrank it) inside libraries/webui. Resolved
  // before either spawn path — wpe also decides the namespace wrap below.
  const webuiBackend = (parsed.flags.webui as string | undefined)
    || process.env.DD_WEBUI_BACKEND
    || ((readAppConfig(appDir).webui as { backend?: string } | undefined)?.backend);
  if (webuiBackend) env.DD_WEBUI_BACKEND = webuiBackend;

  // --devtools-agent → the dev shell imports the bundled devtools-agent.mjs
  // before evaluating app code (CDP inspector + network/console/heap feed
  // for a devtools viewer). DD_DEVTOOLS_AGENT=<path> injects a
  // custom agent module instead.
  if (parsed.flags["devtools-agent"]) env.DD_DEVTOOLS_AGENT = env.DD_DEVTOOLS_AGENT || "1";

  // Resolve the bundled agent module (or an explicit DD_DEVTOOLS_AGENT path)
  // for launch styles that have no dev shell to import it (i.e. --no-hmr).
  const resolveAgentPath = (): string | null => {
    const spec = env.DD_DEVTOOLS_AGENT;
    if (!spec) return null;
    if (spec === "1" || spec === "true") return join(resolveDevShellDir(), "devtools-agent.mjs");
    return resolve(appDir, spec);
  };

  // ── WPE dev runtime namespace ──
// The vendored Debian WPE build spawns WPEWebProcess/WPENetworkProcess
// from hardcoded /usr/lib/… paths — scripts/run-wpe.sh presents the
// vendored libexec tree there inside a user+mount namespace. When the
// resolved backend is wpe and no system WPE/WebKit exists, wrap the app
// shell spawn in it so `draft dev --webui=wpe` works transparently.
// DD_WEBUI_NO_NSWRAP=1 opts out (e.g. already inside a namespace).
function resolveWpeDistDir(appDir: string): string | null {
  const plat = `${process.platform}-${process.arch}`;
  const env = process.env.DD_WEBUI_WPE_PREFIX;
  const pkgRoot = (() => {
    try {
      const req = createRequire(join(appDir, "package.json"));
      return dirname(req.resolve("@downdraft/engine/package.json"));
    } catch { return null; }
  })();
  const mono = findMonorepoRoot();
  const candidates = [
    env,
    pkgRoot && join(pkgRoot, "libraries", "webui", "vendor", `wpe-${plat}`),
    mono && join(mono, "packages/engine/libraries/webui/vendor", `wpe-${plat}`),
    // Native-build staging tree (same libexec/lib/share shape).
    pkgRoot && join(pkgRoot, "libraries", "webui", "native-wpe", "dist", plat),
    mono && join(mono, "packages/engine/libraries/webui/native-wpe/dist", plat),
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c && existsSync(join(c, "libexec", "wpe-webkit-2.0"))) return c;
  }
  return null;
}

function wpeNamespaceWrap(cmd: string, args: string[], appDir: string, env: NodeJS.ProcessEnv): { cmd: string; args: string[] } | null {
  if (process.platform !== "linux") return null;
  if (env.DD_WEBUI_NO_NSWRAP) return null;
  // Only when wpe is the picked backend — "auto" resolves to cef on linux
  // desktop and needs no namespace.
  if (env.DD_WEBUI_BACKEND !== "wpe") return null;
  // A real system WPE/WebKit resolves its own libexec — no wrap needed.
  if (existsSync("/usr/lib/x86_64-linux-gnu/wpe-webkit-2.0")) return null;
  const dist = resolveWpeDistDir(appDir);
  if (!dist) return null;
  const script = (() => {
    try {
      const req = createRequire(join(appDir, "package.json"));
      const pkg = dirname(req.resolve("@downdraft/engine/package.json"));
      return join(pkg, "libraries", "webui", "scripts", "run-wpe.sh");
    } catch { return null; }
  })();
  if (!script || !existsSync(script)) return null;
  return { cmd: "bash", args: [script, dist, cmd, ...args] };
}

// ── Legacy path: --no-hmr spawns the entry directly under Bun (no watcher,
  //    no ModuleRunner — the pre-HMR behavior, kept as an escape hatch). ──
  if (noHmr) {
    const agentPath = resolveAgentPath();
    // `bun --preload <mod> <entry>` — `run` omitted so the flag binds to the
    // entry script regardless of subcommand arg parsing.
    const bunArgs = agentPath ? ["--preload", agentPath, nativeEntry] : ["run", nativeEntry];
    log.info("draft", `dev ${app} — ${nativeEntry} (bun, no hmr${agentPath ? ", devtools-agent" : ""})`);
    const w = wpeNamespaceWrap("bun", bunArgs, appDir, env)
      ?? { cmd: "bun", args: bunArgs };
    const code = await spawnAndForward(w.cmd, w.args, buildCwd(appDir), env, {
      onChild: (c) => { currentChild = c; },
    });
    if (!shuttingDown) process.exit(code);
    return;
  }

  // ── HMR path: spawn the dev shell under the selected JS runtime. ──
  const devDir = resolveDevShellDir();
  const devShell = join(devDir, "dev-shell.mjs");
  if (!existsSync(devShell)) {
    log.error("draft", `Dev shell not found at "${devShell}".`);
    log.error("draft", "Is @downdraft/platform-native installed? Try `draft dev --no-hmr` for the legacy path.");
    process.exit(1);
  }

  // Runtime detection is delegated to the dev package (it owns the matrix).
  const { detectRuntime, spawnArgsFor, findDenoConfig } =
    await import(resolve(devDir, "runtime-detect.mjs"));

  // --runtime flag → DD_RUNTIME → downdraft.config.json "runtime" → detect.
  // (absent flags parse as "" here, so || not ??)
  const requested = (parsed.flags.runtime as string | undefined)
    || process.env.DD_RUNTIME
    || (readAppConfig(appDir).runtime as string | undefined)
    || undefined;
  const runtime = detectRuntime(requested);
  if (!runtime) {
    if (requested) {
      log.error("draft", `Requested runtime "${requested}" is not available on PATH.`);
    } else {
      log.error("draft", "No JS runtime found — need one of: bun, node, deno.");
    }
    process.exit(1);
  }

  env.DD_APP_DIR = appDir;
  env.DD_ENTRY = nativeEntry;
  env.DD_RUNTIME = runtime;
  env.DD_HMR = "1";
  env.DOWNDRAFT_DEV = "1";
  if (verbose) {
    env.DD_VERBOSE = "1";
    // Diagnostics demoted below info (vite internals, pacing, gpu-registry)
    // become visible under --verbose unless an explicit level is set.
    env.DOWNDRAFT_LOG_LEVEL = env.DOWNDRAFT_LOG_LEVEL ?? "debug";
  }
  const repoRoot = findMonorepoRoot();
  if (repoRoot) env.DD_REPO_ROOT = repoRoot;

  // Engine resolution mode: "downdraft-source" resolves @downdraft/* to
  // linked TypeScript source (per-module transforms + full engine HMR) —
  // the default in the monorepo. Everything else resolves the pre-built
  // dist/ tree (externalized native ESM — near-zero transform cost, no
  // engine-file HMR). --engine-source/--engine-dist override.
  let engineSource: boolean;
  if (parsed.flags["engine-source"]) engineSource = true;
  else if (parsed.flags["engine-dist"]) engineSource = false;
  else engineSource = !!repoRoot;
  if (!engineSource && !engineDistExists(appDir)) {
    log.warn("draft",
      "engine dist/ not found — run `bun run build:dist` in the engine repo " +
      "(or reinstall @downdraft/engine); resolving engine from source.");
    engineSource = true;
  }
  env.DD_ENGINE_SOURCE = engineSource ? "1" : "";
  env.DD_ENGINE_DIST = engineSource ? "" : "1";
  // Deno reads export conditions from the env (flag equivalent passed to
  // spawnArgsFor below); the var also propagates to Deno workers.
  if (engineSource) env.DENO_CONDITIONS = "downdraft-source";

  // DD_RUNTIME_ARGS="--smol ..." injects extra runtime flags before the
  // shell path (bun --smol, node --max-semi-space-size=…, etc).
  const extraArgs = (process.env.DD_RUNTIME_ARGS ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const { cmd, args } = spawnArgsFor(runtime, devShell, {
    configPath: runtime === "deno" ? findDenoConfig(appDir, repoRoot) : undefined,
    conditions: engineSource ? ["downdraft-source"] : [],
    extraArgs,
  });

  log.info("draft", `dev ${app} — ${nativeEntry} (runtime=${runtime}, hmr, engine=${engineSource ? "source" : "dist"}${env.DD_DEVTOOLS_AGENT ? ", devtools-agent" : ""})`);
  if (verbose) log.info("draft", `dev shell: ${cmd} ${args.join(" ")}`);

  // WPE namespace wrap — applies to every respawn (run-wpe.sh execs the
  // shell inside the namespace; restarts re-enter it).
  const wrapped = wpeNamespaceWrap(cmd, args, appDir, env) ?? { cmd, args };
  if (wrapped.cmd !== cmd) log.info("draft", `wpe runtime: namespaced via ${wrapped.args[0]}`);

  // Respawn loop: the dev shell exits with DD_RESTART_EXIT when a changed
  // file affects the loader/config layer (Tier-5) — respawn in place.
  for (;;) {
    const code = await spawnAndForward(wrapped.cmd, wrapped.args, buildCwd(appDir), env, {
      onChild: (c) => { currentChild = c; },
    });
    if (shuttingDown) return; // signal handler already owns exit
    if (code === DD_RESTART_EXIT) {
      log.info("draft", "Restarting dev shell (infrastructure change)...");
      continue;
    }
    process.exit(code);
  }
}

/** True when the resolved @downdraft/engine package has a pre-built dist/. */
function engineDistExists(appDir: string): boolean {
  try {
    const req = createRequire(join(appDir, "package.json"));
    const pkgRoot = dirname(req.resolve("@downdraft/engine/package.json"));
    return existsSync(join(pkgRoot, "dist"));
  } catch {
    return false;
  }
}

/** Spawn `cmd args`, forward stdio, resolve the exit code (signal exits are
 *  mapped to 128+n so the caller's respawn loop can distinguish them). */
function spawnAndForward(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: { onChild?: (child: import("child_process").ChildProcess) => void } = {},
): Promise<number> {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    env,
    detached: true,
  });
  opts.onChild?.(child);

  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));

  return new Promise<number>((resolvePromise, reject) => {
    child.on("error", (err) => {
      log.error("draft", `Failed to spawn ${cmd}: ${err.message}`);
      reject(err);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}
