// ============================================================================
// package-desktop.mjs — linux desktop packaging: staged app dir + formats
// ============================================================================
//
//   bun packages/cli/scripts/package-desktop.mjs [flags] <entry.ts> <outdir>
//
//     --runtime=bun|node|deno   JS host embedded in the package (default:
//                               package.json build.runtime, else bun)
//     --format=<csv>            dir | deb | appimage | flatpak (default:
//                               package.json build.linux.target, else dir)
//     --mode=dev|debug|prod     bundle mode (default: prod)
//     --product-name=<name>     display name (default: pkg.productName)
//     --product-version=<v>     version (default: pkg.version)
//     --app-id=<id>             reverse-DNS id (default: com.downdraft.<game>)
//     --executable-name=<n>     binary name (default: kebab-case productName)
//     --icon=<path>             png icon (default: build.linux.icon →
//                               build.icon → assets/icon.png → embedded)
//     --node-bin=<path>         node binary to ship (default: PATH lookup)
//     --deno-bin=<path>         deno binary to ship (default: PATH lookup)
//     --mcp                     retain the MCP automation endpoint
//
// Runtime matrix — what the "binary" actually is per --runtime:
//   bun   → `bun build --compile` via package-native.mjs — one self-contained
//           executable embedding the whole bundle (delegated subprocess).
//   node  → emitted .mjs bundle tree + a shipped node binary + launcher.
//   deno  → emitted .mjs bundle tree + a shipped deno binary + launcher.
//           (deno compile can't embed workers-at-absolute-paths — the bundle
//           tree is also what dd-assets/import.meta resolution anchors on.)
//
// App dir layout — identical shape across runtimes so all downstream
// resolution (lib-paths, dd-assets, workers, game-native .so/.node) is
// uniform. Everything anchors on dirname(process.execPath) == appdir root:
//
//   <exe>                  primary executable — compiled binary (bun) or a
//                          relocatable launcher script (node/deno)
//   node|deno              runtime binary (emit runtimes only)
//   bundle/                emitted .mjs tree + index.js + package.json
//   bundle/node_modules/   koffi + @koromix/koffi-<plat> prebuild (node only)
//   native/                libdowndraft_*.so + game-native dist/<plat>/*
//                          (includes .node addons — napi loads under all
//                          three desktop runtimes)
//   dd-assets/             ?url / new URL / import.meta.glob staged assets
//
// electron-builder-style config lives in the game's package.json `build`:
//
//   build: {
//     appId, productName, icon, runtime, executableName,
//     files: [ <paths copied into the appdir> ],
//     linux:  { target: ["deb","AppImage","flatpak"], category, maintainer,
//               synopsis, description, icon },
//     deb:    { section, priority, depends: [] },
//     flatpak:{ runtime, runtimeVersion, sdk, finishArgs: [] }
//   }
//
// Formats:
//   dir      — the staged appdir verbatim (what package-native produces)
//   deb      — /usr/lib/<exe> + /usr/bin symlink + desktop file + icons,
//              assembled with dpkg-deb
//   appimage — AppDir + AppRun + appimagetool (downloaded+cached on demand)
//   flatpak  — generated manifest + flatpak-builder + build-bundle
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
    readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlatLibDir } from "./native-lib-fetch.mjs";

// ── Args ──

const argv = process.argv.slice(2);
const flagValue = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const hasFlag = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a) => !a.startsWith("--"));
const [entry, outdirArg] = positional;

if (!entry || !outdirArg) {
  console.error(
    "usage: bun package-desktop.mjs [--runtime=bun|node|deno] [--format=dir|deb|appimage|flatpak,...] " +
    "[--mode=...] [--product-name=] [--product-version=] [--app-id=] [--executable-name=] [--icon=] " +
    "[--node-bin=] [--deno-bin=] [--mcp] <entry.ts> <outdir>");
  process.exit(1);
}

const gameDir = dirname(dirname(resolve(entry))); // src/native-entry.ts → game root
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(gameDir, "package.json"), "utf-8")); } catch { /* standalone entry */ }
const build = pkg.build ?? {};
const linuxCfg = build.linux ?? {};

const runtime = flagValue("runtime") ?? build.runtime ?? "bun";
if (!["bun", "node", "deno"].includes(runtime)) {
  console.error(`unknown --runtime "${runtime}" — expected bun, node, or deno`);
  process.exit(1);
}
const formats = (flagValue("format") ?? (Array.isArray(linuxCfg.target) ? linuxCfg.target.join(",") : linuxCfg.target) ?? "dir")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const KNOWN_FORMATS = new Set(["dir", "deb", "appimage", "flatpak"]);
for (const f of formats.values()) {
  if (!KNOWN_FORMATS.has(f)) {
    console.error(`unknown --format "${f}" — expected dir, deb, appimage, or flatpak`);
    process.exit(1);
  }
}
const mode = flagValue("mode") ?? "prod";
const retainMcp = hasFlag("mcp");

const titleize = (s) => String(s).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const productName = flagValue("product-name") ?? pkg.productName ?? build.productName ?? titleize(pkg.name ?? basename(gameDir));
const appId = flagValue("app-id") ?? build.appId ?? `com.downdraft.${basename(gameDir).replace(/[^a-zA-Z0-9]/g, "")}`;
const version = flagValue("product-version") ?? pkg.version ?? "0.0.1";
const exeName = (flagValue("executable-name") ?? build.executableName ?? productName)
  .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || basename(gameDir);
