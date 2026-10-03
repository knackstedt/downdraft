// ============================================================================
// package-mobile.mjs — package a game's native entry into an Android APK.
//
//   bun packages/cli/scripts/package-mobile.mjs [--abi=arm64-v8a|x86_64|all]
//     [--mode=dev|prod] [--app-id=<id>] [--app-name=<name>] [--version=<v>]
//     [--min-sdk=30] [--install] [--launch] [--mcp] <entry.ts> <out.apk>
//
// Produces a genuinely native APK — no WebView, no Capacitor:
//   lib/<abi>/libdowndraft_android.so   shell (winit loop + shim ABI exports)
//   lib/<abi>/libnode.so              embedded Node (packages/node-mobile)
//   lib/<abi>/libdowndraft_*.so       optional engine cdylibs
//   assets/bundle/index.js            ESM entry shim
//   assets/bundle/<repo-rel>/*.mjs    bundled game + worker modules
//   assets/bundle/node_modules/koffi (+ @koromix/koffi-android-*)  FFI
//   assets/bundle/dd-assets/          ?url/new URL/import.meta.glob payloads
//   assets/bundle/manifest.txt        extraction manifest for the shell
//
// Runtime contract (must match packages/android-shell/src/lib.rs):
//   shell extracts assets/bundle/ → internalDataPath/bundle/, sets
//   DOWNDRAFT_BUNDLE_DIR to that dir, then node::Start("index.js").
//   import.meta.dir/.url rewrites resolve under $DOWNDRAFT_BUNDLE_DIR/
//   dd-assets/…; Worker() spawns resolve real extracted files.
//
// APK assembly uses Android build-tools directly (aapt2 → zip jniLibs →
// zipalign → apksigner debug sign) — the app is hasCode=false so no dex or
// Gradle is required. packages/android-shell/gradle/ is the equivalent
// Android Studio skeleton.
//
// Mirrors the bundling rules in package-native.mjs — keep the regexes and
// rewrite semantics in sync.
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
    readdirSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── args ──

const argv = process.argv.slice(2);
const flagValue = (name) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const abiArg = flagValue("abi") ?? "arm64-v8a";
const modeArg = flagValue("mode") ?? "prod";
const doInstall = argv.includes("--install") || argv.includes("--launch");
const doLaunch = argv.includes("--launch");
const retainMcp = argv.includes("--mcp");
const minSdk = flagValue("min-sdk") ?? "30";
// --env KEY=VALUE (repeatable) → dd-env.txt in the bundle; the shell
// setenv()s each before node::Start so process.env sees them.
const envPairs = argv.filter((a) => a.startsWith("--env=")).map((a) => a.slice(6));
const positional = argv.filter((a) => !a.startsWith("--"));
const [entry, outfileArg] = positional;
if (!entry || !outfileArg) {
  console.error("usage: bun package-mobile.mjs [--abi=...] [--mode=...] [--app-id=...] [--app-name=...] [--version=...] [--env KEY=VAL]... [--install|--launch] [--mcp] <entry.ts> <out.apk>");
  process.exit(1);
}

const ABIS = { "arm64-v8a": "aarch64-linux-android", "x86_64": "x86_64-linux-android" };
const KOFFI_PKGS = { "arm64-v8a": "@koromix/koffi-android-arm64", "x86_64": "@koromix/koffi-android-x64" };
const abis = abiArg === "all" ? Object.keys(ABIS) : abiArg.split(",").map((s) => s.trim());
for (const a of abis) {
  if (!ABIS[a]) throw new Error(`unknown --abi "${a}" — expected: ${Object.keys(ABIS).join(", ")}, all`);
}

const repoRoot = process.cwd();
const scriptDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(scriptDir, "../../..");
const gameDir = dirname(dirname(resolve(entry)));

