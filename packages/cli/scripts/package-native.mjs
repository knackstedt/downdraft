// ============================================================================
// package-native.mjs — compile a game's native entry into a standalone Bun
// binary plus a staged runtime tree:
//
//   bun packages/cli/scripts/package-native.mjs games/mining-rpg/src/native-entry.ts /tmp/out/mining
//   bun scripts/package-native.mjs --mcp <entry> <outfile>   # retain the MCP endpoint
//   --target=win|linux|mac   cross-compile (default: host)
//   --mode=dev|debug|prod    prod minifies (default: prod)
//   --product-name=<name>    PE/branding product name (win target)
//   --product-version=<v>    PE/branding version (win target)
//   --icon=<path>            .ico/.png icon to stamp (win target)
//
// By default the in-process MCP automation endpoint is compiled OUT of
// packaged binaries (__DD_MCP_STRIP__ define → dead code). --mcp retains it:
// the endpoint still stays off at runtime unless DOWNDRAFT_MCP=1 is set
// (see native-host.ts).
//
// Produces:
//   <outfile>                    compiled binary
//   <outdir>/native/*.so         platform lib + engine cdylibs (dlopen'd)
//   <outdir>/dd-assets/<repo-rel>  ?url imports + glob-matched asset files
//
// The runtime Bun.plugin() loaders in bun-preload.ts handle ?raw/.wgsl/?url
// for `bun run`, but Bun.build resolves modules on disk first — query
// suffixes fail resolution before onLoad fires. This plugin mirrors those
// loaders with the build-time contract (onResolve strips the suffix, onLoad
// returns contents + a real loader).
//
// Packaging transforms (compile pass only):
//   - `new Worker(new URL("x.ts", import.meta.url))` — workers are embedded
//     as extra entrypoints; the specifier is rewritten to the module's
//     /$bunfs/root/<repo-rel>.js path so it resolves inside the binary.
//   - `new URL("asset.png", import.meta.url)` (non-script) — rewritten to a
//     file:// URL into the staged dd-assets tree.
//   - `import.meta.glob(...)` — rewritten to createGlob(<repo-rel-dir>),
//     which maps onto dd-assets in packaged builds.
//   - `import.meta.dir` / `.dirname` / `.url` — rewritten to the module's
//     /$bunfs/root/<repo-rel> path so glob/worker resolution behaves like
//     dev. (In compiled binaries every module reports import.meta.dir as
//     /$bunfs/root — the source directory must be baked in per module.)
// ============================================================================

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// CRATES is shared with the repo's scripts/native-crates.mjs when this file
// runs inside the monorepo. In a published @downdraft/cli install the repo
// scripts tree doesn't exist — fall back to the platform lib only (engine
// cdylibs are additionally probed inside the installed @downdraft/engine
// package below, so standalone packaging still finds them).
let CRATES = [];
let libFileName = (libName, nodePlat) =>
  nodePlat.startsWith("win32") ? `${libName}.dll`
    : nodePlat.startsWith("darwin") ? `lib${libName}.dylib` : `lib${libName}.so`;
try {
  ({ CRATES, libFileName } = await import(
    fileURLToPath(new URL("../../../scripts/native-crates.mjs", import.meta.url))));
} catch { /* published package — engine crates probed via node resolution */ }

const argv = process.argv.slice(2);
// --mcp retains the MCP automation endpoint in the packaged binary (still
// gated at runtime by DOWNDRAFT_MCP=1). Default: strip it.
const retainMcp = argv.includes("--mcp");
// --target=<win|linux|mac> selects the Bun compile target and the platform
// arch used for native-lib staging. Default: the host platform.
const targetArg = argv.find((a) => a.startsWith("--target="))?.split("=")[1];
// --mode=<dev|debug|prod> — prod minifies; dev/debug leave the bundle readable.
const modeArg = argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "prod";
// Branding flags — value may itself contain '=' so split on the first only.
const flagValue = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 2);
const productNameFlag = flagValue("product-name");
const productVersionFlag = flagValue("product-version");
const iconFlag = flagValue("icon");
const positional = argv.filter((a) => !a.startsWith("--"));
const [entry, outfileArg] = positional;
if (!entry || !outfileArg) {
  console.error("usage: bun package-native.mjs [--mcp] [--target=win|linux|mac] [--mode=dev|debug|prod] <entry.ts> <outfile>");
  process.exit(1);
}