const maintainer = linuxCfg.maintainer
  ?? (typeof pkg.author === "string" ? pkg.author : pkg.author?.name) ?? "DownDraft";
const category = linuxCfg.category ?? "Game";
const synopsis = linuxCfg.synopsis ?? pkg.description ?? productName;
const description = linuxCfg.description ?? pkg.description ?? synopsis;

const outdir = resolve(outdirArg);
const appdir = join(outdir, `${basename(gameDir)}-linux-${runtime}`);
const platKey = `${process.platform}-${process.arch}`;
const repoRoot = process.cwd();

const run = (cmd, args, opts = {}) => {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
  return r;
};
const runOut = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
};

mkdirSync(appdir, { recursive: true });
console.log(`[package-desktop] ${productName} v${version} (${appId}) — runtime=${runtime}, formats=${formats.join(",")}`);

// ── Icon resolution ──

const DEFAULT_ICON = fileURLToPath(new URL("./default-icon.png", import.meta.url));
function resolveIcon() {
  const explicit = flagValue("icon") ?? linuxCfg.icon ?? build.icon;
  const candidates = [
    explicit ? resolve(gameDir, explicit) : null,
    join(gameDir, "assets/icon.png"),
    join(gameDir, "assets/icon.ico"),
    join(gameDir, "icon.png"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? (existsSync(DEFAULT_ICON) ? DEFAULT_ICON : null);
}
const iconPath = resolveIcon();
if (!iconPath) console.warn("[package-desktop] no icon found and embedded default missing");

// ── Shared bundle machinery (mirrors package-mobile.mjs; the emit-tree
//    flavor. Path anchors are dirname(process.execPath) — the appdir root —
//    for every runtime.) ──

const QUERY_RE = /\?(raw|url|json)$/;
const WORKER_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
// Rewrite variant — additionally consumes new URL's closing paren so the
// Worker's own arg list (options object, close paren) stays balanced.
const WORKER_URL_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)\s*(?:\.href|\.toString\(\s*\))?\s*/g;
const ASSET_URL_RE = /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_META = /(?:\(\s*import\.meta\s+as\s+any\s*\)|import\.meta(?:\s+as\s+any)?)/;
const GLOB_RE = new RegExp(IMPORT_META.source + String.raw`\.glob\(\s*(["'\`])([^"'\`]+)\1`, "g");
const GLOB_EAGER_RE = new RegExp(
  IMPORT_META.source + String.raw`\.glob\(\s*(["'\`])([^"'\`]+)\1\s*,\s*(\{[^)]*\beager\s*:\s*true[^)]*\})\s*\)`, "g");
const STAGE_GLOB_RE = new RegExp(
  `(?:${IMPORT_META.source}\\.glob|_glob|globAssets)\\(\\s*(["'\`])([^"'\`]+)\\1|createGlob\\([^)]*\\)\\(\\s*(["'\`])([^"'\`]+)\\3`, "g");
const STAGE_READ_RE = new RegExp(
  String.raw`(?:resolve|join)\(\s*(?:__dirname|${IMPORT_META.source}\.(?:dir|dirname|url))\s*,\s*(["'\`])([^"'\`]+)\1`, "g");
const META_DIR_RE = new RegExp(IMPORT_META.source + String.raw`\.(?:dir|dirname)\b`, "g");
const META_URL_RE = new RegExp(IMPORT_META.source + String.raw`\.url\b`, "g");
const REQUIRE_GLOB_RE = /require\(\s*["'`]@downdraft\/engine\/platform\/glob-polyfill["'`]\s*\)/g;
const GLOB_CALLEE_RE = new RegExp(IMPORT_META.source + String.raw`\.glob`);
const SCRIPT_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts|cjs)$/i; // .mjs staged as an asset (execArgv loaders)
const DYN_IMPORT_RE = /import\(\s*([a-zA-Z_$][\w$]*)\s*\)/g;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function resolveSpec(spec, importer) {
  try {
    return spec.startsWith(".") || spec.startsWith("/")
      ? resolve(dirname(importer), spec)
      : Bun.resolveSync(spec, dirname(importer));
  } catch { return null; }
}

/** Repo-relative bundle path for a module, with .mjs extension. Bun's
 *  `[dir]` naming escapes out-of-root `..` segments as `_.._`. */
function bundlePath(absPath) {
  return relative(repoRoot, absPath).replace(/\\/g, "/").replace(/\.[jt]sx?$/, ".mjs")
    .split("/").map((s) => (s === ".." ? "_.._" : s)).join("/");
}

function assetRel(absPath) {
  const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
  if (!rel.startsWith("..")) return rel;
  const h = createHash("sha1").update(dirname(absPath)).digest("hex").slice(0, 8);
  return `external/${h}/${basename(absPath)}`;
}

function walkDir(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (const e of entries.values()) {
    const full = `${dir}/${e}`;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkDir(full, results);
    else results.push(full);
  }
  return results;
}

// Mirrors globToRegex in packages/engine/core/src/platform/glob-polyfill.ts
// — keep in sync.
function globToRegex(pattern) {
  const regex = pattern
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\x00")
    .replace(/\*\*/g, "\x01")
    .replace(/\*/g, "[^/]*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, "|")})`)
    .replace(/\x00/g, "(?:.*/)?")
    .replace(/\x01/g, ".*");
  return new RegExp(`^${regex}$`, "i");
}

/** Expand an import.meta.glob pattern against the real FS at package time. */
function expandGlob(fromDir, pattern) {
  const rootParts = [];
  for (const p of pattern.split("/")) {
    if (p.includes("*") || p.includes("{")) break;
    rootParts.push(p);
  }
  const searchDir = resolve(fromDir, ...rootParts);
  if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) return [];
  const matchRegex = globToRegex(pattern.replace(/^\.\//, ""));
  return walkDir(searchDir)
    .map((f) => relative(fromDir, f).replace(/\\/g, "/"))
    .filter((rel) => matchRegex.test(rel) || matchRegex.test(`./${rel}`))
    .sort();
}

const workerEntries = new Set();
const dynImports = new Map();
const assetFiles = new Set();

// Emitted path anchor — every runtime resolves the appdir through
// dirname(process.execPath): bun → the compiled binary, node → the shipped
// node binary, deno → the shipped deno binary. All live at the appdir root.
const APPDIR = "__ddAppDir";

const makeEmitPlugin = (collectWorkers) => ({
  name: "downdraft-desktop-emit",
  setup(build_) {
    const resolveImport = (spec, importer) => {
      const base = spec.startsWith(".") || spec.startsWith("/")
        ? resolve(dirname(importer), spec)
        : Bun.resolveSync(spec, dirname(importer));
      return existsSync(base) ? base : (existsSync(`${base}.ts`) ? `${base}.ts` : base);
    };
    build_.onResolve({ filter: /\?(raw|url|json)$/ }, (args) => {
      const clean = args.path.replace(QUERY_RE, "");
      const kind = args.path.match(QUERY_RE)[1];
      const resolved = resolveImport(clean, args.importer);
      if (resolved.endsWith(".ts")) return { path: resolved };
      return { path: resolved, namespace: `dd-${kind}` };
    });
    build_.onLoad({ filter: /.*/, namespace: "dd-raw" }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, "utf-8"))};`,
      loader: "js",
    }));
    build_.onLoad({ filter: /.*/, namespace: "dd-json" }, (args) => ({
      contents: `export default ${JSON.stringify(JSON.parse(readFileSync(args.path, "utf-8")))};`,
      loader: "js",
    }));
    // ?url → file:// URL into the staged dd-assets tree (packaged) or the
    // absolute path (scan pass).
    build_.onLoad({ filter: /.*/, namespace: "dd-url" }, (args) => {
      assetFiles.add(args.path);
      if (collectWorkers) {
        return { contents: `export default ${JSON.stringify(args.path)};`, loader: "js" };
      }
      const rel = assetRel(args.path);
      return {
        contents:
          `import { dirname as __ddDirname } from "node:path";` +
          `import { pathToFileURL as __ddP2F } from "node:url";` +
          `export default __ddP2F(__ddDirname(process.execPath) + "/dd-assets/" + ${JSON.stringify(rel)}).href;`,
        loader: "js",
      };
    });
    ["wgsl", "glsl"].forEach((ext) => {
      build_.onResolve({ filter: new RegExp(`\\.${ext}$`) }, (args) => {
        const resolved = resolveImport(args.path, args.importer);
        if (resolved.endsWith(".ts")) return { path: resolved };
        return { path: resolved, namespace: "dd-raw" };
      });
    });
    build_.onResolve({ filter: /\.css$/ }, (args) => {
      if (args.path.startsWith("dd-css:")) {
        return { path: args.path.slice("dd-css:".length), namespace: "dd-css" };
      }
      let path;
      try { path = resolveImport(args.path, args.importer); }
      catch { path = resolve(dirname(args.importer), args.path); }
      return { path, namespace: "dd-css" };
    });
    build_.onLoad({ filter: /.*/, namespace: "dd-css" }, () => ({
      contents: `export default "";`, loader: "js",
    }));
    build_.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
      const src = readFileSync(args.path, "utf-8");
      const modDir = dirname(args.path);
      const modRel = assetRel(args.path);
      const modBase = basename(modRel).replace(/\.[jt]sx?$/, ".js");
      const stagedDir = dirname(modRel);

      // Worker entrypoints — needed in both passes (pass 1 collects).
      for (const m of src.matchAll(WORKER_RE)) {
        const p = resolve(modDir, m[1]);
        if (existsSync(p)) workerEntries.add(p);
      }
      // Asset refs: new URL("x.png", import.meta.url) where x isn't a script.
      for (const m of src.matchAll(ASSET_URL_RE)) {
        // Scripts are bundled; .mjs loaders (worker-bootstrap, wgsl-loader)
        // are spawned via execArgv and must exist as real files — stage them.
        if (SCRIPT_EXT_RE.test(m[1])) continue;
        const p = resolve(modDir, m[1]);
        if (existsSync(p) && statSync(p).isFile()) assetFiles.add(p);
      }
      for (const m of src.matchAll(DYN_IMPORT_RE)) {
        const ident = m[1];
        const bind = src.match(new RegExp("(?:const|let|var)\\s+" + escapeRe(ident) + "\\s*=\\s*([\"'`])([^\"'`]+)\\1"));
        if (!bind) continue;
        const spec = bind[2];
        if (!spec || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
        const abs = resolveSpec(spec, args.path);
        if (!abs || !existsSync(abs)) continue;
        workerEntries.add(abs);
        dynImports.set(`${args.path}:${ident}`, { ident, spec, abs });
      }
      for (const m of src.matchAll(STAGE_READ_RE)) {
        if (SCRIPT_EXT_RE.test(m[2])) continue;
        const p = resolve(modDir, m[2]);
        if (existsSync(p) && statSync(p).isFile()) assetFiles.add(p);
      }
      for (const m of src.matchAll(STAGE_GLOB_RE)) {
        const pattern = m[2] ?? m[4];
        if (!pattern) continue;
        const rootParts = [];
        for (const p of pattern.split("/")) {
          if (p.includes("*") || p.includes("{")) break;
          rootParts.push(p);
        }
        const searchDir = resolve(modDir, ...rootParts);
        if (existsSync(searchDir) && statSync(searchDir).isDirectory()) {
          for (const f of walkDir(searchDir)) assetFiles.add(f);
        }
      }

      const loader = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mts: "ts" }[args.path.split(".").pop()] || "ts";
      let needsGlob = false;

      // 0. Eager module globs → static imports generated at package time.
      const eagerDecls = [];
      let eagerSeq = 0;
      let out = src.replace(GLOB_EAGER_RE, (m, _q, pattern, opts) => {
        if (/\bquery\s*:/.test(opts)) {
          needsGlob = true;
          return m.replace(GLOB_CALLEE_RE, "__ddGlob");
        }
        const spec = /\bimport\s*:\s*["']([A-Za-z_$][\w$]*)["']/.exec(opts)?.[1];
        const name = `__ddEager${eagerSeq++}`;
        const entries = expandGlob(modDir, pattern).map((f, i) => {
          const rel = f.startsWith(".") ? f : "./" + f;
          const ident = `${name}$${i}`;
          eagerDecls.push(`import * as ${ident} from ${JSON.stringify(rel)};`);
          return `${JSON.stringify(rel)}: ${spec ? `${ident}.${spec}` : ident}`;
        });
        eagerDecls.push(`const ${name} = {${entries.length ? "\n  " + entries.join(",\n  ") + ",\n" : ""}};`);
        return name;
      });
      const eagerPrologue = eagerDecls.length ? eagerDecls.join("\n") + "\n" : "";

      if (collectWorkers) return eagerPrologue ? { contents: eagerPrologue + out, loader } : undefined;

      let needsAppDir = false;

      // 1. Worker URLs → file:// URL into the emitted bundle tree. Deno
      //    requires a URL (bare paths throw), node's Worker polyfill accepts
      //    URL or path — the file:// URL form serves both.
      out = out.replace(WORKER_URL_RE, (m, spec) => {
        needsAppDir = true;
        const rel = bundlePath(resolve(modDir, spec));
        return `new Worker(new URL("file://" + ${APPDIR} + "/bundle/" + ${JSON.stringify(rel)})`;
      });
      // 1.5 new URL("<asset>", import.meta.url) → absolute file URL into the
      //     staged dd-assets tree (see package-mobile for the assetRel note).
      out = out.replace(ASSET_URL_RE, (m, spec) => {
        const p = resolve(modDir, spec);
        if (!existsSync(p)) return m;
        needsAppDir = true;
        return `new URL("file://" + ${APPDIR} + "/dd-assets/" + ${JSON.stringify(assetRel(p))})`;
      });
      // 2. Variable-specifier dynamic imports → file:// URL of the emitted
      //    bundle module (file:// because deno rejects bare abs paths).
      let hadDyn = false;
      for (const m of out.matchAll(DYN_IMPORT_RE)) {
        const ident = m[1];
        const info = dynImports.get(`${args.path}:${ident}`);
        if (!info) continue;
        hadDyn = true; needsAppDir = true;
        const decl = new RegExp("((?:const|let|var)\\s+" + escapeRe(ident) + "\\s*=\\s*)([\"'`])" + escapeRe(info.spec) + "\\2");
        out = out.replace(decl, `$1$2file://@@APPDIR@@/${bundlePath(info.abs)}$2`);
      }
      // 3. import.meta.glob → createGlob bound to the staged dir.
      out = out.replace(GLOB_RE, (m) => { needsGlob = true; return m.replace(GLOB_CALLEE_RE, "__ddGlob"); });
      if (REQUIRE_GLOB_RE.test(out)) {
        needsGlob = true;
        out = out.replace(REQUIRE_GLOB_RE, "({ createGlob: __ddCreateGlob })");
      }
      // 4. import.meta.dir/.url/__dirname → module's staged dir under
      //    dd-assets (real FS).
      const metaOut = out
        .replace(META_DIR_RE, "__ddModDir")
        .replace(META_URL_RE, "__ddModUrl")
        .replace(/(?<![.\w$])__dirname\b/g, "__ddModDir");
      if (metaOut !== out) needsAppDir = true;
      if (metaOut !== out || needsGlob || needsAppDir) {
        out =
          `import { dirname as __ddDirname } from "node:path";\n` +
          `import { pathToFileURL as __ddP2F } from "node:url";\n` +
          `const ${APPDIR} = __ddDirname(process.execPath);\n` +
          `const __ddModDir = ${APPDIR} + "/dd-assets/" + ${JSON.stringify(stagedDir === "." ? "" : stagedDir + "/")}.replace(/\\/$/, "");\n` +
          `const __ddModUrl = __ddP2F(__ddModDir + "/" + ${JSON.stringify(modBase)}).href;\n` +
          (needsGlob
            ? `import { createGlob as __ddCreateGlob } from "@downdraft/engine/platform/glob-polyfill";\n` +
              // Lazy — eager construction runs at module-init time and can
              // hit a TDZ on consts declared later in the same module
              // (glob-polyfill.ts itself matches REQUIRE_GLOB_RE via a
              // comment and crashed exactly this way).
              `const __ddGlob = (p, o) => __ddCreateGlob(__ddModDir)(p, o);\n`
            : "") +
          metaOut;
      }
      // @@APPDIR@@ sentinel → appdir expression (post meta rewrite).
      out = out.replaceAll("@@APPDIR@@", `" + ${APPDIR} + "`);
      if (eagerPrologue) out = eagerPrologue + out;
      return out === src ? undefined : { contents: out, loader };
    });
  },
});

