// ============================================================================
// dev-shell.mjs — native HMR supervisor
//
// Spawned by `draft dev` as `<bun|node|deno> dev-shell.mjs`. Plain ESM — no
// TypeScript, no runtime-specific APIs — so every supported runtime can host
// it. Inside, a Vite dev server (middlewareMode) + a runnable "native"
// environment evaluate the game's native-entry.ts through the ModuleRunner:
//
//   vite watcher → classify (nativeHmrPlugin) →
//     Tier 1  directed module update   (vite propagates, accept boundaries)
//     Tier 2  sim worker swap          (sim:hot-reload event → __ddSession)
//     Tier 3  session restart          (vite full-reload → beforeFullReload →
//                                       saveState + teardown → re-import)
//     Tier 4  host restart             (dd:host-restart → destroy + re-create)
//     Tier 5  process restart          (exit DD_RESTART_EXIT → CLI respawns)
//
// The process boundary: the SDL window, wgpu host device, downdraft bridge,
// host services, and MCP server are created once by createNativeHost() and
// survive Tier 3. Only a Tier-4/5 restart rebuilds them.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    CONFIG_KEY,
    DD_RESTART_EXIT,
    EV,
    HOST_GLOBALS,
    LISTENERS_FLAG,
    SUPERVISOR_KEY,
} from "./dev-constants.mjs";
import { installConsoleBridge, writeLine } from "./dev-log.mjs";
import { buildNativeDevConfig, loadGameConfig, loadHmrOptions, resolveWgslRegistryPath } from "./vite-config.mjs";

const TAG = "dd-dev";

// Route vite-client/stray console output through the same line format —
// the ModuleRunner shares this globalThis, so console.debug("[vite] ...")
// and any console.* inside evaluated modules land here.
installConsoleBridge();

// Capture raw timers BEFORE RUNTIME_MODULE evaluates — installSessionTracker
// wraps globalThis.setTimeout/clearTimeout for session bookkeeping, and
// teardown cancels every tracked timer. Supervisor bookkeeping (force-exit,
// restart fallbacks, ack deadlines) must survive teardown to remain the
// bound it exists to enforce.
const rawSetTimeout = globalThis.setTimeout.bind(globalThis);
const rawClearTimeout = globalThis.clearTimeout.bind(globalThis);
const rawSetInterval = globalThis.setInterval.bind(globalThis);
const rawClearInterval = globalThis.clearInterval.bind(globalThis);

// Two-arg form is used by native-dev-runtime (sup.log("hmr", msg)) — the
// first arg is a submodule tag, rendered as [dd-dev/hmr].
function log(msg, detail) {
  if (detail !== undefined) writeLine("info", `${TAG}/${msg}`, detail);
  else writeLine("info", TAG, msg);
}
function logErr(msg) {
  writeLine("error", TAG, msg);
}
function logFatal(msg) {
  writeLine("fatal", TAG, msg);
}

// ── Environment contract (set by draft dev) ────────────────────────────────

const gameDir = process.env.DD_GAME_DIR;
const entry = process.env.DD_ENTRY;
const runtime = process.env.DD_RUNTIME ?? "node";
const verbose = process.env.DD_VERBOSE === "1";

if (!gameDir || !entry) {
  logErr("DD_GAME_DIR and DD_ENTRY are required (spawned by `draft dev`)");
  process.exit(2);
}
if (!existsSync(entry)) {
  logErr(`entry not found: ${entry}`);
  process.exit(2);
}