// Target triple: release vocabulary (win|linux|mac) → bun compile target +
// node <platform>-<arch> key used for native lib staging. mac targets Apple
// Silicon by default (the dominant desktop arch); win/linux target x64.
const TARGETS = {
  win:   { plat: "win32-x64",    bun: "bun-windows-x64", exe: true },
  linux: { plat: "linux-x64",    bun: "bun-linux-x64",   exe: false },
  mac:   { plat: "darwin-arm64", bun: "bun-darwin-arm64", exe: false },
};
const hostKey = `${process.platform}-${process.arch}`;
if (targetArg && !TARGETS[targetArg]) {
  console.error(`unknown --target "${targetArg}" — expected win, linux, or mac`);
  process.exit(1);
}
const target = targetArg ? TARGETS[targetArg] : { plat: hostKey, bun: undefined, exe: process.platform === "win32" };
let outfile = outfileArg;
if (target.exe && !outfile.endsWith(".exe")) outfile += ".exe";

const repoRoot = process.cwd();
const QUERY_RE = /\?(raw|url|json)$/;
const WORKER_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
const ASSET_URL_RE = /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;
// import.meta is frequently written as `(import.meta as any)` in this
// codebase — both the bare and parenthesized forms must match.
const IMPORT_META = /(?:\(\s*import\.meta\s+as\s+any\s*\)|import\.meta(?:\s+as\s+any)?)/;
const GLOB_RE = new RegExp(IMPORT_META.source + String.raw`\.glob\(\s*(["'\`])([^"'\`]+)\1`, "g");
// Staging scan covers all glob call forms: import.meta.glob("pat"), the
// common _glob("pat") alias, and createGlob(modDir)("pat").
const STAGE_GLOB_RE = new RegExp(
  `(?:${IMPORT_META.source}\\.glob|_glob)\\(\\s*(["'\`])([^"'\`]+)\\1|createGlob\\([^)]*\\)\\(\\s*(["'\`])([^"'\`]+)\\3`, "g");
// Module-relative file reads: resolve(__dirname, "./zstd.wasm"),
// join(import.meta.dir, "data.bin") — stage the referenced file.
const STAGE_READ_RE = new RegExp(
  String.raw`(?:resolve|join)\(\s*(?:__dirname|${IMPORT_META.source}\.(?:dir|dirname|url))\s*,\s*(["'\`])([^"'\`]+)\1`, "g");