// Branding: flags → game package.json → defaults.
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(gameDir, "package.json"), "utf-8")); } catch { /* standalone */ }
const titleize = (s) => String(s).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
// Android package ids must be dot-separated Java identifiers — hyphens are
// rejected by aapt2 ("not a valid Android package name").
const sanitizeAppId = (id) =>
  id.split(".").map((seg) => {
    let s = seg.replace(/[^a-zA-Z0-9_]/g, "_");
    if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
    return s;
  }).join(".");
const rawAppId = flagValue("app-id") ?? pkg.build?.appId ?? `com.downdraft.${basename(gameDir).replace(/[^a-zA-Z0-9]/g, "")}`;
const appId = sanitizeAppId(rawAppId);
if (appId !== rawAppId) console.warn(`[package-mobile] app-id "${rawAppId}" sanitized → "${appId}"`);
const appName = flagValue("app-name") ?? pkg.productName ?? pkg.build?.productName ?? titleize(pkg.name ?? basename(gameDir));
const versionName = flagValue("version") ?? pkg.version ?? "0.0.1";
const verParts = (versionName.match(/\d+/g) ?? ["0"]).map(Number);
const versionCode = Math.max(1, (verParts[0] ?? 0) * 10000 + (verParts[1] ?? 0) * 100 + (verParts[2] ?? 0));

// ── Android SDK / build-tools discovery ──

const sdkRoot =
  process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ??
  join(process.env.HOME ?? "", "Android/Sdk");
