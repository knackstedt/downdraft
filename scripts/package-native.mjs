// ============================================================================
// package-native.mjs — compile a game's native entry into a standalone Bun
// binary plus a staged runtime tree:
//
//   bun scripts/package-native.mjs games/mining-rpg/src/native-entry.ts /tmp/out/mining
//
// Produces:
//   <outfile>                    compiled binary
//   <outdir>/native/*.so         platform shims + engine cdylibs (dlopen'd)
//   <outdir>/native/lib/*.so     shim dependencies (rpath $ORIGIN/lib)
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bun scripts/package-native.mjs <entry.ts> <outfile>");
  process.exit(1);
}

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
  for (const e of entries) {
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
    for (const ext of ["wgsl", "glsl"]) {
      build.onResolve({ filter: new RegExp(`\\.${ext}$`) }, (args) => {
        const resolved = resolveImport(args.path, args.importer);
        if (resolved.endsWith(".ts")) return { path: resolved };
        return { path: resolved, namespace: "dd-raw" };
      });
    }
    // CSS — no DOM in native mode; discard like the runtime loader does.
    build.onResolve({ filter: /\.css$/ }, (args) => ({
      path: args.path, namespace: "dd-css",
    }));
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
      if (out !== src || needsGlob) {
        out = out.replace(META_DIR_RE, "__ddModDir");
        out = out.replace(META_URL_RE, "__ddModUrl");
        out = out.replace(/(?<![.\w$])__dirname\b/g, "__ddModDir");
        out =
          `import { dirname as __ddDirname } from "node:path";\n` +
          `import { pathToFileURL as __ddP2F } from "node:url";\n` +
          `const __ddModDir = __ddDirname(process.execPath) + "/dd-assets/" + ${JSON.stringify(stagedDir === "." ? "" : stagedDir + "/")}.replace(/\\/$/, "");\n` +
          `const __ddModUrl = __ddP2F(__ddModDir + "/" + ${JSON.stringify(modBase)}).href;\n` +
          (needsGlob
            ? `import { createGlob as __ddCreateGlob } from "@downdraft/engine/platform/glob-polyfill";\n` +
              `const __ddGlob = __ddCreateGlob(__ddModDir);\n`
            : "") +
          out;
      }
      const loader = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mts: "ts", mjs: "js" }[args.path.split(".").pop()] || "ts";
      return out === src ? undefined : { contents: out, loader };
    });
  },
});

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
    outdir: "/tmp/dd-scan-out",
  });
  if (!scan.success) {
    for (const msg of scan.logs) console.error(msg);
    process.exit(1);
  }
}

const entrypoints = [resolve(entry), ...workerEntries];
if (workerEntries.size) {
  console.log(`workers: ${[...workerEntries].map((p) => p.split("/").pop()).join(", ")}`);
}

const result = await Bun.build({
  entrypoints,
  compile: { outfile: resolve(outfile) },
  target: "bun",
  plugins: [makePlugin(false)],
  splitting: false,
  sourcemap: "none",
  minify: false,
  // koffi is the Node-only FFI fallback (dead under Bun); its native addon
  // can't bundle, and the import is guarded by runtime detection anyway.
  external: ["koffi"],
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}
for (const out of result.outputs) {
  console.log(`${out.kind.padEnd(18)} ${out.path} ${(out.size / 1024 / 1024).toFixed(1)}MB`);
}

// ── Stage runtime tree ──
const outdir = dirname(resolve(outfile));
const isWin = process.platform === "win32";
const libExt = isWin ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";

const nativeDir = join(outdir, "native");
const nativeLibDir = join(nativeDir, "lib");
mkdirSync(nativeLibDir, { recursive: true });

// Platform shims + their lib/ dependencies (rpath $ORIGIN/lib).
const shimDir = resolve(repoRoot, "packages/platform-native/native");
for (const f of readdirSync(shimDir)) {
  if (f.endsWith(libExt)) copyFileSync(join(shimDir, f), join(nativeDir, f));
}
const shimLibDir = join(shimDir, "lib");
if (existsSync(shimLibDir)) {
  for (const f of readdirSync(shimLibDir)) {
    if (f.endsWith(libExt) || f.endsWith(".a")) copyFileSync(join(shimLibDir, f), join(nativeLibDir, f));
  }
}

// Engine cdylibs — staged if a release build exists.
const engineLibs = [
  "packages/engine/libraries/physics-native/native/target/release/libdowndraft_physics",
  "packages/engine/libraries/devtools/native/dist/libdowndraft_devtools",
  "packages/engine/libraries/devtools/native/libdowndraft_devtools",
  "packages/engine/libraries/blitz-ui/native-osr/target/release/libdowndraft_blitz_osr",
];
const staged = new Set();
for (const base of engineLibs) {
  const p = resolve(repoRoot, base + libExt);
  const name = basename(base) + libExt;
  if (existsSync(p) && !staged.has(name)) {
    copyFileSync(p, join(nativeDir, name));
    staged.add(name);
  }
}

// Assets referenced via ?url / new URL / import.meta.glob.
const assetRoot = join(outdir, "dd-assets");
let stagedAssets = 0;
for (const f of assetFiles) {
  const dest = join(assetRoot, assetRel(f));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  stagedAssets++;
}

console.log(`staged: ${readdirSync(nativeDir).filter((f) => f.endsWith(libExt)).length} native libs, ${stagedAssets} assets`);