const META_DIR_RE = new RegExp(IMPORT_META.source + String.raw`\.(?:dir|dirname)\b`, "g");
const META_URL_RE = new RegExp(IMPORT_META.source + String.raw`\.url\b`, "g");
// require("@downdraft/engine/platform/glob-polyfill") — a runtime package
// specifier can't resolve inside a compiled binary; rewrite to the
// injected __ddCreateGlob binding.
const REQUIRE_GLOB_RE = /require\(\s*["'`]@downdraft\/engine\/platform\/glob-polyfill["'`]\s*\)/g;
const GLOB_CALLEE_RE = new RegExp(IMPORT_META.source + String.raw`\.glob`);
const SCRIPT_EXT_RE = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/i;
const DYN_IMPORT_RE = /import\(\s*([a-zA-Z_$][\w$]*)\s*\)/g;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Resolve a module specifier to an absolute path (relative or bare). */
function resolveSpec(spec, importer) {
  try {
    return spec.startsWith(".") || spec.startsWith("/")
      ? resolve(dirname(importer), spec)
      : Bun.resolveSync(spec, dirname(importer));
  } catch { return null; }
}

/** repo-rel path of a module file as embedded in the binary (.js suffix). */
function bunfsPath(absPath) {
  return `/$bunfs/root/${relative(repoRoot, absPath).replace(/\\/g, "/").replace(/\.[jt]sx?$/, ".js")}`;
}

// Worker files referenced via `new Worker(new URL("...", import.meta.url))`
// must be passed as extra entrypoints — Bun bundles each one separately into
// the binary. Discovered by scanning every module that enters the graph.
const workerEntries = new Set();

// Dynamic imports with a variable specifier (`const spec = "..."; import(spec)`)
// are invisible to the bundler — used to keep platform-native out of browser
// bundles. In packaged binaries they can only resolve to /$bunfs paths of
// modules embedded as extra entrypoints, so we resolve the bound literal,
// embed it, and rewrite the specifier. Keyed by `<file>:<ident>` → spec info.
const dynImports = new Map();

// Files staged under <outdir>/dd-assets/<rel>: ?url imports, asset
// new URL(...) refs, and import.meta.glob matches.
const assetFiles = new Set();

/** Repo-relative staging path for an absolute file path. */
function assetRel(absPath) {
  const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
  if (!rel.startsWith("..")) return rel;
  // Outside the repo (e.g. standalone node_modules) — hash the DIRECTORY so
  // that a module's baked dirname and its sibling assets land together.
  const h = createHash("sha1").update(dirname(absPath)).digest("hex").slice(0, 8);
  return `external/${h}/${basename(absPath)}`;
}

function walkDir(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const e = _it[_i];
    const full = `${dir}/${e}`;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkDir(full, results);
    else results.push(full);
  }
  return results;
}

const makePlugin = (collectWorkers) => ({
  name: "downdraft-native-build",
  setup(build) {
    const resolveImport = (spec, importer) => {
      // Relative → join on the importer; bare specifiers → Bun's resolver
      // (workspace package specifiers like @downdraft/engine/... need it).
      const base = spec.startsWith(".") || spec.startsWith("/")
        ? resolve(dirname(importer), spec)
        : Bun.resolveSync(spec, dirname(importer));
      // Engine convention: `./x.wgsl` may resolve to a TS module `x.wgsl.ts`.
      return existsSync(base) ? base : (existsSync(`${base}.ts`) ? `${base}.ts` : base);
    };
    // Strip ?raw / ?url / ?json so the bundler resolves the real file.
    build.onResolve({ filter: /\?(raw|url|json)$/ }, (args) => {
      const clean = args.path.replace(QUERY_RE, "");
      const kind = args.path.match(QUERY_RE)[1];
      const resolved = resolveImport(clean, args.importer);
      // Engine convention: `./x.wgsl` may resolve to a TS module x.wgsl.ts —
      // those are real TS modules, so leave them in the default namespace.
      if (resolved.endsWith(".ts")) return { path: resolved };
      return { path: resolved, namespace: `dd-${kind}` };
    });
    // ?raw / bare .wgsl/.glsl → text default export (matches bun-preload).
    build.onLoad({ filter: /.*/, namespace: "dd-raw" }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, "utf-8"))};`,
      loader: "js",
    }));
    // ?json → parse at build time, embed as a JS literal.
    build.onLoad({ filter: /.*/, namespace: "dd-json" }, (args) => ({
      contents: `export default ${JSON.stringify(JSON.parse(readFileSync(args.path, "utf-8")))};`,
      loader: "js",
    }));
    // ?url → file:// URL into the staged dd-assets tree (packaged) or the
    // absolute path (scan pass — keeps dev-mode parity for non-compiled use).
    build.onLoad({ filter: /.*/, namespace: "dd-url" }, (args) => {
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
    // Bare .wgsl/.glsl imports (no ?raw suffix) → text default export.
    ["wgsl", "glsl"].forEach((ext) => {
      build.onResolve({ filter: new RegExp(`\\.${ext}$`) }, (args) => {
        const resolved = resolveImport(args.path, args.importer);
        if (resolved.endsWith(".ts")) return { path: resolved };
        return { path: resolved, namespace: "dd-raw" };
      });
    });
    // CSS — no DOM in native mode; discard like the runtime loader does.
    // Resolve to an absolute path — a relative namespaced path can be
    // re-serialized as "dd-css:./x.css" and rejected as a bogus package.
    // Unresolvable package-rooted CSS (exports-map-hidden) still stubs out.
    build.onResolve({ filter: /\.css$/ }, (args) => {
      // A re-serialized "dd-css:<path>" specifier (Bun transpile cache replay)
      // must be returned unchanged — resolving it as a package/relative path
      // wraps it in another "dd-css:<dir>" layer each pass until ENAMETOOLONG.
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
    // Scan every real source file for Worker entrypoints, asset refs, and
    // glob patterns. In the compile pass, rewrite module-local paths:
    // inside a compiled binary import.meta flattens to /$bunfs/root, so
    // each module's original repo-relative location is baked in.
    build.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
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
        if (SCRIPT_EXT_RE.test(m[1])) continue;
        const p = resolve(modDir, m[1]);
        if (existsSync(p) && statSync(p).isFile()) assetFiles.add(p);
      }
      // Dynamic imports through variable specifiers: `const s = "spec";
      // await import(s)`. The bundler can't see them — resolve the bound
      // literal, embed the module, and rewrite the specifier to its
      // /$bunfs path in the compile pass.
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

      // Module-relative file reads — stage so the baked dirname resolves.
      for (const m of src.matchAll(STAGE_READ_RE)) {
        if (SCRIPT_EXT_RE.test(m[2])) continue;
        const p = resolve(modDir, m[2]);
        if (existsSync(p) && statSync(p).isFile()) assetFiles.add(p);
      }
      // Glob patterns — stage the entire subtree under the pattern's
      // static prefix. Matched files routinely reference siblings the
      // glob doesn't cover (GLB → ../Textures/x.png, mod.json →
      // shaders/*.wgsl), so the whole asset root must ship. Covers
      // import.meta.glob (rewritten below), the _glob alias, and
      // createGlob(modDir)(...) — the latter two resolve through
      // import.meta.dir/__dirname, fixed by the baked-dir rewrite.
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

      if (collectWorkers) return undefined;

      let out = src;
      // 1. Worker URLs first — before import.meta.url is rewritten.
      out = out.replace(WORKER_RE, (m, spec) => {
        const rel = relative(repoRoot, resolve(modDir, spec))
          .replace(/\\/g, "/").replace(/\.[jt]sx?$/, ".js");
        return m.replace(`"${spec}"`, `"/$bunfs/root/${rel}"`)
          .replace(`'${spec}'`, `"/$bunfs/root/${rel}"`)
          .replace(`\`${spec}\``, `"/$bunfs/root/${rel}"`);
      });
      // 2. Asset URL refs need no rewrite — import.meta.url already points
      // at the staged dd-assets dir, so new URL("./x.png", import.meta.url)
      // resolves there on its own.
      // 2b. Variable-specifier dynamic imports → embedded $bunfs path.
      for (const m of out.matchAll(DYN_IMPORT_RE)) {
        const ident = m[1];
        const info = dynImports.get(`${args.path}:${ident}`);
        if (!info) continue;
        const decl = new RegExp("((?:const|let|var)\\s+" + escapeRe(ident) + "\\s*=\\s*)([\"'`])" + escapeRe(info.spec) + "\\2");
        out = out.replace(decl, `$1$2${bunfsPath(info.abs)}$2`);
      }

      // 3. import.meta.glob → createGlob bound to the module's staged dir.
      let needsGlob = false;
      out = out.replace(GLOB_RE, (m) => { needsGlob = true; return m.replace(GLOB_CALLEE_RE, "__ddGlob"); });
      // 3b. require() of the glob-polyfill package — unresolvable inside a
      // compiled binary; swap in the injected import binding.
      if (REQUIRE_GLOB_RE.test(out)) {
        needsGlob = true;
        out = out.replace(REQUIRE_GLOB_RE, "({ createGlob: __ddCreateGlob })");
      }
      // 4. import.meta.dir / .url / bare __dirname → the module's location
      // inside the staged dd-assets tree (real FS — sibling asset reads,
      // glob enumeration, and wasm/binary loads all resolve there).
      // Bun flattens all of these to /$bunfs/root in compiled binaries.
      // Apply unconditionally — a file that only reads import.meta.url for
      // a `new URL("./x.png", ...)` still needs the rewrite even though no
      // earlier step changed its source.
      const metaOut = out
        .replace(META_DIR_RE, "__ddModDir")
        .replace(META_URL_RE, "__ddModUrl")
        .replace(/(?<![.\w$])__dirname\b/g, "__ddModDir");
      if (metaOut !== out || needsGlob) {
        out =
          `import { dirname as __ddDirname } from "node:path";\n` +
          `import { pathToFileURL as __ddP2F } from "node:url";\n` +
          `const __ddModDir = __ddDirname(process.execPath) + "/dd-assets/" + ${JSON.stringify(stagedDir === "." ? "" : stagedDir + "/")}.replace(/\\/$/, "");\n` +
          `const __ddModUrl = __ddP2F(__ddModDir + "/" + ${JSON.stringify(modBase)}).href;\n` +
          (needsGlob
            ? `import { createGlob as __ddCreateGlob } from "@downdraft/engine/platform/glob-polyfill";\n` +
              // Lazy — eager construction runs at module-init time and can
              // hit a TDZ on consts declared later in the same module
              // (glob-polyfill.ts itself matches REQUIRE_GLOB_RE via a
              // comment).
              `const __ddGlob = (p, o) => __ddCreateGlob(__ddModDir)(p, o);\n`
            : "") +
          metaOut;
      }
      const loader = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mts: "ts", mjs: "js" }[args.path.split(".").pop()] || "ts";
      return out === src ? undefined : { contents: out, loader };
    });
  },
});