// ── Scan pass: discover Worker entrypoints to a fixpoint ──

const scanOutdir = mkdtempSync(join(tmpdir(), "dd-scan-"));
let prevCount = -1;
while (workerEntries.size !== prevCount) {
  prevCount = workerEntries.size;
  const scan = await Bun.build({
    entrypoints: [resolve(entry), ...workerEntries],
    target: "node",
    plugins: [makeEmitPlugin(true)],
    splitting: false,
    sourcemap: "none",
    minify: false,
    define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
    outdir: scanOutdir,
    external: ["koffi", "bun:ffi", "bun:test", "bun"],
  });
  if (!scan.success) {
    scan.logs.forEach((msg) => { console.error(msg); });
    process.exit(1);
  }
}

const entrypoints = [resolve(entry), ...workerEntries];
if (workerEntries.size) {
  console.log(`workers: ${[...workerEntries].map((p) => p.split("/").pop()).join(", ")}`);
}

// ── Stage engine + game-native libs into <appdir>/native ──

const libExt = platKey.startsWith("win32") ? ".dll" : platKey.startsWith("darwin") ? ".dylib" : ".so";

async function pkgRoot(name) {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(resolve(entry));
    return dirname(req.resolve(`${name}/package.json`));
  } catch { return null; }
}

async function stageEngineLibs(nativeDir) {
  mkdirSync(nativeDir, { recursive: true });
  // Same probe order as package-native.mjs — platform dir, installed
  // platform-native, per-target npm platform package.
  const platPkg = await pkgRoot("@downdraft/platform-native");
  const platNpm = await pkgRoot(`@downdraft/native-${platKey}`);
  const engineRoot = await pkgRoot("@downdraft/engine");
  const platLibCandidates = [...new Set([
    join(repoRoot, "packages/platform-native/native", platKey),
    platPkg && join(platPkg, "native", platKey),
    platPkg && join(platPkg, platKey),
    platNpm && join(platNpm, "lib"),
  ].filter(Boolean))];
  // Foreign-platform optional deps aren't installed on this host — fetch
  // the @downdraft/native-<plat>-<arch> tarball from npm into a cache.
  const platPkgVersion = platPkg &&
    JSON.parse(readFileSync(join(platPkg, "package.json"), "utf8")).version;
  const platStageDir = await resolvePlatLibDir(
    platKey, platLibCandidates, join(gameDir, "node_modules", ".cache"), platPkgVersion);
  if (!platStageDir) {
    throw new Error(`no libdowndraft_platform build found for ${platKey} — searched: ${platLibCandidates.join(", ")}`);
  }
  for (const f of readdirSync(platStageDir)) {
    if (f.endsWith(libExt)) copyFileSync(join(platStageDir, f), join(nativeDir, f));
  }
  // Engine cdylibs via the shared crate registry (same candidates as
  // package-native.mjs).
  let CRATES = [];
  try {
    ({ CRATES } = await import(fileURLToPath(new URL("../../../scripts/native-crates.mjs", import.meta.url))));
  } catch { /* published package — probed via node resolution below */ }
  const libFileName = (n) => platKey.startsWith("win32") ? `${n}.dll`
    : platKey.startsWith("darwin") ? `lib${n}.dylib` : `lib${n}.so`;
  for (const crate of CRATES.filter((c) => c.pkg !== "downdraft-platform")) {
    const file = libFileName(crate.lib);
    const pkgRel = crate.dir.replace(/^packages\/engine\//, "");
    const candidates = [
      join(repoRoot, crate.dest, platKey, file),
      join(repoRoot, crate.dest, file),
      join(repoRoot, crate.dir, "target", "release", file),
      join(repoRoot, crate.dir, file),
      ...(engineRoot ? [
        join(engineRoot, pkgRel, "dist", platKey, file),
        join(engineRoot, pkgRel, "dist", file),
      ] : []),
    ];
    for (const p of candidates.values()) {
      if (existsSync(p)) { copyFileSync(p, join(nativeDir, file)); break; }
    }
  }
}

/** Game-owned native artifacts: <game>/native/dist/<plat>/ → appdir/native/.
 *  Covers .so cdylibs AND .node napi addons (all three desktop runtimes can
 *  load napi). The convention game-side loaders resolve — see
 *  games/<name>/src/tests/native/native-bridge-lib.ts. */
function stageGameNative(nativeDir) {
  const dist = join(gameDir, "native", "dist", platKey);
  if (!existsSync(dist)) return;
  mkdirSync(nativeDir, { recursive: true });
  for (const f of readdirSync(dist)) {
    copyFileSync(join(dist, f), join(nativeDir, f));
    console.log(`  game-native: ${f}`);
  }
}

// ── Runtime dispatch: build the appdir ──

const nativeDir = join(appdir, "native");

if (runtime === "bun") {
  // Delegate to package-native.mjs — outfile lands at <appdir>/<exe> and its
  // native/ + dd-assets/ siblings land at <appdir>/ exactly.
  const nativeScript = fileURLToPath(new URL("./package-native.mjs", import.meta.url));
  run("bun", [
    nativeScript,
    "--target=linux",
    `--mode=${mode}`,
    `--product-name=${productName}`,
    `--product-version=${version}`,
    ...(retainMcp ? ["--mcp"] : []),
    resolve(entry),
    join(appdir, exeName),
  ], { cwd: repoRoot });
} else {
  // Emit the bundle tree into <appdir>/bundle/.
  const bundleDir = join(appdir, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const buildResult = await Bun.build({
    entrypoints,
    target: "node",
    root: repoRoot,
    naming: { entry: "[dir]/[name].mjs" },
    plugins: [makeEmitPlugin(false)],
    splitting: false,
    sourcemap: "none",
    minify: mode === "prod",
    define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
    external: ["koffi", "bun:ffi", "bun:test", "bun"],
    outdir: bundleDir,
  });
  if (!buildResult.success) {
    buildResult.logs.forEach((msg) => { console.error(msg); });
    process.exit(1);
  }

  // Entry shim + type:module marker (same pattern as package-mobile).
  const entryRel = bundlePath(resolve(entry));
  writeFileSync(join(bundleDir, "index.js"), `await import("./${entryRel}");\n`);
  writeFileSync(join(bundleDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");

  // koffi + platform prebuild — node's FFI fallback needs real files.
  if (runtime === "node") {
    const { createRequire } = await import("node:module");
    const gameRequire = createRequire(resolve(entry));
    let koffiRoot = null;
    try { koffiRoot = dirname(gameRequire.resolve("koffi")); } catch { /* absent */ }
    if (!koffiRoot) {
      console.warn("[package-desktop] koffi not resolvable — FFI will fail under the node runtime");
    } else {
      const nm = join(bundleDir, "node_modules");
      cpSync(koffiRoot, join(nm, "koffi"), { recursive: true });
      const koffiVer = JSON.parse(readFileSync(join(koffiRoot, "package.json"), "utf-8")).version;
      const prebuild = `@koromix/koffi-${platKey}`;
      let src = join(dirname(koffiRoot), prebuild);
      if (!existsSync(join(src, "package.json"))) src = null;
      // bun's .bun store exposes packages through symlinks — cpSync chokes
      // on the link itself (ERR_FS_CP_EINVAL), so copy the real dir.
      if (src) src = realpathSync(src);
      if (!src) src = await fetchKoffiPrebuild(prebuild, koffiVer);
      if (!src) {
        console.warn(`[package-desktop] ${prebuild}@${koffiVer} unavailable — FFI will fail`);
      } else {
        cpSync(src, join(nm, "@koromix", basename(prebuild)), { recursive: true });
      }
    }
  }

  // Runtime binary + launcher. The runtime binary sits at the appdir root so
  // dirname(process.execPath) anchors native/ + dd-assets/ + bundle/.
  const rtBin = flagValue(`${runtime}-bin`) ?? runOut("sh", ["-c", `command -v ${runtime}`]);
  if (!rtBin) throw new Error(`${runtime} not found on PATH — pass --${runtime}-bin=<path>`);
  copyFileSync(realpathSync(rtBin), join(appdir, runtime));
  chmodSync(join(appdir, runtime), 0o755);

  const rtArgs = runtime === "deno" ? "run -A --no-config" : "";
  writeFileSync(join(appdir, exeName),
    `#!/bin/sh\n` +
    `# ${productName} — ${runtime} runtime launcher (package-desktop.mjs)\n` +
    `SELF="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"\n` +
    `DIR="$(dirname "$SELF")"\n` +
    `exec "$DIR/${runtime}" ${rtArgs} "$DIR/bundle/index.js" "$@"\n`);
  chmodSync(join(appdir, exeName), 0o755);

  // Engine cdylibs (bun's path stages these inside package-native).
  await stageEngineLibs(nativeDir);
}

// Game-native artifacts (.so + .node) → appdir/native/.
stageGameNative(nativeDir);

// Follow relative imports inside staged script assets — execArgv loader
// files (wgsl-loader.mjs, worker-bootstrap.mjs) are staged raw, not
// bundled, so their own module deps never enter the graph otherwise.
{
  const ASSET_IMPORT_RE = /(?:from|import|register)\s*\(?\s*(["'`])(\.[^"'`]+)\1/g;
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of [...assetFiles].values()) {
      if (!/\.(mjs|cjs|js)$/.test(f)) continue;
      let src;
      try { src = readFileSync(f, "utf-8"); } catch { continue; }
      for (const m of src.matchAll(ASSET_IMPORT_RE)) {
        const p = resolve(dirname(f), m[2]);
        if (existsSync(p) && statSync(p).isFile() && !assetFiles.has(p)) {
          assetFiles.add(p);
          grew = true;
        }
      }
    }
  }
}

// dd-assets — the emit runtimes need them staged; the bun path already staged
// them inside package-native (assetFiles is populated by the scan pass here
// either way, and re-copying identical files is harmless but skipped).
if (runtime !== "bun") {
  const assetRoot = join(appdir, "dd-assets");
  let stagedAssets = 0;
  for (const f of assetFiles.values()) {
    const dest = join(assetRoot, assetRel(f));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f, dest);
    stagedAssets++;
  }
  console.log(`staged: ${nativeDir ? readdirSync(nativeDir).filter((f) => f.endsWith(libExt)).length : 0} native libs, ${stagedAssets} assets`);
}

// build.files — electron-builder-style extra files into the appdir root.
for (const f of (Array.isArray(build.files) ? build.files : []).values()) {
  const src = resolve(gameDir, typeof f === "string" ? f : f.from);
  const dest = join(appdir, typeof f === "string" ? basename(f) : (f.to ?? basename(f.from)));
  if (!existsSync(src)) { console.warn(`[package-desktop] files entry missing: ${src}`); continue; }
  cpSync(src, dest, { recursive: true });
}

// ── Shared format assets: .desktop + icons + metainfo ──

function desktopFile(iconName = exeName) {
  return (
    `[Desktop Entry]\n` +
    `Type=Application\n` +
    `Name=${productName}\n` +
    `Comment=${synopsis}\n` +
    `Exec=${exeName}\n` +
    `Icon=${iconName}\n` +
    `Terminal=false\n` +
    `Categories=${category}\n`);
}

function metainfoXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<component type="desktop-application">\n` +
    `  <id>${appId}</id>\n` +
    `  <name>${productName}</name>\n` +
    `  <summary>${synopsis}</summary>\n` +
    `  <launchable type="desktop-id">${appId}.desktop</launchable>\n` +
    `</component>\n`);
}

/** Resize the icon into hicolor sizes via jimp (already a cli dep); falls
 *  back to copying the source verbatim at 256px when jimp can't load it. */
async function iconSet(destDir) {
  const sizes = [48, 128, 256];
  const written = {};
  let img = null;
  try {
    const { Jimp } = await import("jimp");
    img = await Jimp.read(iconPath);
  } catch { /* unreadable — verbatim fallback below */ }
  for (const s of sizes.values()) {
    const dir = join(destDir, `${s}x${s}`, "apps");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${exeName}.png`);
    try {
      if (!img) throw new Error("no decoder");
      await img.clone().resize({ w: s, h: s }).write(dest);
    } catch {
      copyFileSync(iconPath, dest);
    }
    written[s] = dest;
  }
  return written;
}

const artifacts = [];
const pkgLabel = productName.replace(/\s+/g, "-");

// ── Format: dir — the appdir itself ──

if (formats.includes("dir")) {
  artifacts.push(`dir  ${appdir}`);
}

// ── Format: deb ──

if (formats.includes("deb")) {
  const debCfg = build.deb ?? {};
  const stage = mkdtempSync(join(tmpdir(), "dd-deb-"));
  const root = join(stage, "pkg");
  const libDir = join(root, "usr/lib", exeName);
  mkdirSync(libDir, { recursive: true });
  cpSync(appdir, libDir, { recursive: true, verbatimSymlinks: true });

  mkdirSync(join(root, "usr/bin"), { recursive: true });
  symlinkSync(`../lib/${exeName}/${exeName}`, join(root, "usr/bin", exeName));

  mkdirSync(join(root, "usr/share/applications"), { recursive: true });
  writeFileSync(join(root, "usr/share/applications", `${appId}.desktop`), desktopFile());
  if (iconPath) await iconSet(join(root, "usr/share/icons/hicolor"));
  mkdirSync(join(root, "usr/share/metainfo"), { recursive: true });
  writeFileSync(join(root, "usr/share/metainfo", `${appId}.metainfo.xml`), metainfoXml());

  const sizeKb = parseInt(runOut("du", ["-sk", libDir])?.split("\t")[0] ?? "0", 10);
  const depends = (debCfg.depends ?? ["libc6", "libstdc++6", "libvulkan1"]).join(", ");
  mkdirSync(join(root, "DEBIAN"), { recursive: true });
  writeFileSync(join(root, "DEBIAN/control"),
    `Package: ${exeName}\n` +
    `Version: ${version}\n` +
    `Section: ${debCfg.section ?? "games"}\n` +
    `Priority: ${debCfg.priority ?? "optional"}\n` +
    `Architecture: amd64\n` +
    `Installed-Size: ${sizeKb}\n` +
    `Maintainer: ${maintainer}\n` +
    `Depends: ${depends}\n` +
    `Description: ${synopsis}\n` +
    ` ${description.replace(/\n/g, "\n ")}\n`);

  const out = join(outdir, `${exeName}_${version}+${runtime}_amd64.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", root, out]);
  artifacts.push(`deb  ${out}`);
}

// ── Format: appimage ──

if (formats.includes("appimage")) {
  const stage = mkdtempSync(join(tmpdir(), "dd-appimage-"));
  const aDir = join(stage, "AppDir");
  mkdirSync(aDir, { recursive: true });
  cpSync(appdir, aDir, { recursive: true, verbatimSymlinks: true });

  // AppRun — the entrypoint the AppImage runtime execs. Symlink to the exe;
  // the launcher's readlink -f resolves it to the real file at AppDir root.
  symlinkSync(exeName, join(aDir, "AppRun"));
  writeFileSync(join(aDir, `${exeName}.desktop`), desktopFile());
  if (iconPath) {
    copyFileSync(iconPath, join(aDir, `${exeName}.png`));
    symlinkSync(`${exeName}.png`, join(aDir, ".DirIcon"));
  }

  const tool = await appimagetool();
  const out = join(outdir, `${pkgLabel}-${version}-linux-${runtime}.AppImage`);
  run(tool, [aDir, out], {
    env: {
      ...process.env,
      ARCH: "x86_64",
      // appimagetool is itself an AppImage — extract+run without FUSE.
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });
  chmodSync(out, 0o755);
  artifacts.push(`appimage  ${out}`);
}

/** Locate or download appimagetool into the tool cache. */
async function appimagetool() {
  const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME, ".cache"), "downdraft", "tools");
  const cached = join(cacheDir, "appimagetool-x86_64");
  if (existsSync(cached)) return cached;
  const url = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
  console.log(`[package-desktop] fetching appimagetool → ${cached}`);
  mkdirSync(cacheDir, { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`appimagetool download failed: ${res.status}`);
  writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  chmodSync(cached, 0o755);
  return cached;
}

// ── Format: flatpak ──

if (formats.includes("flatpak")) {
  const fpCfg = build.flatpak ?? {};
  const stage = mkdtempSync(join(tmpdir(), "dd-flatpak-"));
  const buildDir = join(stage, "build");
  const repoDir = join(stage, "repo");

  const desktopFilePath = join(stage, `${appId}.desktop`);
  writeFileSync(desktopFilePath, desktopFile(appId));
  // Flatpak only exports icons whose basename matches the app-id.
  const iconStage = join(stage, `${appId}.png`);
  if (iconPath) copyFileSync(iconPath, iconStage);

  const finishArgs = fpCfg.finishArgs ?? [
    "--socket=wayland", "--socket=fallback-x11", "--share=ipc",
    "--device=dri", "--socket=pulseaudio",
    "--filesystem=home", "--share=network",
  ];
  const manifest = {
    "app-id": appId,
    "runtime": fpCfg.runtime ?? "org.freedesktop.Platform",
    "runtime-version": fpCfg.runtimeVersion ?? "25.08",
    "sdk": fpCfg.sdk ?? "org.freedesktop.Sdk",
    "command": exeName,
    "separate-locales": false,
    "finish-args": finishArgs,
    "modules": [{
      "name": exeName,
      "buildsystem": "simple",
      // A `bun build --compile` binary keeps its embedded bundle appended
      // past the ELF sections — strip(1) rewrites the file and silently
      // drops it, turning the app into a bare `bun` CLI. Disable it.
      "build-options": { "strip": false, "no-debuginfo": true },
      "sources": [
        { "type": "dir", "path": appdir, "dest": "appdir" },
        { "type": "file", "path": desktopFilePath },
        ...(iconPath ? [{ "type": "file", "path": iconStage }] : []),
      ],
      "build-commands": [
        `mkdir -p /app/lib/${exeName} /app/bin`,
        `cp -a appdir/. /app/lib/${exeName}/`,
        `ln -s /app/lib/${exeName}/${exeName} /app/bin/${exeName}`,
        `install -Dm644 ${basename(desktopFilePath)} /app/share/applications/${appId}.desktop`,
        ...(iconPath ? [`install -Dm644 ${appId}.png /app/share/icons/hicolor/256x256/apps/${appId}.png`] : []),
      ],
    }],
  };
  const manifestPath = join(stage, `${appId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (!runOut("sh", ["-c", "command -v flatpak-builder"])) {
    throw new Error("flatpak-builder not installed — required for the flatpak format");
  }
  // --state-dir must share the target's filesystem (flatpak-builder hard-
  // links source files); the default cwd-based dir fails when TMPDIR is a
  // different mount than the checkout.
  run("flatpak-builder", ["--repo", repoDir, "--state-dir", join(stage, "state"), "--force-clean", buildDir, manifestPath]);
  const out = join(outdir, `${pkgLabel}-${version}-linux-${runtime}.flatpak`);
  run("flatpak", ["build-bundle", repoDir, out, appId]);
  artifacts.push(`flatpak  ${out}`);
}

// ── koffi prebuild fetch (same mechanism as package-mobile) ──

async function fetchKoffiPrebuild(pkgName, ver) {
  try {
    const meta = await (await fetch(
      `https://registry.npmjs.org/${pkgName.replace("/", "%2F")}`)).json();
    const tarball = meta?.versions?.[ver]?.dist?.tarball ?? meta?.versions?.[meta["dist-tags"]?.latest]?.dist?.tarball;
    if (!tarball) return null;
    const dir = mkdtempSync(join(tmpdir(), "dd-koffi-"));
    const tgz = join(dir, "pkg.tgz");
    writeFileSync(tgz, Buffer.from(await (await fetch(tarball)).arrayBuffer()));
    run("tar", ["-xzf", tgz, "-C", dir]);
    return join(dir, "package");
  } catch (e) {
    console.warn(`[package-desktop] koffi prebuild fetch failed: ${e?.message ?? e}`);
    return null;
  }
}

console.log(`[package-desktop] done (${runtime}):`);
for (const a of artifacts.values()) console.log(`  ${a}`);
