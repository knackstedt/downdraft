// ============================================================================
// dev-constants.mjs — shared constants between the dev supervisor (.mjs,
// loaded natively by bun/node/deno) and the runner-side runtime (.ts,
// evaluated through the Vite ModuleRunner).
// Keep this file dependency-free plain JS.
// ============================================================================

/** Exit code signalling the CLI to respawn the dev shell (Tier-5 restart). */
export const DD_RESTART_EXIT = 75;

/** globalThis key for the supervisor's config → runtime handoff. */
export const CONFIG_KEY = "__ddDevConfig";

/** globalThis key for the supervisor object the runtime calls back into. */
export const SUPERVISOR_KEY = "__ddSupervisor";

/** globalThis key for the game-facing HMR control surface. */
export const HMR_KEY = "__ddHmr";

/** globalThis flag guarding one-time registration of the runtime's
 *  import.meta.hot listeners (vite's customListeners survive the
 *  evaluatedModules.clear() that full-reload performs). */
export const LISTENERS_FLAG = "__ddHmrListenersInstalled";

/** Custom hot-channel events used by the native HMR protocol. */
export const EV = {
  /** server → runner: a sim/worker-classified file changed; swap workers. */
  simHotReload: "sim:hot-reload",
  /** runner → server: worker swap finished (data: {updateId, swapped, error?}). */
  simHotReloadAck: "sim:hot-reload:ack",
  /** server → runner: session restart request. Sent instead of vite's
   *  "full-reload" payload type — vite's runner-side full-reload handler
   *  awaits runner.import(entrypoint), which stays pending for the whole
   *  session (blocking entries top-level-await the run loop), and the
   *  handler serializes the entire hot channel — one full-reload would
   *  dead-letter every later HMR message. We remap to this custom event at
   *  the channel seam (see dev-shell installHotChannelRemap). */
  sessionRestart: "dd:session-restart",
  /** server → runner: legacy renderer-path change (maps to session restart). */
  rendererHotReload: "renderer:hot-reload",
  /** server → runner: destroy host + globals, re-import (Tier 4). */
  hostRestart: "dd:host-restart",
};

/** Files/dirs whose change forces a full process restart (Tier 5). */
export const DEFAULT_PROCESS_RESTART_PATTERNS = [
  "/src/dev/",                  // the dev shell itself — respawn clean
  "downdraft.config.json",
  "bunfig.toml",
  "deno.json",
  "vite.config.ts",
  "vite-options.ts",
];

/** Files under these paths force a host restart (Tier 4): SDL window, wgpu
 *  binding, DOM polyfills, bridge, services, MCP — the persistent layer. */
export const DEFAULT_HOST_RESTART_PATTERNS = [
  "packages/platform-native/src/",
  "packages/platform-native/native/",
];

/** Default sim/worker path classification (substring match, normalized
 *  POSIX-style). Shared dirs + engine module/library dirs can feed the sim
 *  worker graph. Games override via downdraft.config.json → hmr.simPaths. */
export const DEFAULT_SIM_PATTERNS = [
  "/src/simulation/",
  "/src/sim/",
  "/src/shared/",
  "/shared/",
  "/libraries/",
  "/modules/",
];