const scanOutdir = mkdtempSync(join(tmpdir(), "dd-scan-"));

// Pass 1: bundle without compile to discover Worker entrypoints. Worker
// files enter the module graph only once listed as entrypoints, so loop to
// a fixpoint — this also discovers workers spawned by workers and dynamic
// imports reachable only inside worker bundles.
let prevCount = -1;
while (workerEntries.size !== prevCount) {
  prevCount = workerEntries.size;
  const scan = await Bun.build({
    entrypoints: [resolve(entry), ...workerEntries],
    target: "bun",
    plugins: [makePlugin(true)],
    splitting: false,
    sourcemap: "none",
    minify: false,
    define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
    outdir: scanOutdir,
  });
  if (!scan.success) {
    scan.logs.forEach((msg) => { console.error(msg);; });
    process.exit(1);
  }
}

const entrypoints = [resolve(entry), ...workerEntries];
if (workerEntries.size) {
  console.log(`workers: ${[...workerEntries].map((p) => p.split("/").pop()).join(", ")}`);
}

const result = await Bun.build({
  entrypoints,
  compile: { outfile: resolve(outfile), ...(target.bun ? { target: target.bun } : {}) },
  target: "bun",
  plugins: [makePlugin(false)],
  splitting: false,
  sourcemap: "none",
  minify: modeArg === "prod",
  // Strip the MCP endpoint from distributed binaries unless --mcp was passed.
  define: retainMcp ? {} : { __DD_MCP_STRIP__: "true" },
  // koffi is the Node-only FFI fallback (dead under Bun); its native addon
  // can't bundle, and the import is guarded by runtime detection anyway.
  external: ["koffi"],
});

