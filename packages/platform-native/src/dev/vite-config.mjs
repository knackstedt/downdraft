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
import { builtinModules, createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    DEFAULT_HOST_RESTART_PATTERNS,
    DEFAULT_PROCESS_RESTART_PATTERNS,
    DEFAULT_SIM_PATTERNS
} from "./dev-constants.mjs";

const DEV_DIR = dirname(fileURLToPath(import.meta.url));

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

export function loadHmrOptions(gameDir) {
  try {
    const cfg = parseJsonc(readFileSync(join(gameDir, "downdraft.config.json"), "utf-8"));
    return cfg?.hmr ?? {};
  } catch {
    return {};
  }
}

// ── Full dev config ─────────────────────────────────────────────────────────

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
  const { vite, gameDir, repoRoot, runtime, verbose, wgslRegistryPath, onEvent } = opts;
  const hmr = loadHmrOptions(gameDir);

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
          // then browser — matching the electron-renderer resolution heritage.
          conditions: [runtime, "browser", "module", "import", "default"],
          // All node builtins (bare + node: prefixed), plus bun:/deno:/
          // npm: namespaces — vite's default server-consumer builtins cover
          // node+bun+npm but we replace the array, so re-add them here.
          builtins: [...builtinModules, /^node:/, /^npm:/, /^bun:/, /^deno:/],
          // FFI + binary deps always resolve natively (never runner-evaluated).
          external: ["koffi"],
        },
        dev: {
          createEnvironment: (name, config, context) =>
            vite.createRunnableDevEnvironment(name, config, { ...context, hot: true }),
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
 *  keeps module identity identical while avoiding a barrel re-eval. */
export function resolveWgslRegistryPath(gameDir) {
  try {
    const req = createRequire(join(gameDir, "package.json"));
    // wgsl-hmr has no dedicated subpath export — resolve the render barrel
    // (which re-exports it) then step to the sibling file.
    const barrel = req.resolve("@downdraft/engine/render");
    const leaf = join(dirname(barrel), "wgsl-hmr.ts");
    if (existsSync(leaf)) return leaf;
    return barrel;
  } catch {
    // Fallback: monorepo layout — engine source on disk.
    const guess = resolve(DEV_DIR, "../../engine/core/src/render/wgsl-hmr.ts");
    return existsSync(guess) ? guess : null;
  }
}