/** Walk up from dir looking for the downdraft monorepo root. */
function findRepoRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf-8"));
      if (pkg.name === "downdraft-engine" && existsSync(join(d, "packages/engine"))) return d;
    } catch { /* keep walking */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const repoRoot = process.env.DD_REPO_ROOT ?? findRepoRoot(gameDir);
const devDir = dirname(fileURLToPath(import.meta.url));
const RUNTIME_MODULE = join(devDir, "native-dev-runtime.ts");
// Slim slice imported before RUNTIME_MODULE — its tiny graph transforms in
// a fraction of the runtime's, so the window + GPU device land seconds
// before the entry graph finishes.
const EARLY_HOST_MODULE = join(devDir, "early-host.ts");

// ── Resolve vite from the game's dependency tree ───────────────────────────

let vite;
try {
  const req = createRequire(join(gameDir, "package.json"));
  // req.resolve("vite") returns the CJS build (index.cjs), which does NOT
  // export the ModuleRunner APIs — resolve package.json and load the ESM
  // entry (dist/node/index.js) directly.
  const pkgJson = req.resolve("vite/package.json");
  const esmEntry = join(dirname(pkgJson), "dist/node/index.js");
  vite = await import(pathToFileURL(esmEntry).href);
} catch (e) {
  try {
    vite = await import("vite");
  } catch {
    logErr(`failed to resolve vite (is it installed?): ${e?.message ?? e}`);
    process.exit(1);
  }
}
if (typeof vite.createRunnableDevEnvironment !== "function") {
  logErr("vite ModuleRunner API missing — need vite >= 6.4 with ESM build");
  process.exit(1);
}

// ── Supervisor state ───────────────────────────────────────────────────────

const hmrOptions = loadHmrOptions(gameDir);
// 30s default: a Tier-2 swap includes a cache-busted worker respawn + init +
// state restore, which legitimately exceeds the old 5s budget in dev and
// caused every swap to false-positive into a session restart.
const ackTimeoutMs = hmrOptions.ackTimeoutMs ?? 30_000;

let server = null;
let runner = null;
let shuttingDown = false;
let reimportQueue = Promise.resolve();
let updateSeq = 0;

const pendingSimSwaps = new Map(); // updateId → {timer, resolve}

/** Serialize re-imports — a full-reload landing mid-import queues behind it. */
function enqueue(fn) {
  reimportQueue = reimportQueue.then(fn).catch((e) => {
    logErr(`reimport failed: ${e?.stack ?? e}`);
    // Reimport is the last-resort recovery path; if IT fails the process is
    // in an unknown state → escalate to a process restart.
    shutdown(DD_RESTART_EXIT, "reimport failure");
  });
  return reimportQueue;
}

/** Boot finished — pending restore state no longer applies to late sims. */
function finishSessionBoot() {
  try { globalThis.__ddSession?.finishSessionBoot?.(); } catch { /* optional */ }
}

/** Tier 3: full-reload payloads are remapped to a custom event (see
 *  installHotChannelRemap), so vite never clears the runner's module cache
 *  itself — do it here before re-evaluating fresh. */
async function reimportSession() {
  await new Promise((r) => rawSetTimeout(r, 0));
  // Rebuild the ModuleRunner instead of clearCache() — the runner's
  // transport/HMRClient/evaluator bookkeeping (crawl-end deferreds, pending
  // request maps, serialized message queue) retains pieces of the dead
  // generation through edges the heap snapshot doesn't model, and every
  // retained module env pins that generation's renderer + GPU wrappers
  // (~250MB + ~4100 bind groups per restart, verified 2026-10). A fresh
  // runner drops the whole container graph; env.hot (the remapped channel)
  // and the vite module graph survive untouched. Host restarts already
  // prove this releases the generation — this makes Tier 3 do the same.
  try { await runner.close(); } catch { /* mid-teardown */ }
  envRef.current._runner = undefined; // force the lazy getter to rebuild
  runner = envRef.current.runner;
  globalThis.__ddRunner = runner;
  // import.meta.hot.on listeners are owned by the registering module — a
  // full-reload invalidates them along with the module graph. The runtime
  // must re-register on every re-eval, so the install flag goes back down.
  delete globalThis[LISTENERS_FLAG];
  await runner.import(RUNTIME_MODULE);
  await runner.import(entry);
  finishSessionBoot();
}

/** Tier 4: destroy host happened runner-side; fresh runner (same reasoning
 *  as reimportSession — the old runner's unmodeled bookkeeping can pin the
 *  dead generation's module graph). */
async function reimportHost() {
  await new Promise((r) => rawSetTimeout(r, 0));
  try { await runner.close(); } catch { /* mid-close */ }
  envRef.current._runner = undefined;
  runner = envRef.current.runner;
  globalThis.__ddRunner = runner;
  // Same as reimportSession — a fresh runner dropped the runtime module's
  // hot.on listeners; drop the flag so the re-eval re-registers them.
  delete globalThis[LISTENERS_FLAG];
  await runner.import(RUNTIME_MODULE);
  await runner.import(entry);
  finishSessionBoot();
}

/** Fallback timers — if the runtime's ready callbacks never arrive (boot
 *  race, dead session, missing listeners), the supervisor drives the
 *  re-import itself rather than stalling on a cleared module cache. */
let sessionFallback = null;
let hostFallback = null;
/** Dedupe between the runtime's sessionRestartReady and the fallback —
 *  whichever fires first wins; the loser must not enqueue a second
 *  reimport (it would sit behind the pending entry import and fire an
 *  extra, spurious restart at the next session boundary). */
/** True while a restart's reimport is still owed — armed by ANY trigger
 *  path (our sendFullReload AND the runtime's sessionRestartStarted hook,
 *  which covers vite-internal full-reloads remapped at the channel), then
 *  claimed-and-cleared by whichever of sessionRestartReady / the fallback
 *  timer fires first. Prevents double-enqueueing a reimport — the loser
 *  would sit behind the pending entry import and fire a spurious extra
 *  restart at the next session boundary. */
let restartPending = false;
/** Same claim-token as restartPending, for Tier 4: armed by sendHostRestart
 *  (every Tier-4 trigger passes through it), claimed-and-cleared by
 *  whichever of hostRestartReady / driveHostFallback fires first. Without
 *  it a fallback firing while the runtime's listener is mid-teardown
 *  enqueues a second reimport behind the first. */
let hostRestartPending = false;

/** Deliver a custom hot event to the runtime. Vite's runner-side HMR client
 *  drops custom events when no listener is registered — exactly the state
 *  during early boot (RUNTIME_MODULE's hot.on calls haven't evaluated yet)
 *  and in the gap after LISTENERS_FLAG is cleared for a reimport. Retry
 *  delivery until the flag lands; stillNeeded() lets the caller stop once
 *  the restart was claimed by another path. The caller's fallback timer
 *  bounds a runtime that never installs listeners. */
function sendWhenReady(payload, stillNeeded) {
  const attempt = () => {
    if (!stillNeeded()) return true;
    if (!globalThis[LISTENERS_FLAG]) return false;
    try {
      env().hot.send(payload);
    } catch (e) {
      logErr(`hot send failed (${payload?.event}): ${e?.message ?? e}`);
    }
    return true;
  };
  if (attempt()) return;
  log(`${payload?.event} deferred — runtime listeners not installed yet`);
  const poll = rawSetInterval(() => {
    try { if (attempt()) rawClearInterval(poll); }
    catch { rawClearInterval(poll); }
  }, 250);
  poll.unref?.();
}

/** Send a session-restart into the env (the Tier-3 trigger).
 *
 *  This deliberately does NOT send vite's {type:"full-reload"} payload:
 *  vite's runner-side handler for it awaits runner.import(entrypoint),
 *  which stays pending for the session's whole lifetime when the entry
 *  top-level-awaits its run loop — and the runner serializes every
 *  hot-channel message behind that await, dead-lettering all later HMR
 *  traffic (sim swaps, further restarts). The custom event just notifies
 *  listeners and frees the queue; we clear evaluatedModules + re-import
 *  ourselves in reimportSession. */
function sendFullReload(triggeredBy) {
  try {
    armSessionFallback();
    sendWhenReady(
      { type: "custom", event: EV.sessionRestart, data: { triggeredBy } },
      () => restartPending,
    );
  } catch (e) {
    logErr(`full-reload send failed: ${e?.message ?? e}`);
  }
}

/** The supervisor-driven session teardown — runs when the runtime's
 *  sessionRestartReady never arrives (dropped event, dead session). */
function driveSessionFallback() {
  sessionFallback = null;
  if (!restartPending) return; // the runtime's ready already claimed it
  restartPending = false;
  log("session restart fell back to supervisor-driven reimport");
  // The teardown CANNOT live inside the reimport queue: the queue tail
  // is the current session's still-pending runner.import(entry) — it
  // only resolves when the session ends, i.e. AFTER teardown — so an
  // enqueued teardown deadlocks the restart permanently. Run it first,
  // then enqueue the reimport.
  void (async () => {
    // teardownInner bounds each step (dispose callbacks, sim stops) —
    // if it still exceeds 60s the session is unkillable in-process and
    // the only sound recovery is a process respawn.
    let wedged = false;
    await Promise.race([
      (async () => {
        try { await globalThis.__ddSession?.teardown?.({ destroyDevices: false }); } catch { /* best-effort */ }
      })(),
      new Promise((r) => {
        const t = rawSetTimeout(() => { wedged = true; r(); }, 60_000);
        t.unref?.();
      }),
    ]);
    if (wedged) {
      logErr("session teardown wedged >60s — escalating to process restart");
      void shutdown(DD_RESTART_EXIT, "session teardown wedged");
      return;
    }
    enqueue(reimportSession);
  })();
}

/** Arm the fallback watchdog for a session restart — called by
 *  sendFullReload (our escalation) AND by the runtime's
 *  sessionRestartStarted hook (covers remapped vite-internal
 *  full-reloads, which never pass through sendFullReload). */
function armSessionFallback() {
  restartPending = true;
  rawClearTimeout(sessionFallback);
  sessionFallback = rawSetTimeout(driveSessionFallback, Math.max(ackTimeoutMs, 15_000));
  sessionFallback.unref?.();
}

/** destroyHostLayer() equivalent for the supervisor-driven path — the
 *  runtime's Tier-4 listener never ran, so nothing else clears the host
 *  globals. A stale entry holding a freed native handle
 *  (__wgpuInstancePtr above all — the next generation's NativeWindow
 *  feeds it to create_surface) is a use-after-free in the shim. */
function resetHostGlobals() {
  try { globalThis.__nativeHost?.destroy?.(); } catch { /* already down */ }
  HOST_GLOBALS.forEach((key) => {
    try { delete globalThis[key]; } catch { globalThis[key] = undefined; }
  });
  try { if (globalThis.navigator) globalThis.navigator.gpu = undefined; } catch { /* getter-only */ }
  try { globalThis.__ddSession?.resetTrackedTargets?.(); } catch { /* optional */ }
}

function sendHostRestart(data) {
  try {
    hostRestartPending = true;
    sendWhenReady(
      { type: "custom", event: "dd:host-restart", data },
      () => hostRestartPending,
    );
    rawClearTimeout(hostFallback);
    hostFallback = rawSetTimeout(driveHostFallback, Math.max(ackTimeoutMs, 20_000));
    hostFallback.unref?.();
  } catch (e) {
    logErr(`host-restart send failed: ${e?.message ?? e}`);
    void shutdown(DD_RESTART_EXIT, "host-restart send failure");
  }
}

/** The supervisor-driven host teardown — runs when the runtime's
 *  hostRestartReady never arrives (dropped event, dead session). */
function driveHostFallback() {
  hostFallback = null;
  if (!hostRestartPending) return; // the runtime's ready already claimed it
  hostRestartPending = false;
  log("host restart fell back to supervisor-driven reimport");
  // Same queue deadlock as the session fallback: teardown/host-destroy
  // must run outside the reimport queue — the queue tail is the dying
  // session's pending entry import, which only resolves post-teardown.
  void (async () => {
    let wedged = false;
    await Promise.race([
      (async () => {
        try { await globalThis.__ddSession?.teardown?.({ destroyDevices: false }); } catch { /* best-effort */ }
      })(),
      new Promise((r) => {
        const t = rawSetTimeout(() => { wedged = true; r(); }, 60_000);
        t.unref?.();
      }),
    ]);
    if (wedged) {
      logErr("session teardown wedged >60s — escalating to process restart");
      void shutdown(DD_RESTART_EXIT, "session teardown wedged");
      return;
    }
    try { await globalThis.__ddRetireSharedDevices?.(1_500); } catch { /* bounded + best-effort */ }
    resetHostGlobals();
    enqueue(reimportHost);
  })();
}

const envRef = { current: null };
function env() {
  return envRef.current;
}

/** Vite emits {type:"full-reload"} over env.hot.send for dead-end updates
 *  (tsconfig changes, unaccepted module graphs, optimizer reruns). The
 *  runner-side handler for that payload awaits runner.import(entrypoint)
 *  inside the serialized hot-channel queue — with a blocking entry (top-
 *  level await on the run loop) that await spans the whole session, so a
 *  single full-reload dead-letters every later HMR message. Remap to our
 *  custom session-restart event: the runtime listener does save+teardown,
 *  then the supervisor clears evaluatedModules + re-imports itself. */
function installHotChannelRemap() {
  const hotChannel = envRef.current?.hot;
  if (!hotChannel || typeof hotChannel.send !== "function" || hotChannel.__ddRemapped) return;
  const origSend = hotChannel.send.bind(hotChannel);
  hotChannel.send = (payload, ...rest) => {
    if (payload && typeof payload === "object" && payload.type === "full-reload") {
      payload = {
        type: "custom",
        event: EV.sessionRestart,
        data: { triggeredBy: payload.triggeredBy, path: payload.path },
      };
    }
    return origSend(payload, ...rest);
  };
  hotChannel.__ddRemapped = true;
}

// ── Supervisor API — the runtime calls these directly (shared globalThis) ──

const supervisor = {
  log,

  /** The runtime received a session-restart event and is beginning
   *  save+teardown — arm the fallback watchdog. This covers full-reloads
   *  that came from vite's own handleHMRUpdate (remapped at the channel),
   *  which never pass through sendFullReload. */
  sessionRestartStarted() {
    armSessionFallback();
  },

  /** Runtime finished session save+teardown after a full-reload payload. */
  sessionRestartReady() {
    rawClearTimeout(sessionFallback);
    sessionFallback = null;
    if (!restartPending) return; // stale ready — a restart was already handled
    restartPending = false;
    enqueue(reimportSession);
  },

  /** Runtime finished host teardown (host.destroy + global reset). */
  hostRestartReady() {
    rawClearTimeout(hostFallback);
    hostFallback = null;
    if (!hostRestartPending) return; // stale ready — the fallback already drove it
    hostRestartPending = false;
    enqueue(reimportHost);
  },

  /** Something runner-side asked for a session restart (wgsl no-subscriber
   *  fallback, engine location.reload() shim, update errors, sim swap fail). */
  requestSessionRestart(reason) {
    log(`session restart requested: ${reason}`);
    sendFullReload(reason);
  },

  /** Runner-side request for host restart (currently only sent via events,
   *  but exposed for runtime callers). */
  requestHostRestart(reason) {
    log(`host restart requested: ${reason}`);
    sendHostRestart({ reason });
  },

  /** Escalate to a clean process restart (CLI respawns on DD_RESTART_EXIT). */
  requestProcessRestart(reason) {
    log(`process restart requested: ${reason}`);
    void shutdown(DD_RESTART_EXIT, reason);
  },

  /** Sim swap bookkeeping (timeout → session restart escalation). */
  simSwapDone(updateId, result) {
    const pending = pendingSimSwaps.get(updateId);
    if (!pending) return;
    pendingSimSwaps.delete(updateId);
    rawClearTimeout(pending.timer);
    pending.resolve(result);
  },

  /** Window closed → shut the supervisor down. */
  shutdown() {
    void shutdown(0, "window closed");
  },
};

globalThis[SUPERVISOR_KEY] = supervisor;
globalThis.__ddMarker = "shell";
const gameConfig = loadGameConfig(gameDir);
globalThis[CONFIG_KEY] = {
  entry,
  gameDir,
  repoRoot,
  runtime,
  verbose,
  gameConfig,
};

// ── Classifier events (from nativeHmrPlugin) ───────────────────────────────

// Coalesce duplicate classifications — chokidar can emit multiple events for
// a single write, and each "sim-update" spawns a full save/terminate/respawn
// cycle, so dupes are expensive.
const lastEventAt = new Map(); // `${type}:${file}` → ts
function onClassifierEvent(type, data) {
  const key = `${type}:${data.file}`;
  const now = Date.now();
  if (now - (lastEventAt.get(key) ?? 0) < 250) return;
  lastEventAt.set(key, now);
  switch (type) {
    case "process-restart":
      log(`process restart: ${data.file}`);
      void shutdown(DD_RESTART_EXIT, `${data.file} changed`);
      break;
    case "host-restart":
      log(`host restart: ${data.file}`);
      sendHostRestart(data);
      break;
    case "sim-update": {
      const updateId = `sim-${++updateSeq}`;
      if (verbose) log(`sim update: ${data.file}`);
      // Timeout: if the runner never acks (no session, crashed handler), the
      // safest fallback is a session restart.
      const timer = rawSetTimeout(() => {
        if (pendingSimSwaps.delete(updateId)) {
          log(`sim swap timed out (${data.file}) — session restart`);
          sendFullReload(data.file);
        }
      }, ackTimeoutMs);
      pendingSimSwaps.set(updateId, { timer, resolve: () => {} });
      try {
        env().hot.send({
          type: "custom",
          event: EV.simHotReload,
          data: { file: data.file, timestamp: data.timestamp, updateId },
        });
      } catch (e) {
        rawClearTimeout(timer);
        pendingSimSwaps.delete(updateId);
        sendFullReload(data.file);
      }
      break;
    }
  }
}

// ── Server lifecycle ───────────────────────────────────────────────────────

async function shutdown(code, reason = "") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) log(`shutdown: ${reason}`);

  // Give teardown a bounded window; the process must not linger. Raw timer
  // — a session-tracked setTimeout would be cancelled by the teardown below,
  // silently removing the bound it exists to enforce.
  const force = rawSetTimeout(() => process.exit(code), 3000);
  force.unref?.();

  // Device teardown is host.destroy()'s job — a manual device destroy while
  // the wgpu poll loop runs aborts inside wgpu-core. Kick shared-device
  // retirement FIRST so its SAB death-signal + detach wait overlap worker
  // teardown instead of serializing after it.
  const retire = globalThis.__ddRetireSharedDevices?.(1_500)?.catch(() => {});
  try { await globalThis.__ddSession?.teardown?.({ destroyDevices: false }); } catch {}
  try { await retire; } catch {}
  try { globalThis.__nativeHost?.destroy?.(); } catch {}
  try { await server?.close(); } catch {}
  process.exit(code);
}