if (!result.success) {
  result.logs.forEach((msg) => { console.error(msg);; });
  process.exit(1);
}
result.outputs.forEach((out) => {
  console.log(`${out.kind.padEnd(18)} ${out.path} ${(out.size / 1024 / 1024).toFixed(1)}MB`);
});

// ── Windows PE branding ──
// Stamp version info + icon into the compiled .exe so it doesn't identify
// itself as "Bun runtime". resedit is pure JS — no wine/rcedit needed.
// Metadata precedence: --product-name/--product-version/--icon flags, then
// the game's package.json (productName / build.productName, version,
// build.icon or icon.ico|icon.png in the game dir), then the game name.
const gameDir = dirname(dirname(resolve(entry))); // src/native-entry.ts → game root
if (target.exe) {
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(gameDir, "package.json"), "utf-8")); } catch { /* standalone entry */ }
  const titleize = (s) => String(s).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const productName = productNameFlag ?? pkg.productName ?? pkg.build?.productName
    ?? titleize(pkg.name ?? basename(outfile, ".exe"));
  const version = productVersionFlag ?? pkg.version ?? "0.0.0";
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name ?? "DownDraft Engine";
  let iconPath = iconFlag
    ?? (pkg.build?.icon ? resolve(gameDir, pkg.build.icon) : undefined);
  if (!iconPath) {
    iconPath = ["icon.ico", "assets/icon.ico", "icon.png", "assets/icon.png"]
      .map((p) => join(gameDir, p)).find((p) => existsSync(p));
  }
  try {
    const ResEdit = await import("resedit");
    const exe = ResEdit.NtExecutable.from(readFileSync(resolve(outfile)));
    // Bun appends a `.bun` trailer section after `.reloc`, which
    // NtExecutableResource.from() rejects outright — it only tolerates
    // .reloc after .rsrc. Hide .bun from the order check; resources are
    // regenerated in place below (noGrow), so no section ever moves.
    const allSections = exe.getAllSections.bind(exe);
    let rsrcVa = -1;
    let reloc;
    for (const s of allSections()) {
      if (s.info.name === ".rsrc") rsrcVa = s.info.virtualAddress;
      if (s.info.name === ".reloc") reloc = s;
    }
    exe.getAllSections = () =>
      allSections().filter((s) => s === reloc || s.info.virtualAddress <= rsrcVa || rsrcVa < 0);
    const res = ResEdit.NtExecutableResource.from(exe);
    exe.getAllSections = allSections;
    const lang = { lang: 1033, codepage: 1200 };
    const vi = ResEdit.Resource.VersionInfo.createEmpty();
    // PE versions are numeric quads — strip any semver suffix/prefix.
    const verNum = (version.match(/\d+(?:\.\d+)*/) ?? ["0.0.0"])[0];
    vi.setFileVersion(verNum, lang.lang);
    vi.setProductVersion(verNum, lang.lang);
    vi.setStringValues(lang, {
      CompanyName: author,
      FileDescription: productName,
      FileVersion: version,
      InternalName: basename(outfile, ".exe"),
      OriginalFilename: basename(outfile),
      ProductName: productName,
      ProductVersion: version,
    }, /* addToAvailableLanguage */ true);
    // Replace Bun's stock version resource entirely — Windows reads the
    // first RT_VERSION it finds, so a leftover one can shadow ours.
    res.entries = res.entries.filter((e) => e.type !== 16);
    vi.outputToResourceEntries(res.entries);
    for (const e of res.entries.filter((e) => e.type === 16)) e.lang = lang.lang;

    if (iconPath && existsSync(iconPath)) {
      const iconBin = readFileSync(iconPath);
      let items;
      if (iconPath.endsWith(".ico")) {
        items = ResEdit.Data.IconFile.from(iconBin).icons;
      } else if (iconPath.endsWith(".png")) {
        // PNG-compressed icons are valid in PE resources (Vista+). Width and
        // height come from the IHDR chunk (bytes 16–24).
        const w = iconBin.readUInt32BE(16), h = iconBin.readUInt32BE(20);
        items = [new ResEdit.Data.RawIconItem(iconBin, w, h, 32)];
      }
      if (items?.length) {
        // Reuse an existing icon-group id when present (Bun embeds one);
        // otherwise allocate 101 — Windows picks the lowest group anyway.
        const existing = res.entries.filter((e) => e.type === 14); // RT_GROUP_ICON
        const groupId = existing.length ? existing[0].id : 101;
        ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
          res.entries, groupId, lang.lang, items);
      }
    } else {
      // No game icon — drop Bun's ~270KB stock icon (RT_ICON + its
      // RT_GROUP_ICON) so the version strings fit inside the existing .rsrc
      // under noGrow below. The exe falls back to the generic Windows icon,
      // which is better branding than shipping the Bun logo.
      res.entries = res.entries.filter((e) => e.type !== 3 && e.type !== 14);
    }

    // noGrow: fit inside the existing .rsrc — the new data must not push
    // .reloc/.bun because pe-library can't relocate arbitrary trailers.
    // Bun's stock .rsrc is ~270KB, ample for version strings + an icon.
    res.outputResource(exe, /* noGrow */ true);
    writeFileSync(resolve(outfile), Buffer.from(exe.generate()));
    console.log(`branding: ${productName} v${version}${iconPath ? ` + icon ${basename(iconPath)}` : ""}`);
  } catch (e) {
    // Cosmetic only — never fail the package over resource stamping.
    console.warn(`warning: PE branding skipped (${e?.message ?? e})`);
  }
}