if (!existsSync(sdkRoot)) throw new Error("Android SDK not found — set ANDROID_HOME");
const btRoot = join(sdkRoot, "build-tools");
const btVer = readdirSync(btRoot).sort().pop();
const bt = join(btRoot, btVer);
const platformDir = readdirSync(join(sdkRoot, "platforms")).sort().pop();
const androidJar = join(sdkRoot, "platforms", platformDir, "android.jar");
for (const tool of ["aapt2", "zipalign", "apksigner"]) {
  if (!existsSync(join(bt, tool))) throw new Error(`missing build-tool ${tool} in ${bt}`);
}
const adb = join(sdkRoot, "platform-tools", "adb");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]}… failed (exit ${r.status})`);
  return r;
};

// ── Bundle (mirrors package-native.mjs rules; paths rebase to the
//    extracted bundle dir via DOWNDRAFT_BUNDLE_DIR) ──

const QUERY_RE = /\?(raw|url|json)$/;
const WORKER_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
// Rewrite variant — additionally consumes new URL's closing paren so the
// Worker's own arg list (options object, close paren) stays balanced.
const WORKER_URL_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)\s*(?:\.href|\.toString\(\s*\))?\s*/g;
const ASSET_URL_RE = /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_META = /(?:\(\s*import\.meta\s+as\s+any\s*\)|import\.meta(?:\s+as\s+any)?)/;
const GLOB_RE = new RegExp(IMPORT_META.source + String.raw`\.glob\(\s*(["'\`])([^"'\`]+)\1`, "g");
// Full eager call — captured so module globs can be expanded into static
// imports at package time. The FS glob shim returns file:// URLs only;
// an eager module glob's side effects (e.g. registerTest()) can never
// run through it — the modules must be bundled and evaluated.
const GLOB_EAGER_RE = new RegExp(
  IMPORT_META.source + String.raw`\.glob\(\s*(["'\`])([^"'\`]+)\1\s*,\s*(\{[^)]*\beager\s*:\s*true[^)]*\})\s*\)`, "g");
const STAGE_GLOB_RE = new RegExp(
  `(?:${IMPORT_META.source}\\.glob|_glob)\\(\\s*(["'\`])([^"'\`]+)\\1|createGlob\\([^)]*\\)\\(\\s*(["'\`])([^"'\`]+)\\3`, "g");
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
 *  `[dir]` naming escapes out-of-root `..` segments as `_.._` — the staged
 *  tree contains `_.._/_.._/packages/...`, so emit the same encoding or
 *  spawned Worker paths resolve outside the extracted bundle. */
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
  for (const e of entries) {
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

const makePlugin = (collectWorkers) => ({
  name: "downdraft-mobile-build",
  setup(build) {
    const resolveImport = (spec, importer) => {
      const base = spec.startsWith(".") || spec.startsWith("/")
        ? resolve(dirname(importer), spec)
        : Bun.resolveSync(spec, dirname(importer));
      return existsSync(base) ? base : (existsSync(`${base}.ts`) ? `${base}.ts` : base);
    };
    build.onResolve({ filter: /\?(raw|url|json)$/ }, (args) => {
      const clean = args.path.replace(QUERY_RE, "");
      const kind = args.path.match(QUERY_RE)[1];
      const resolved = resolveImport(clean, args.importer);
      if (resolved.endsWith(".ts")) return { path: resolved };
      return { path: resolved, namespace: `dd-${kind}` };
    });
    build.onLoad({ filter: /.*/, namespace: "dd-raw" }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, "utf-8"))};`,
      loader: "js",
    }));
    build.onLoad({ filter: /.*/, namespace: "dd-json" }, (args) => ({
      contents: `export default ${JSON.stringify(JSON.parse(readFileSync(args.path, "utf-8")))};`,
      loader: "js",
    }));
    build.onLoad({ filter: /.*/, namespace: "dd-url" }, (args) => {
      assetFiles.add(args.path);
      if (collectWorkers) {
        return { contents: `export default ${JSON.stringify(args.path)};`, loader: "js" };
      }
      const rel = assetRel(args.path);
      return {
        contents:
          `import { pathToFileURL as __ddP2F } from "node:url";` +
          `export default __ddP2F(process.env.DOWNDRAFT_BUNDLE_DIR + "/dd-assets/" + ${JSON.stringify(rel)}).href;`,
        loader: "js",
      };
    });
    ["wgsl", "glsl"].forEach((ext) => {
      build.onResolve({ filter: new RegExp(`\\.${ext}$`) }, (args) => {
        const resolved = resolveImport(args.path, args.importer);
        if (resolved.endsWith(".ts")) return { path: resolved };
        return { path: resolved, namespace: "dd-raw" };
      });
    });
    build.onResolve({ filter: /\.css$/ }, (args) => {
      if (args.path.startsWith("dd-css:")) {
        return { path: args.path.slice("dd-css:".length), namespace: "dd-css" };
      }
      let path;
      try { path = resolveImport(args.path, args.importer); }
      catch { path = resolve(dirname(args.importer), args.path); }
      return { path, namespace: "dd-css" };
    });
    build.onLoad({ filter: /.*/, namespace: "dd-css" }, () => ({
      contents: `export default "";`, loader: "js",
    }));
    build.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
      const src = readFileSync(args.path, "utf-8");
      const modDir = dirname(args.path);
      const modRel = assetRel(args.path);
      const modBase = basename(modRel).replace(/\.[jt]sx?$/, ".js");
      const stagedDir = dirname(modRel);

      for (const m of src.matchAll(WORKER_RE)) {
        const p = resolve(modDir, m[1]);
        if (existsSync(p)) workerEntries.add(p);
      }
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

      // 0. Eager module globs (no `query:`) → static imports generated
      //    at package time. The FS glob shim returns file:// URLs — it
      //    can't execute module side effects — so an eager glob's
      //    registrations (registerTest(), etc.) must run inside the
      //    bundle. Runs in the scan pass too so the worker fixpoint
      //    reaches workers declared by eagerly-globbed modules. Eager
      //    globs WITH `query:` resolve to asset payloads — the FS
      //      shim's file:// URLs are already the right value shape.
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
        console.log(`  eager glob ${pattern} → ${entries.length} module(s) [${relative(repoRoot, args.path)}]`);
        return name;
      });
      const prologue = eagerDecls.length ? eagerDecls.join("\n") + "\n" : "";

      if (collectWorkers) return prologue ? { contents: prologue + out, loader } : undefined;

      // 1. Worker URLs → absolute path inside the extracted bundle
      //    (worker_threads needs a real file on disk). WORKER_URL_RE eats
      //    new URL's close paren so a trailing `, { type: "module" })`
      //    remains Worker's second argument.
      out = out.replace(WORKER_URL_RE, (m, spec) => {
        const rel = bundlePath(resolve(modDir, spec));
        return `new Worker(process.env.DOWNDRAFT_BUNDLE_DIR + "/${rel}"`;
      });
      // 1.5 new URL("<asset>", import.meta.url) → absolute file URL into the
      //     staged dd-assets tree. assetRel() gives the TARGET's own staged
      //     dir — resolving the spec textually against __ddModUrl breaks when
      //     the target lives under a different hashed dir (repo-external
      //     sources stage at external/<sha1(dir)>/, so "../ffi/x.mjs" would
      //     escape into external/ffi/).
      out = out.replace(ASSET_URL_RE, (m, spec) => {
        const p = resolve(modDir, spec);
        if (!existsSync(p)) return m;
        return `new URL("file://" + process.env.DOWNDRAFT_BUNDLE_DIR + "/dd-assets/" + ${JSON.stringify(assetRel(p))})`;
      });
      // 2. Variable-specifier dynamic imports → bundled module path.
      for (const m of out.matchAll(DYN_IMPORT_RE)) {
        const ident = m[1];
        const info = dynImports.get(`${args.path}:${ident}`);
        if (!info) continue;
        const decl = new RegExp("((?:const|let|var)\\s+" + escapeRe(ident) + "\\s*=\\s*)([\"'`])" + escapeRe(info.spec) + "\\2");
        out = out.replace(decl, `$1$2@@DD_BUNDLE@@/${bundlePath(info.abs)}$2`);
      }
      // 3. import.meta.glob → createGlob bound to the staged dir.
      out = out.replace(GLOB_RE, (m) => { needsGlob = true; return m.replace(GLOB_CALLEE_RE, "__ddGlob"); });
      if (REQUIRE_GLOB_RE.test(out)) {
        needsGlob = true;
        out = out.replace(REQUIRE_GLOB_RE, "({ createGlob: __ddCreateGlob })");
      }
      // 4. import.meta.dir/.url/__dirname → module's staged dir under
      //    dd-assets (real FS after extraction).
      const metaOut = out
        .replace(META_DIR_RE, "__ddModDir")
        .replace(META_URL_RE, "__ddModUrl")
        .replace(/(?<![.\w$])__dirname\b/g, "__ddModDir");
      if (metaOut !== out || needsGlob) {
        out =
          `import { dirname as __ddDirname } from "node:path";\n` +
          `import { pathToFileURL as __ddP2F } from "node:url";\n` +
          `const __ddModDir = process.env.DOWNDRAFT_BUNDLE_DIR + "/dd-assets/" + ${JSON.stringify(stagedDir === "." ? "" : stagedDir + "/")}.replace(/\\/$/, "");\n` +
          `const __ddModUrl = __ddP2F(__ddModDir + "/" + ${JSON.stringify(modBase)}).href;\n` +
          (needsGlob
            ? `import { createGlob as __ddCreateGlob } from "@downdraft/engine/platform/glob-polyfill";\n` +
              `const __ddGlob = __ddCreateGlob(__ddModDir);\n`
            : "") +
          metaOut;
      }
      // @@DD_BUNDLE@@ sentinel → env path (post meta rewrite so META_URL
      // doesn't touch it).
      out = out.replaceAll("@@DD_BUNDLE@@", `" + process.env.DOWNDRAFT_BUNDLE_DIR + "`);
      if (prologue) out = prologue + out;
      return out === src ? undefined : { contents: out, loader };
    });
  },
});

