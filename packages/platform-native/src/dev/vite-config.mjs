// ============================================================================
// vite-config.mjs — Vite dev-server config + plugins for native HMR
//
// Plain ESM (.mjs): loaded natively by the dev shell under bun/node/deno —
// never TypeScript, never a bundler-specific API.
//
// The config creates a custom runnable environment named "native" whose
// ModuleRunner evaluates the game entry in-process (shared globalThis), with
// resolve aliases derived from the game's tsconfig paths.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_HOST_RESTART_PATTERNS,
    DEFAULT_PROCESS_RESTART_PATTERNS,
    DEFAULT_SIM_PATTERNS
} from "./dev-constants.mjs";

const DEV_DIR = dirname(fileURLToPath(import.meta.url));

/** Extensions a sim-update may carry — files a worker can actually import. */
const SIM_UPDATE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".wgsl",
]);

// ── tsconfig paths → vite aliases ───────────────────────────────────────────

/** Strip JSONC comments + trailing commas so JSON.parse accepts tsconfig. */
function parseJsonc(text) {
  return JSON.parse(
    text
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
}

/**
 * Convert tsconfig `compilerOptions.paths` into vite resolve.alias entries.
 * `paths` are relative to the tsconfig's directory (baseUrl defaults to ".").
 * Later sources only fill gaps — the game's own tsconfig wins over the
 * monorepo-level tsconfig.web.json.
 */
function loadPathAliases(tsconfigPath, aliasAcc) {
  let json;
  try { json = parseJsonc(readFileSync(tsconfigPath, "utf-8")); } catch { return; }
  const base = dirname(tsconfigPath);
  const paths = json?.compilerOptions?.paths ?? {};
  for (const [key, targets] of Object.entries(paths)) {
    if (key in aliasAcc) continue; // earlier source wins
    const list = Array.isArray(targets) ? targets : [targets];
    const target = list.find((t) =>
      existsSync(resolve(base, t)) || existsSync(resolve(base, `${t}.ts`)) || existsSync(resolve(base, `${t}.tsx`)),
    ) ?? list[0];
    if (!target) continue;
    const abs = resolve(base, target);
    if (key.endsWith("/*")) {
      const find = new RegExp(`^${escapeRe(key.slice(0, -2))}/(.*)`);
      aliasAcc[key] = { find, replacement: abs.endsWith("/*") ? abs.slice(0, -1) + "$1" : abs + "/$1" };
    } else {
      aliasAcc[key] = { find: new RegExp(`^${escapeRe(key)}$`), replacement: abs };
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Merge path aliases from the game tsconfig, then the monorepo web tsconfig. */
export function buildAliases(gameDir, repoRoot) {
  const acc = {};
  loadPathAliases(join(gameDir, "tsconfig.json"), acc);
  if (repoRoot) {
    loadPathAliases(join(repoRoot, "tsconfig.web.json"), acc);
    loadPathAliases(join(repoRoot, "tsconfig.json"), acc);
  }
  return Object.values(acc);
}

// ── Plugins ─────────────────────────────────────────────────────────────────

/**
 * import.meta.dir / .dirname / .filename / .path shim — Bun provides these
 * natively but the ModuleRunner does not. Prepends assignments to modules
 * that reference them (all runtimes — keeps runner-evaluated code
 * runtime-agnostic).
 */
export function metaDirPlugin() {
  const NEEDS = /import\.meta\.(dir|dirname|filename|path)\b/;
  return {
    name: "downdraft-meta-dir",
    transform: {
      filter: { id: /\.[cm]?[tj]sx?$/ },
      handler(code, id) {
        if (this.environment?.name !== "native" && this.environment) return;
        if (!NEEDS.test(code)) return;
        const banner =
          "try{const __ddm=import.meta;if(__ddm.dir===undefined){const __u=new URL('.',__ddm.url).pathname;__ddm.dir=__u.replace(/\\/$/,'');__ddm.dirname=__ddm.dir;__ddm.filename=decodeURIComponent(new URL(__ddm.url).pathname);__ddm.path=__ddm.filename;}}catch{}\n";
        return { code: banner + code, map: null };
      },
    },
  };
}

/**
 * import.meta.glob shim — vite only transforms LITERAL `import.meta.glob(`
 * calls. Native code often aliases it (`(import.meta as any).glob ??`,
 * `const g = import.meta.glob`) so Bun can fall back to a filesystem glob;
 * those member references reach the runner's throwing stub. Rewrite
 * non-call references to `__ddImportMetaGlob(import.meta)` — installed by
 * the dev runtime (native-dev-runtime.ts) as a createGlob() backed by the
 * module's own file:// directory.
 */
export function metaGlobShimPlugin() {
  return {
    name: "downdraft-meta-glob-shim",
    transform: {
      filter: { id: /\.[cm]?[tj]sx?$/ },
      handler(code, id) {
        if (this.environment?.name !== "native" && this.environment) return;
        let out = code;
        // Parenthesized/TS-asserted forms: (import.meta as any).glob
        out = out.replace(
          /\(import\.meta(?:\s+as\s+[\w$]+(?:\s+as\s+[\w$]+)?)?\)\s*\.glob\b/g,
          "__ddImportMetaGlob(import.meta)",
        );
        // Bare member reference that is NOT a literal call — leave
        // `import.meta.glob(` untouched for vite's own transform.
        out = out.replace(
          /import\.meta\.glob\b(?!\s*\()/g,
          "__ddImportMetaGlob(import.meta)",
        );
        if (out === code) return;
        return {
          code: "const __ddImportMetaGlob=(globalThis).__ddImportMetaGlob;\n" + out,
          map: null,
        };
      },
    },
  };
}

/**
 * `*.wgsl?raw` HMR boundary — mirrors packages/engine/core/src/vite/
 * wgsl-hmr-plugin.ts but as dependency-free .mjs so the supervisor can load
 * it natively under node/deno (it cannot import engine .ts).
 */
export function wgslRawHmrPlugin(hmrRegistryPath) {
  const registryImport = JSON.stringify(hmrRegistryPath);
  return {
    name: "downdraft-native-wgsl-hmr",
    enforce: "pre",
    load: {
      filter: { id: /\.wgsl(\?.*)?$/ },
      handler(id) {
        const queryIndex = id.indexOf("?");
        const pathPart = queryIndex > 0 ? id.slice(0, queryIndex) : id;
        const query = queryIndex > 0 ? id.slice(queryIndex + 1) : "";
        const isRaw = queryIndex < 0 || query.startsWith("raw");
        if (!isRaw) return; // non-raw wgsl imports fall through to ?url handling
        let source;
        try { source = readFileSync(pathPart, "utf-8"); } catch { return; }
        const shaderId = JSON.stringify(pathPart);
        return `import { wgslHotReload } from ${registryImport};
const src = ${JSON.stringify(source)};
wgslHotReload.register(${shaderId}, src);
export default src;
if (import.meta.hot) {
  import.meta.hot.accept((m) => {
    if (m && m.default !== undefined && m.default !== src) {
      wgslHotReload.reload(${shaderId}, m.default);
    }
  });
}
`;
      },
    },
  };
}

/**
 * Update classifier — decides which tier each changed file routes to.
 * Runs inside vite's `hotUpdate` hook for the "native" environment.
 *
 *   process-restart patterns → "process-restart" event, swallow ([]). Covers
 *     the dev shell itself and manifest/config files.
 *   host-restart patterns    → "host-restart" event, swallow.
 *   sim patterns             → "sim-update" event; graph members still
 *                              propagate (shared/ code feeds both threads).
 *   everything else          → vite propagates normally: accept boundaries
 *                              (wgsl ?raw, hmr-swap-registry, game code with
 *                              import.meta.hot.accept) apply in place;
 *                              dead-ends become full-reload → session restart.
 */
export function nativeHmrPlugin(options) {
  const {
    simPaths = [],
    excludePaths = [],
    hostRestartPaths = [],
    processRestartPaths = [],
    onEvent = () => {},
  } = options;

  const matches = (file, patterns) =>
    patterns.some((p) => file.includes(p));

  return {
    name: "downdraft-native-hmr",
    apply: "serve",
    configureServer(server) {
      // The watcher only covers vite's root + graph files. Worker-graph
      // files (never imported by the runner graph) need explicit watch paths.
      if (options.watchPaths?.length) server.watcher.add(options.watchPaths);
    },
    hotUpdate: {
      // New environment-aware signature: `this.environment` selects the env.
      handler(opts) {
        if (this.environment?.name !== "native") return;
        const file = opts.file.replace(/\\/g, "/");
        if (matches(file, excludePaths)) return undefined;
        if (matches(file, processRestartPaths)) {
          onEvent("process-restart", { file });
          return [];
        }
        if (matches(file, hostRestartPaths)) {
          onEvent("host-restart", { file });
          return [];
        }
        if (matches(file, simPaths)) {
          // Only script-module changes can reach the worker's module graph —
          // a .rs/.toml/.md/.png edit under a matched dir isn't a sim change
          // and must not trigger a save/terminate/respawn cycle.
          const clean = file.split("?")[0];
          const dot = clean.lastIndexOf(".");
          const ext = dot >= 0 ? clean.slice(dot) : "";
          if (!SIM_UPDATE_EXTS.has(ext)) return undefined;
          onEvent("sim-update", { file, timestamp: opts.timestamp, modules: opts.modules.length });
          // In-graph modules still propagate (shared code feeds renderer too);
          // non-graph worker files get swallowed (vite would no-op anyway).
          return opts.modules.length ? undefined : [];
        }
        return undefined;
      },
    },
  };
}

// ── downdraft.config.json hmr options ────────────────────────────────────────

export function loadGameConfig(gameDir) {
  try {
    return parseJsonc(readFileSync(join(gameDir, "downdraft.config.json"), "utf-8")) ?? {};
  } catch {
    return {};
  }
}

export function loadHmrOptions(gameDir) {
  return loadGameConfig(gameDir)?.hmr ?? {};
}

// ── Full dev config ─────────────────────────────────────────────────────────

/** Export-map condition that resolves @downdraft/* packages to TypeScript
 *  source instead of the pre-transpiled dist/ tree. Propagated to the child
 *  process via `--conditions` (bun/node) / DENO_CONDITIONS (deno) so native
 *  resolution (workers, externalized imports) sees the same universe. */
export const SOURCE_CONDITION = "downdraft-source";

/** Should the dev runner resolve engine packages from linked source
 *  (per-module transforms + full HMR) or the pre-built dist (externalized,
 *  near-zero transform cost, no engine-file HMR)?
 *
 *  Default: source inside the monorepo (repoRoot set), dist otherwise.
 *  `draft dev --engine-source` / `--engine-dist` (DD_ENGINE_SOURCE /
 *  DD_ENGINE_DIST env) override. */
export function engineSourceMode(repoRoot) {
  if (process.env.DD_ENGINE_DIST === "1") return false;
  if (process.env.DD_ENGINE_SOURCE === "1") return true;
  return !!repoRoot;
}

// Engine packages externalized when running in dist mode — their imports then
// resolve through package.json exports (default → dist/*.js) as native ESM,
// skipping the runner transform entirely.
const ENGINE_PACKAGES = ["@downdraft/engine", "@downdraft/platform-native"];

/**
 * Build the vite InlineConfig for the native dev shell.
 *
 * @param {object} opts
 * @param {object} opts.vite        the vite module (imported by the caller)
 * @param {string} opts.gameDir     absolute game dir (vite root)
 * @param {string|null} opts.repoRoot monorepo root (null in standalone games)
 * @param {"bun"|"node"|"deno"} opts.runtime
 * @param {boolean} opts.verbose
 * @param {string} opts.wgslRegistryPath abs path to engine's wgsl-hmr.ts
 * @param {(type: string, data: any) => void} opts.onEvent classifier events
 * @param {string[]} opts.watchPaths extra watcher paths (worker/sim dirs, repo)
 */
export function buildNativeDevConfig(opts) {
  const { vite, gameDir, repoRoot, runtime, verbose, wgslRegistryPath, onEvent, entry } = opts;
  const hmr = loadHmrOptions(gameDir);
  const engineSource = engineSourceMode(repoRoot);

  const simPaths = [...DEFAULT_SIM_PATTERNS, ...(hmr.simPaths ?? [])];
  const excludePaths = hmr.excludePaths ?? [];
  const hostRestartPaths = [...DEFAULT_HOST_RESTART_PATTERNS, ...(hmr.hostRestartPaths ?? [])];
  const processRestartPaths = [...DEFAULT_PROCESS_RESTART_PATTERNS, ...(hmr.processRestartPaths ?? [])];

  const aliases = buildAliases(gameDir, repoRoot);

  return {
    root: gameDir,
    configFile: false,
    mode: "development",
    appType: "custom",
    logLevel: verbose ? "info" : "warn",
    clearScreen: false,
    resolve: { alias: aliases },
    server: {
      middlewareMode: true,
      hmr: {
        // Without an outer http server (middlewareMode) vite would bind its
        // own HMR websocket server on port 24678 — nothing ever connects
        // (the "native" env uses an in-process hot channel and no browser
        // client exists), and the bind collides with any other vite process.
        // Hand it a never-listened server so it attaches an upgrade listener
        // instead of opening a socket. NOT `hmr: false` — that disables the
        // whole handleHMRUpdate pipeline the classifier hooks depend on.
        server: createHttpServer(),
      },
      watch: {
        // Keep the watcher lean — engine + game sources only.
        ignored: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.dd-dev/**"],
      },
    },
    environments: {
      native: {
        consumer: "server",
        resolve: {
          // Runtime-specific exports first (e.g. a package's "bun" condition),
          // then browser — packages without a runtime export get their
          // browser build, which is what the native surface expects. In
          // source mode "downdraft-source" resolves @downdraft/* to .ts
          // source; without it they resolve to dist/*.js.
          conditions: [runtime, ...(engineSource ? [SOURCE_CONDITION] : []), "browser", "module", "import", "default"],
          // All node builtins (bare + node: prefixed), plus bun:/deno:/
          // npm: namespaces — vite's default server-consumer builtins cover
          // node+bun+npm but we replace the array, so re-add them here.
          builtins: [...builtinModules, /^node:/, /^npm:/, /^bun:/, /^deno:/],
          // FFI + binary deps always resolve natively (never runner-evaluated).
          // Games declare extra native deps (NAPI addons, FFI modules, …)
          // via downdraft.config.json "native": { "external": [...] }.
          // In dist mode the engine packages externalize too — the runner
          // then transforms only game source; engine imports land as native
          // ESM on the pre-built dist/ tree (~0 transform cost).
          external: ["koffi", ...(loadGameConfig(gameDir)?.native?.external ?? []),
            ...(engineSource ? [] : ENGINE_PACKAGES)],
        },
        dev: {
          createEnvironment: (name, config, context) =>
            vite.createRunnableDevEnvironment(name, config, { ...context, hot: true }),
          // Pre-transform the entry + its whole static-import graph in the
          // background at server start (warmup crawls imports when
          // preTransformRequests is on — off by default for non-client
          // envs). The native host + splash boot in parallel with the
          // transform instead of behind it; runner.import() then hits a
          // warm module graph.
          // Order matters: the slim early-host graph first (it's what maps
          // the window), then the dev-runtime graph, then the entry — the
          // pipeline is FIFO-ish, so the small graphs don't queue behind
          // the entry's thousand-file crawl.
          // Order matters: the slim early-host graph first (it's what maps
          // the window), then the dev-runtime graph, then the entry. The
          // first transforms pay ~2-4s of cold-pipeline warmup — putting
          // the early graph first means the window maps at the earliest
          // possible point while the entry's thousand-file crawl continues
          // in the background.
          warmup: [
            join(DEV_DIR, "early-host.ts"),
            join(DEV_DIR, "native-dev-runtime.ts"),
            ...(entry ? [relative(gameDir, entry)] : []),
          ],
          preTransformRequests: true,
        },
      },
    },
    plugins: [
      metaDirPlugin(),
      metaGlobShimPlugin(),
      wgslRegistryPath ? wgslRawHmrPlugin(wgslRegistryPath) : null,
      nativeHmrPlugin({
        simPaths,
        excludePaths,
        hostRestartPaths,
        processRestartPaths,
        watchPaths: opts.watchPaths ?? [],
        onEvent,
      }),
    ].filter(Boolean),
    // No dep pre-bundling for the server-consumer env — externals resolve natively.
    optimizeDeps: { noDiscovery: true, include: [] },
  };
}

/** Resolve the engine's wgsl-hmr registry module file (for the ?raw
 *  boundary plugin). Pointing at the leaf module — not the render barrel —
 *  keeps module identity identical while avoiding a barrel re-eval. The
 *  registry module must live in the same universe as the code subscribing to
 *  it: source (.ts) in source mode, dist (.js) in dist mode. */
export function resolveWgslRegistryPath(gameDir, sourceMode) {
  const source = sourceMode ?? engineSourceMode(process.env.DD_REPO_ROOT || null);
  try {
    const req = createRequire(join(gameDir, "package.json"));
    // Locate the package root, then the leaf directly — wgsl-hmr has no
    // dedicated subpath export, and the package layout is stable. Works for
    // linked monorepo packages and npm installs alike (both ship src/).
    const pkgRoot = dirname(req.resolve("@downdraft/engine/package.json"));
    const leaf = source
      ? join(pkgRoot, "core/src/render/wgsl-hmr.ts")
      : join(pkgRoot, "dist/core/src/render/wgsl-hmr.js");
    if (existsSync(leaf)) return leaf;
    // Layout fallback: resolve the render barrel (which re-exports it) and
    // step to the sibling file.
    const barrel = req.resolve("@downdraft/engine/render");
    for (const l of ["wgsl-hmr.ts", "wgsl-hmr.js"].values()) {
      const p = join(dirname(barrel), l);
      if (existsSync(p)) return p;
    }
    return barrel;
  } catch {
    const guess = resolve(DEV_DIR, "../../engine/core/src/render/wgsl-hmr.ts");
    return existsSync(guess) ? guess : null;
  }
}