// ── Stage runtime tree ──
const outdir = dirname(resolve(outfile));
const platKey = target.plat;
const libExt = platKey.startsWith("win32") ? ".dll" : platKey.startsWith("darwin") ? ".dylib" : ".so";

const nativeDir = join(outdir, "native");
mkdirSync(nativeDir, { recursive: true });

// Package resolution rooted at the game dir — works both inside the
// monorepo (workspace links) and in a standalone game repo (node_modules).
const gameRequire = createRequire(resolve(entry));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(scriptDir, "../../..");

function pkgRoot(name) {
  try { return dirname(gameRequire.resolve(`${name}/package.json`)); }
  catch { return null; }
}

// Platform lib — the unified libdowndraft_platform (Rust, statically links
// wgpu — no external deps) stages under native/<platform>-<arch>/. Probe
// order: monorepo dev staging, the installed platform-native package, the
// per-target @downdraft/native-<plat>-<arch> package.
const platLibCandidates = [...new Set([
  join(monorepoRoot, "packages/platform-native/native", platKey),
  pkgRoot("@downdraft/platform-native") && join(pkgRoot("@downdraft/platform-native"), "native", platKey),
  pkgRoot(`@downdraft/native-${platKey}`) && join(pkgRoot(`@downdraft/native-${platKey}`), "lib"),
].filter(Boolean))];
const platStageDir = platLibCandidates.find((d) => existsSync(d));
if (platStageDir) {
  for (const f of readdirSync(platStageDir)) {
    if (f.endsWith(libExt)) copyFileSync(join(platStageDir, f), join(nativeDir, f));
  }
} else {
  console.error(`no libdowndraft_platform build found for ${platKey} — searched: ${platLibCandidates.join(", ")}`);
  process.exit(1);
}

