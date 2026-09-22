// ============================================================================
// package-native.mjs — Phase G spike: compile a game's native entry into a
// standalone Bun binary.
//
//   bun scripts/package-native.mjs games/mining-rpg/src/native-entry.ts /tmp/mining-native
//
// The runtime Bun.plugin() loaders in bun-preload.ts handle ?raw/.wgsl/?url
// for `bun run`, but Bun.build resolves modules on disk first — query
// suffixes fail resolution before onLoad fires. This plugin mirrors those
// loaders with the build-time contract (onResolve strips the suffix, onLoad
// returns contents + a real loader).
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bun scripts/package-native.mjs <entry.ts> <outfile>");
  process.exit(1);
}

const QUERY_RE = /\?(raw|url|json)$/;
const WORKER_RE = /new\s+Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g;

// Worker files referenced via `new Worker(new URL("...", import.meta.url))`
// must be passed as extra entrypoints — Bun bundles each one separately into
// the binary. Discovered by scanning every module that enters the graph.
const workerEntries = new Set();

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
    // ?url → absolute path string. NOTE: dev-mode parity — real packaging
    // must copy assets next to the binary and rewrite to relative paths.
    build.onLoad({ filter: /.*/, namespace: "dd-url" }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
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
    // Scan every real source file for Worker entrypoints. In the compile
    // pass, also rewrite the specifier: inside a compiled binary
    // import.meta.url flattens to /$bunfs/root/<outfile>, so "./x.ts" resolves
    // wrong. Embedded entrypoints keep repo-relative paths (renamed to .js),
    // so an absolute /$bunfs/root/<repo-rel>.js URL resolves correctly.
    build.onLoad({ filter: /\.[jt]sx?$/ }, (args) => {
      const src = readFileSync(args.path, "utf-8");
      if (!WORKER_RE.test(src)) return undefined;
      WORKER_RE.lastIndex = 0;
      if (collectWorkers) {
        for (const m of src.matchAll(WORKER_RE)) {
          const p = resolve(dirname(args.path), m[1]);
          if (existsSync(p)) workerEntries.add(p);
        }
        return undefined;
      }
      const out = src.replace(WORKER_RE, (m, spec) => {
        const rel = relative(process.cwd(), resolve(dirname(args.path), spec))
          .replace(/\\/g, "/").replace(/\.[jt]sx?$/, ".js");
        return m.replace(`"${spec}"`, `"/$bunfs/root/${rel}"`)
          .replace(`'${spec}'`, `"/$bunfs/root/${rel}"`)
          .replace(`\`${spec}\``, `"/$bunfs/root/${rel}"`);
      });
      const loader = { ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mts: "ts", mjs: "js" }[args.path.split(".").pop()] || "ts";
      return out === src ? undefined : { contents: out, loader };
    });
  },
});

// Pass 1: bundle without compile to discover Worker entrypoints.
const scan = await Bun.build({
  entrypoints: [resolve(entry)],
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
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}
for (const out of result.outputs) {
  console.log(`${out.kind.padEnd(18)} ${out.path} ${(out.size / 1024 / 1024).toFixed(1)}MB`);
}