/** Rebind env/runner after a vite server restart (config/.env changes). */
/** Runner → supervisor acks ride the env hot channel (import.meta.hot.send).
 *  Re-registered on every (re)bind — a vite server restart swaps the env +
 *  channel, and without this every sim swap would ack into the void and
 *  escalate to a session restart. */
function installSimAckListener() {
  env().hot.on(EV.simHotReloadAck, (data) => {
    supervisor.simSwapDone(data?.updateId, data);
  });
}

async function rebindRunner() {
  envRef.current = server.environments.native;
  installHotChannelRemap();
  installSimAckListener();
  runner = envRef.current.runner;
  globalThis.__ddRunner = runner;
  // The new env's module cache is empty but the process + host survive.
  // The new env also has a fresh hot channel — the old listeners died with
  // it, so allow the runtime module to re-register on re-eval.
  delete globalThis[LISTENERS_FLAG];
  await runner.import(RUNTIME_MODULE);
  await runner.import(entry);
  finishSessionBoot();
}

async function main() {
  const wgslRegistryPath = resolveWgslRegistryPath(gameDir);
  const watchPaths = [repoRoot && repoRoot !== gameDir ? repoRoot : null].filter(Boolean);

  const config = buildNativeDevConfig({
    vite,
    gameDir,
    repoRoot,
    runtime,
    verbose,
    wgslRegistryPath,
    watchPaths,
    onEvent: onClassifierEvent,
    entry,
  });

  server = await vite.createServer(config);

  // Vite restarts the whole dev server on config/.env changes — environments
  // (and their runners) are recreated, so rebind and re-import.
  const origRestart = server.restart.bind(server);
  server.restart = async (...args) => {
    const result = await origRestart(...args);
    try { await rebindRunner(); } catch (e) {
      logErr(`rebind after vite restart failed: ${e?.stack ?? e}`);
      void shutdown(DD_RESTART_EXIT, "vite restart rebind failure");
    }
    return result;
  };

  // middlewareMode: no HTTP listener — plugin configureServer hooks and the
  // file watcher are initialized by createServer() itself.
  envRef.current = server.environments.native;
  installHotChannelRemap();
  if (!envRef.current) {
    logErr(`environment "native" not registered — environments: ${Object.keys(server.environments)}`);
    process.exit(1);
  }
  runner = envRef.current.runner;
  if (!runner) {
    logErr(`environment "native" has no ModuleRunner — is it runnable?`);
    process.exit(1);
  }
  // Debug: expose the runner for heap/session diagnostics (dev shell only).
  globalThis.__ddRunner = runner;
  installSimAckListener();

  log(`runtime=${runtime} game=${gameDir}`);
  log(`entry=${entry}`);

  // Boot: kick the slim early host FIRST — its graph transforms in a
  // fraction of RUNTIME_MODULE's, so the window + GPU device land while the
  // runtime + entry graphs are still transforming. Not awaited — it races
  // the runtime import below. The runtime's own kick stays as the fallback
  // (covers host restarts, where a dev-shell-level kick can't help).
  const gameCfg = globalThis[CONFIG_KEY]?.gameConfig;
  if (!globalThis.__ddEarlyHostPromise && gameCfg?.native) {
    const n = gameCfg.native;
    try {
      // Await the module import — the early graph is tiny, and giving it
      // the transform pipeline first is the whole point. bootEarlyHost
      // itself is NOT awaited: window/device land while the heavy graphs
      // transform below.
      const earlyMod = await runner.import(EARLY_HOST_MODULE);
      globalThis.__ddEarlyHostPromise = Promise.resolve(earlyMod.bootEarlyHost({
        window: {
          title: n.title ?? gameCfg.name ?? "Downdraft",
          width: n.width ?? 1280,
          height: n.height ?? 720,
          focused: n.focused,
        },
        appId: n.appId,
        splash: n.splash,
      })).catch((e) => {
        logErr(`early host boot failed (entry will create its own): ${e?.message ?? e}`);
        return null;
      });
    } catch (e) {
      logErr(`early host import failed (entry will create its own): ${e?.message ?? e}`);
    }
  }
  // The runtime installs the session tracker + hot listeners, then the
  // game entry evaluates inside the shared process.
  await runner.import(RUNTIME_MODULE);
  await runner.import(entry);
  finishSessionBoot();

  // Entry module resolved. Two shapes exist:
  //  - blocking entries (runNativeGameModule): resolution means the window
  //    closed → shut down.
  //  - fire-and-forget entries (to-the-ocean bespoke): the RAF/immediate
  //    loop keeps the process + window alive — shutdown comes from the
  //    window "close" hook (attachHost → __ddSupervisor.shutdown) instead.
  // Entry module resolved. Two shapes exist:
  //  - blocking entries (runNativeGameModule): resolution means the window
  //    closed → shut down.
  //  - fire-and-forget entries (to-the-ocean bespoke): an async main() is
  //    still in-flight creating the host — the RAF/immediate loop then keeps
  //    the process alive and the window "close" hook owns shutdown.
  // Wait (bounded) for a host to appear before concluding the entry did
  // nothing and exiting.
  const deadline = Date.now() + 30_000;
  while (
    !shuttingDown
    && !(globalThis.__nativeHost && typeof globalThis.__nativeHost === "object" && globalThis.__nativeHost.window)
  ) {
    if (Date.now() > deadline) {
      await shutdown(0, "entry completed without creating a host");
      return;
    }
    await new Promise((r) => rawSetTimeout(r, 100));
  }
}

process.on("SIGINT", () => void shutdown(130, "SIGINT"));
process.on("SIGTERM", () => void shutdown(143, "SIGTERM"));
process.on("SIGHUP", () => void shutdown(129, "SIGHUP"));

main().catch((e) => {
  logFatal(e?.stack ?? String(e));
  void shutdown(1, "boot failure");
});