// Engine cdylibs — staged if a build exists: new dist/<plat>-<arch>/ and
// dist/ layouts (build-native.mjs), the installed @downdraft/engine package
// (standalone games), plus the legacy standalone-crate target/ + crate-dir
// layouts.
const engineCrates = CRATES.filter((c) => c.pkg !== "downdraft-platform");
const engineRoot = pkgRoot("@downdraft/engine");
const staged = new Set();
engineCrates.forEach((crate) => {
  const file = libFileName(crate.lib, platKey);
  // crate.dir is packages/engine/libraries/<name>/native — strip the
  // package prefix to probe inside an installed @downdraft/engine.
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
  for (let _i = 0, _it = candidates, _n = _it.length; _i < _n; _i++) {
    const p = _it[_i];
    if (existsSync(p) && !staged.has(file)) {
      copyFileSync(p, join(nativeDir, file));
      staged.add(file);
      break;
    }
  }
});

// Game-native libs — convention: <game>/native/dist/<platform>-<arch>/ holds
// artifacts the game built itself (cdylib .so/.dll/.dylib loaded via the FFI
// adapter, or .node napi addons loaded via createRequire/process.dlopen).
// Staged flat into native/ so resolveNativeLibrary's <execDir>/native lookup
// and execDir-relative .node resolution both hit.
const gameNativeDir = join(gameDir, "native", "dist", platKey);
if (existsSync(gameNativeDir)) {
  let gameLibs = 0;
  for (const f of readdirSync(gameNativeDir)) {
    if (f.endsWith(libExt) || f.endsWith(".node")) {
      copyFileSync(join(gameNativeDir, f), join(nativeDir, f));
      staged.add(f);
      gameLibs++;
    }
  }
  if (gameLibs) console.log(`staged ${gameLibs} game-native lib(s) from ${gameNativeDir}`);
}

// Assets referenced via ?url / new URL / import.meta.glob.
const assetRoot = join(outdir, "dd-assets");
let stagedAssets = 0;
for (const f of assetFiles.values()) {
  const dest = join(assetRoot, assetRel(f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  stagedAssets++;
}

console.log(`staged: ${readdirSync(nativeDir).filter((f) => f.endsWith(libExt)).length} native libs, ${stagedAssets} assets`);