const stageRoot = mkdtempSync(join(tmpdir(), "dd-android-"));
const bundleDir = join(stageRoot, "assets", "bundle");
mkdirSync(bundleDir, { recursive: true });

// Pass 1: discover worker entrypoints to a fixpoint.
const scanOutdir = mkdtempSync(join(tmpdir(), "dd-scan-"));
let prevCount = -1;
while (workerEntries.size !== prevCount) {
  prevCount = workerEntries.size;
  const scan = await Bun.build({
    entrypoints: [resolve(entry), ...workerEntries],
    target: "node",
    plugins: [makePlugin(true)],
    splitting: false,
    sourcemap: "none",
    minify: false,
    define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
    outdir: scanOutdir,
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

const build = await Bun.build({
  entrypoints,
  // No `compile` — libnode executes the extracted ESM files.
  target: "node",
  root: repoRoot,
  naming: { entry: "[dir]/[name].mjs" },
  plugins: [makePlugin(false)],
  splitting: false,
  sourcemap: "none",
  minify: modeArg === "prod",
  define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
  external: ["koffi", "bun:ffi", "bun:test", "bun"],
  outdir: bundleDir,
});
if (!build.success) {
  build.logs.forEach((msg) => { console.error(msg); });
  process.exit(1);
}

// Entry shim: the shell always runs bundle/index.js (CJS-safe dynamic
// import — no type:module package.json needed for the .mjs outputs).
const entryRel = bundlePath(resolve(entry));
writeFileSync(join(bundleDir, "index.js"),
  `await import("./${entryRel}");\n`);
writeFileSync(join(bundleDir, "package.json"), JSON.stringify({ type: "module" }) + "\n");

// ── node_modules: koffi + the ABI-matched @koromix/koffi-android-* prebuild ──

const { createRequire } = await import("node:module");
const gameRequire = createRequire(resolve(entry));
// koffi's exports map doesn't expose ./package.json — resolve the entry.
let koffiRoot = null;
try { koffiRoot = dirname(gameRequire.resolve("koffi")); } catch { /* not resolvable */ }
if (!koffiRoot) {
  console.warn("[package-mobile] koffi not resolvable — FFI will fail at runtime");
} else {
  const nm = join(bundleDir, "node_modules");
  cpSync(koffiRoot, join(nm, "koffi"), { recursive: true });
  const koffiVer = JSON.parse(readFileSync(join(koffiRoot, "package.json"), "utf-8")).version;
  for (const abi of abis) {
    const pkgName = KOFFI_PKGS[abi];
    // The @koromix prebuild pkgs carry no importable entry — probe the dir
    // beside koffi (same layout koffi's loader expects), else fetch npm.
    let src = join(dirname(koffiRoot), pkgName);
    if (!existsSync(join(src, "package.json"))) src = null;
    if (!src) {
      const fetched = await fetchKoffiPrebuild(pkgName, koffiVer);
      src = fetched;
    }
    if (!src) {
      console.warn(`[package-mobile] ${pkgName}@${koffiVer} unavailable — FFI will fail on ${abi}`);
      continue;
    }
    cpSync(src, join(nm, "@koromix", basename(pkgName)), { recursive: true });
  }
}

/** Fetch @koromix/koffi-android-<abi>@<ver> from the npm registry → temp dir. */
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
    console.warn(`[package-mobile] koffi prebuild fetch failed: ${e?.message ?? e}`);
    return null;
  }
}

// Follow relative imports inside staged script assets — execArgv loader
// files (wgsl-loader.mjs, worker-bootstrap.mjs) are staged raw, not
// bundled, so their own module deps never enter the graph otherwise.
{
  const ASSET_IMPORT_RE = /(?:from|import|register)\s*\(?\s*(["'`])(\.[^"'`]+)\1/g;
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of [...assetFiles]) {
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

// ── dd-assets staging ──

const assetRoot = join(bundleDir, "dd-assets");
let stagedAssets = 0;
for (const f of assetFiles.values()) {
  const dest = join(assetRoot, assetRel(f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  stagedAssets++;
}

// dd-env.txt — optional process env for the JS thread (debug probes like
// DD_BENCH_TEST; Android has no launch-env channel).
if (envPairs.length) {
  for (const p of envPairs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) {
      throw new Error(`--env "${p}" must be KEY=VALUE (KEY: [A-Za-z_][A-Za-z0-9_]*)`);
    }
  }
  writeFileSync(join(bundleDir, "dd-env.txt"), envPairs.join("\n") + "\n");
}

// manifest.txt — the shell's extractor follows this verbatim (AAssetDir
// can't enumerate subdirectories). aapt2 silently drops asset paths with
// dot-prefixed segments (.bun, .gitignore), so each line is
// "asset_path\tdest_path": dot-segments are staged as "_<rest>" while the
// extractor restores the verbatim destination path.
function aaptSafePath(rel) {
  return rel.split("/").map((s) => (s.startsWith(".") ? `_${s.slice(1)}` : s)).join("/");
}
{
  const seen = new Map();
  const lines = walkDir(bundleDir).map((f) => {
    const dest = relative(bundleDir, f).replace(/\\/g, "/");
    const asset = aaptSafePath(dest);
    const prev = seen.get(asset);
    if (prev && prev !== dest) throw new Error(`asset-path collision: "${dest}" vs "${prev}"`);
    seen.set(asset, dest);
    if (asset !== dest) {
      const target = join(bundleDir, asset);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(f, target);
    }
    return `${asset}\t${dest}`;
  });
  lines.push("manifest.txt\tmanifest.txt");
  writeFileSync(join(bundleDir, "manifest.txt"), lines.sort().join("\n") + "\n");
}

// ── Native libs ──

const nativeStage = join(stageRoot, "lib");
for (const abi of abis) {
  const triple = ABIS[abi];
  const libDir = join(nativeStage, abi);
  mkdirSync(libDir, { recursive: true });

  // libnode.so — node-mobile build tree or npm platform package. Resolved
  // BEFORE build-native: the shell crate links against it (DT_NEEDED) via
  // DOWNDRAFT_LIBNODE_DIR.
  const libnodeCandidates = [
    join(monorepoRoot, "packages/node-mobile/build/dist/android", abi, "libnode.so"),
    join(monorepoRoot, `packages/node-mobile-android-${abi.startsWith("arm64") ? "arm64" : "x64"}/lib/libnode.so`),
  ];
  let libnode = libnodeCandidates.find(existsSync);
  if (!libnode) {
    try { libnode = join(dirname(gameRequire.resolve(`@downdraft/node-mobile-android-${abi.startsWith("arm64") ? "arm64" : "x64"}/package.json`)), "lib/libnode.so"); } catch { /* absent */ }
  }
  if (!libnode || !existsSync(libnode)) {
    throw new Error(`libnode.so for ${abi} not found — build via packages/node-mobile/scripts/build-android.mjs`);
  }

  // Ensure the engine crates are built for this target.
  run("node", [join(monorepoRoot, "scripts/build-native.mjs"), `--target=${triple}`, "--profile=release"], {
    cwd: monorepoRoot,
    env: { ...process.env, DOWNDRAFT_LIBNODE_DIR: dirname(libnode) },
  });

  // libdowndraft_android.so — the shell (platform statics inside).
  const shellSo = join(monorepoRoot, "packages/android-shell/dist", `android-${abi.startsWith("arm64") ? "arm64" : "x64"}`, "libdowndraft_android.so");
  if (!existsSync(shellSo)) throw new Error(`shell lib missing: ${shellSo}`);
  copyFileSync(shellSo, join(libDir, "libdowndraft_android.so"));

  copyFileSync(libnode, join(libDir, "libnode.so"));

  // libc++_shared.so — libnode.so NEEDs it (Rust crates static-link libc++
  // and don't). Prefer the sibling staged by build-android.mjs — it comes
  // from the same NDK that built libnode (a mismatched libc++ can lack
  // symbols libnode references). Fall back to the NDK sysroot lib dir.
  const cxxCandidates = [join(dirname(libnode), "libc++_shared.so")];
  const ndkRoot = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK ??
    readdirSync(join(sdkRoot, "ndk")).map((v) => join(sdkRoot, "ndk", v))
      .filter((d) => existsSync(join(d, "toolchains"))).sort().pop();
  if (ndkRoot) {
    cxxCandidates.push(join(ndkRoot,
      "toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib", triple, "libc++_shared.so"));
  }
  const cxxShared = cxxCandidates.find(existsSync);
  if (cxxShared) {
    copyFileSync(cxxShared, join(libDir, "libc++_shared.so"));
  } else {
    console.warn("[package-mobile] libc++_shared.so not found — libnode will fail to load");
  }

  // Optional engine cdylibs — whatever build-native.mjs staged for this
  // platform key; JS resolves them by soname via the app lib dir.
  const crates = await import(fileURLToPath(new URL("../../../scripts/native-crates.mjs", import.meta.url)));
  const nodePlat = `android-${abi.startsWith("arm64") ? "arm64" : "x64"}`;
  for (const crate of crates.CRATES) {
    if (crate.androidOnly || crate.noAndroid) continue;
    const file = `lib${crate.lib}.so`;
    const src = join(monorepoRoot, crate.dest, nodePlat, file);
    if (existsSync(src)) copyFileSync(src, join(libDir, file));
  }
}

// ── APK assembly ──

const manifestTpl = readFileSync(join(monorepoRoot, "packages/android-shell/AndroidManifest.xml"), "utf-8");
const manifest = manifestTpl
  .replaceAll("@APP_ID@", appId)
  .replaceAll("@APP_NAME@", appName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"))
  .replaceAll("@VERSION_CODE@", String(versionCode))
  .replaceAll("@VERSION_NAME@", versionName.replaceAll("&", "&amp;").replaceAll("<", "&lt;"))
  .replaceAll("@MIN_SDK@", minSdk)
  .replaceAll("@DEBUGGABLE@", modeArg === "dev" ? "true" : "false");
writeFileSync(join(stageRoot, "AndroidManifest.xml"), manifest);

const unsigned = join(stageRoot, "unsigned.apk");
const aligned = join(stageRoot, "aligned.apk");
const outfile = resolve(outfileArg);

run(join(bt, "aapt2"), [
  "link", "-o", unsigned,
  "-I", androidJar,
  "--manifest", join(stageRoot, "AndroidManifest.xml"),
  "-A", join(stageRoot, "assets"),
  "--auto-add-overlay",
]);

// jniLibs → lib/<abi>/*.so inside the APK (extractNativeLibs=true allows
// compressed storage — plain zip is correct here).
run("zip", ["-qr", unsigned, "lib"], { cwd: stageRoot });
run(join(bt, "zipalign"), ["-f", "-p", "4", unsigned, aligned]);

// Sign with the standard Android debug key unless a keystore is provided.
const keystore = flagValue("keystore") ?? join(process.env.HOME ?? "", ".android/debug.keystore");
const ksPass = flagValue("keystore-pass") ?? "android";
const ksAlias = flagValue("keystore-alias") ?? "androiddebugkey";
if (!existsSync(keystore)) {
  console.log("[package-mobile] no debug keystore — generating one");
  mkdirSync(dirname(keystore), { recursive: true });
  run("keytool", [
    "-genkeypair", "-v", "-keystore", keystore,
    "-storepass", ksPass, "-alias", ksAlias, "-keypass", ksPass,
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
    "-dname", "CN=Android Debug,O=Downdraft,C=US",
  ]);
}
mkdirSync(dirname(outfile), { recursive: true });
run(join(bt, "apksigner"), [
  "sign", "--ks", keystore, "--ks-pass", `pass:${ksPass}`,
  "--ks-key-alias", ksAlias, "--key-pass", `pass:${ksPass}`,
  "--out", outfile, aligned,
]);

console.log(`\n[package-mobile] ${outfile}`);
console.log(`  app:    ${appName} (${appId}) v${versionName} (${versionCode})`);
console.log(`  abis:   ${abis.join(", ")}`);
console.log(`  bundle: ${entrypoints.length} entries, ${stagedAssets} assets`);

// ── install / launch ──

if (doInstall) {
  run(adb, ["install", "-r", outfile]);
}
if (doLaunch) {
  run(adb, ["shell", "am", "start", "-n", `${appId}/android.app.NativeActivity`]);
  console.log(`[package-mobile] launched — logs: adb logcat -s downdraft:D`);
}
