#!/usr/bin/env node
// ============================================================================
// build-dist.mjs — emit a pre-transpiled dist/ tree for the published engine
// packages so consumers (and `draft dev --engine-dist`) load native ESM
// instead of paying the per-module TS transform cost on every cold start.
//
// Shape: per-file transpilation, NOT bundling. Every source file maps 1:1 to
// a dist file, preserving deep-import semantics, worker entrypoints, asset
// layout, and `import.meta.url` path math:
//
//   packages/engine/core/src/util/logger.ts  →  packages/engine/dist/core/src/util/logger.js
//   packages/platform-native/src/index.ts    →  packages/platform-native/dist/src/index.js
//
// Pipeline per code file (.ts/.tsx/.mts/.cts transpiled via tsc
// transpileModule; .js/.mjs pass through un-transpiled):
//
//   1. `*.wgsl`/`.glsl` and `*?raw` imports       → inlined `const` strings
//      (matches the vite `?raw`/`with { type: "text" }` contract)
//   2. `*?url` imports                          → `new URL(rel, import.meta.url).href`
//      for relative specs, `import.meta.resolve(spec)` for bare specs
//   3. `*?json` imports                         → inlined JSON literal
//   4. relative specifiers (import/export/dynamic import/new URL/require.resolve)
//      → resolved on disk and repathed: transpiled targets get their new
//      extension (.ts→.js), assets keep the same relative layout (the dist
//      mirror preserves it), targets escaping the package (e.g. package.json)
//      get recomputed ../ segments
//   5. `import.meta.dir|dirname|filename|path`  → fileURLToPath-derived locals
//      (Bun/Deno-only props; Node needs them materialized)
//   6. `import(<ident>)` where <ident> is a const string → rewritten specifier
//
// Everything else under the source roots (assets, .mjs loaders, .d.ts) is
// copied verbatim. Spec/test files are excluded.
//
// The dist tree is consumed via package.json export conditions:
//   "default"          → dist/*.js   (npm installs, `draft dev --engine-dist`)
//   "downdraft-source" → src/*.ts    (monorepo dev, `draft dev --engine-source`)
//
// Usage:
//   node scripts/build-dist.mjs [--pkg=engine|platform-native] [--clean] [-v]
// ============================================================================

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require_ = createRequire(join(root, "package.json"));
const ts = require_("typescript");

const argv = process.argv.slice(2);
const onlyPkg = (argv.find((a) => a.startsWith("--pkg=")) ?? "").slice(6) || null;
const clean = argv.includes("--clean");
const verbose = argv.includes("--verbose") || argv.includes("-v");

// ── Packages + mirrored source roots ─────────────────────────────────────────
// Mirror rule: dist/<path relative to package dir>. Roots are <dir>/src trees.

const PACKAGES = [
  {
    name: "@downdraft/engine",
    dir: "packages/engine",
    roots: [
      "core/src",
      "app/src",
      "shader-graph/src",
      "mcp/src",
      "test/src",
      "asset-bake/src",
    ],
    globRoots: ["libraries/*/src", "modules/*/src"],
  },
  {
    name: "@downdraft/platform-native",
    dir: "packages/platform-native",
    roots: ["src"],
    globRoots: [],
  },
];

// Files excluded from dist (not part of the shipped surface).
const SKIP_FILE_RE = /(?:\.spec|\.test)\.[jt]sx?$|-spike/;
const SKIP_DIRS = new Set(["node_modules", "dist", "spec-fixtures", ".benchmark"]);

// Source → emitted extension. Everything else copies verbatim.
const CODE_EXT_MAP = new Map([
  [".ts", ".js"],
  [".tsx", ".jsx"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
]);
const TRANSPILABLE = new Set(CODE_EXT_MAP.keys());
const PASSTHROUGH_CODE = new Set([".js", ".jsx", ".mjs", ".cjs"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

const toPosix = (p) => p.split(sep).join("/");
const extOf = (p) => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
};

/** Resolve a relative specifier against the source tree. Directories resolve
 *  too (e.g. `new URL("../assets/", import.meta.url)`) — the mirror keeps
 *  relative layout, so they only need repathing into dist/. */
function resolveSpecifier(srcDir, spec) {
  const abs = resolve(srcDir, spec);
  const tries = [abs];
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json", ".wgsl", ".glsl", ".wasm", ".css", ".md"].values()) {
    tries.push(abs + ext);
  }
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".d.ts", ".json"].values()) {
    tries.push(join(abs, "index" + ext));
  }
  for (const t of tries.values()) {
    try {
      if (existsSync(t) && statSync(t).isFile()) return t;
    } catch { /* keep probing */ }
  }
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
  } catch { /* fall through */ }
  return null;
}

/**
 * Lexical mask — returns a predicate `isCode(offset)` that is true only at
 * positions outside comments, string literals, and template literals.
 * Specifier/import.meta rewrites skip masked positions so comments and
 * generated-code strings keep their original text.
 * (Regex literals like /\/ are intentionally not handled — a `//` inside a
 * regex body is treated as a line comment; that edge is accepted.)
 */
function codeMask(src) {
  const spans = []; // [start, end) non-code ranges
  let i = 0;
  const n = src.length;
  const CODE = 0, LINE = 1, BLOCK = 2, SQ = 3, DQ = 4, TPL = 5;
  let state = CODE;
  let start = 0;
  const tplDepth = [];
  let braceDepth = 0; // { } nesting inside the current ${ } expression
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === CODE) {
      if (c === "/" && c2 === "/") { state = LINE; start = i; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = BLOCK; start = i; i += 2; continue; }
      if (c === "'") { state = SQ; start = i++; continue; }
      if (c === '"') { state = DQ; start = i++; continue; }
      if (c === "`") { state = TPL; start = i++; continue; }
      if (c === "}" && tplDepth.length && braceDepth === 0) {
        // `}` terminating a ${…} — resume the template it belongs to.
        state = TPL; start = tplDepth.pop(); i++; continue;
      }
      if (c === "{") braceDepth++;
      else if (c === "}") braceDepth = Math.max(0, braceDepth - 1);
      i++;
    } else if (state === LINE) {
      if (c === "\n") { spans.push([start, i]); state = CODE; }
      i++;
    } else if (state === BLOCK) {
      if (c === "*" && c2 === "/") { spans.push([start, i + 2]); state = CODE; i += 2; continue; }
      i++;
    } else if (state === SQ || state === DQ) {
      const end = state === SQ ? "'" : '"';
      if (c === "\\") { i += 2; continue; }
      if (c === end || c === "\n") { spans.push([start, i + (c === end ? 1 : 0)]); state = CODE; }
      i++;
    } else if (state === TPL) {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { spans.push([start, i + 1]); state = CODE; i++; continue; }
      if (c === "$" && c2 === "{") { tplDepth.push(start); state = CODE; braceDepth = 0; i += 2; continue; }
      i++;
    }
  }
  if (state !== CODE) spans.push([start, n]);
  let cursor = 0;
  return (off) => {
    while (cursor < spans.length && off >= spans[cursor][1]) cursor++;
    return !(cursor < spans.length && off >= spans[cursor][0]);
  };
}

// ── Module rewriting ─────────────────────────────────────────────────────────

/**
 * Rewrite a single emitted/JS module for the dist tree.
 * @param {string} js      module source (already JS)
 * @param {object} ctx     {srcAbs, distAbs, pkgDir, rootAbs, warnings, fileRel}
 */
function rewriteModule(js, ctx) {
  const { srcAbs, distAbs, pkgDir, rootAbs, warnings, fileRel } = ctx;
  const srcDir = dirname(srcAbs);
  const distDir = dirname(distAbs);
  // The mask goes stale after every rewrite (offsets shift) — rebuild it for
  // each pass. `maskedReplace` skips matches inside comments/strings/templates.
  const maskedReplace = (re, fn) => {
    const m = codeMask(js);
    return js.replace(re, (...a) => (m(a[a.length - 2]) ? fn(...a) : a[0]));
  };
  const forEachCodeMatch = (re, fn) => {
    const m = codeMask(js);
    for (const x of js.matchAll(re)) if (m(x.index)) fn(x);
  };

  // Map an on-disk target to the specifier the dist file should use.
  // Inside a mirrored root → dist mirror path (code exts swapped).
  // Outside any root (package.json, repo files) → repathed real file.
  const distSpecFor = (absTarget) => {
    const rel = toPosix(relative(pkgDir, absTarget));
    const inRoot = rootAbs.some((r) => absTarget === r || absTarget.startsWith(r + sep));
    let targetAbs = absTarget;
    if (inRoot && !SKIP_FILE_RE.test(rel)) {
      const ext = extOf(rel);
      const mapped = /\.d\.[cm]?ts$/.test(rel) ? null : CODE_EXT_MAP.get(ext);
      targetAbs = join(pkgDir, "dist", mapped ? rel.slice(0, -ext.length) + mapped : rel);
    } else if (inRoot && SKIP_FILE_RE.test(rel)) {
      warnings.push(`${fileRel}: specifier targets skipped file ${rel}`);
      return null;
    }
    const relOut = toPosix(relative(distDir, targetAbs));
    return relOut.startsWith(".") ? relOut : "./" + relOut;
  };

  // Resolve + map a relative specifier; returns null to leave unchanged.
  const mapRelSpec = (spec) => {
    const q = spec.indexOf("?");
    const bare = q >= 0 ? spec.slice(0, q) : spec;
    if (!bare.startsWith(".") && !bare.startsWith("/")) return null;
    const target = resolveSpecifier(srcDir, bare);
    if (!target) {
      warnings.push(`${fileRel}: unresolved relative specifier "${spec}"`);
      return null;
    }
    const mapped = distSpecFor(target);
    if (mapped === null) return null;
    return mapped + (q >= 0 ? spec.slice(q) : "");
  };

  // -- 1. ?raw / .wgsl / .glsl imports → inlined strings ----------------------
  // import X from "spec?raw" [with {…}];   import X from "spec.wgsl";
  // import * as ns …;  import {a,b} …;  import "spec?raw";
  const RAW_SPEC = String.raw`[^"']*(?:\?raw|\.wgsl|\.glsl|\.frag|\.vert)(?:\?raw)?`;
  let rawTmp = 0;
  // Bare specifiers (@downdraft/* etc.) resolve through the package exports map.
  const pkgRequire = createRequire(join(pkgDir, "package.json"));
  const resolveBare = (spec) => {
    try { return pkgRequire.resolve(spec); } catch { return null; }
  };
  const rawReplacer = (_m, nl, indent, clause, spec) => {
    const bare = spec.split("?")[0];
    const abs = bare.startsWith(".") ? resolveSpecifier(srcDir, bare) : resolveBare(bare);
    if (!abs) {
      warnings.push(`${fileRel}: unresolved ?raw/loader specifier "${spec}"`);
      return _m;
    }
    const lit = JSON.stringify(readFileSync(abs, "utf8"));
    const c = (clause ?? "").trim();
    if (!c) return nl; // side-effect raw import — dropped (no side effects)
    if (c.startsWith("*")) {
      const name = c.replace(/^\*\s*as\s+/, "").trim();
      return `${nl}${indent}const ${name} = { default: ${lit} };`;
    }
    const named = c.match(/\{([^}]*)\}/);
    const def = c.startsWith("{") ? "" : c.split(",")[0].trim();
    let out = "";
    if (def) out += `${nl}${indent}const ${def} = ${lit};`;
    if (named) {
      const obj = def ? def : `__dd_raw_${rawTmp++}`;
      if (!def) out = `${nl}${indent}const ${obj} = ${lit};`;
      const names = named[1].replace(/\bas\b/g, ":").trim();
      if (names) out += `${nl}${indent}const { ${names} } = ${obj};`;
    }
    return out;
  };
  js = maskedReplace(
    new RegExp(`(^|\\n)([ \\t]*)import\\s+([^;\\n]*?)\\s+from\\s+["'](${RAW_SPEC})["'](\\s+with\\s*\\{[^}]*\\})?\\s*;?`, "g"),
    rawReplacer,
  );
  // side-effect: import "x?raw";
  js = maskedReplace(
    new RegExp(`(^|\\n)([ \\t]*)import\\s*["'](${RAW_SPEC})["']\\s*;?`, "g"),
    (m, nl, indent, spec) => rawReplacer(m, nl, indent, "", spec),
  );

  // -- 2/3. ?url / ?json static imports ----------------------------------------
  const urlExpr = (spec) => {
    const q = spec.indexOf("?");
    const bare = spec.slice(0, q);
    if (bare.startsWith(".")) {
      const target = resolveSpecifier(srcDir, bare);
      if (!target) {
        warnings.push(`${fileRel}: unresolved ?url specifier "${spec}"`);
        return "undefined";
      }
      const mapped = distSpecFor(target);
      return `new URL(${JSON.stringify(mapped)}, import.meta.url).href`;
    }
    return `import.meta.resolve(${JSON.stringify(bare)})`;
  };
  const QUERY_KIND_RE = /\?(url|json)$/;
  js = maskedReplace(
    /(^|\n)([ \t]*)import\s+([^;\n]*?)\s+from\s+["']([^"']+\?(?:url|json))["'](\s+with\s*\{[^}]*\})?\s*;?/g,
    (_m, nl, indent, clause, spec) => {
      const kind = spec.match(QUERY_KIND_RE)?.[1];
      const bare = spec.split("?")[0];
      let lit;
      if (kind === "url") {
        lit = urlExpr(spec);
      } else {
        const abs = bare.startsWith(".") ? resolveSpecifier(srcDir, bare) : resolveBare(bare);
        if (!abs) { warnings.push(`${fileRel}: unresolved ?json specifier "${spec}"`); return _m; }
        lit = readFileSync(abs, "utf8").trim();
      }
      const c = (clause ?? "").trim();
      if (!c) return nl; // side-effect ?url/?json — dropped
      if (c.startsWith("*")) {
        const name = c.replace(/^\*\s*as\s+/, "").trim();
        return `${nl}${indent}const ${name} = { default: ${lit} };`;
      }
      const named = c.match(/\{([^}]*)\}/);
      const def = c.startsWith("{") ? "" : c.split(",")[0].trim();
      let out = "";
      if (def) out += `${nl}${indent}const ${def} = ${lit};`;
      if (named) {
        const obj = def ? def : `__dd_q_${rawTmp++}`;
        if (!def) out = `${nl}${indent}const ${obj} = ${lit};`;
        const names = named[1].replace(/\bas\b/g, ":").trim();
        if (names) out += `${nl}${indent}const { ${names} } = ${obj};`;
      }
      return out;
    },
  );
  // dynamic import("spec?raw|url|json") → Promise.resolve({ default: … })
  js = maskedReplace(
    /\bimport\s*\(\s*["']([^"']+)\?(raw|url|json)["']\s*\)/g,
    (_m, spec, kind) => {
      let lit;
      const bare = spec;
      const abs = kind !== "url"
        ? (bare.startsWith(".") ? resolveSpecifier(srcDir, bare) : resolveBare(bare))
        : null;
      if (kind === "raw") {
        if (!abs) { warnings.push(`${fileRel}: unresolved dynamic ?raw "${spec}"`); return _m; }
        lit = JSON.stringify(readFileSync(abs, "utf8"));
      } else if (kind === "url") {
        lit = urlExpr(`${spec}?url`);
      } else {
        if (!abs) { warnings.push(`${fileRel}: unresolved dynamic ?json "${spec}"`); return _m; }
        lit = readFileSync(abs, "utf8").trim();
      }
      return `Promise.resolve({ default: ${lit} })`;
    },
  );

  // -- 4. relative specifier repathing ----------------------------------------
  // Covers: from "…", import "…" (side-effect), import("…"), export … from "…",
  // new URL("…", import.meta.url), require.resolve("…").
  const specReplacer = (m, pre, quote, spec, ...rest) => {
    // rest = [group4?, offset, string] — group4 exists only on the new URL
    // regex; distinguish by type (offset is a number).
    const tail = typeof rest[0] === "string" ? rest[0] : "";
    const mapped = mapRelSpec(spec);
    return mapped === null ? m : `${pre}${quote}${mapped}${quote}${tail}`;
  };
  js = maskedReplace(/(\bfrom\s*)(["'])([^"']+)\2/g, specReplacer);
  js = maskedReplace(/(\bimport\s*\(\s*)(["'])([^"']+)\2/g, specReplacer);
  // new URL("…", import.meta.url) — the 4th group is re-appended by specReplacer.
  js = maskedReplace(
    /(\bnew\s+URL\s*\(\s*)(["'])([^"']+)\2(\s*,\s*import\.meta\.url)/g,
    specReplacer,
  );
  js = maskedReplace(/(\brequire\.resolve\s*\(\s*)(["'])([^"']+)\2/g, specReplacer);
  // side-effect imports: `import "…";` at statement start
  js = maskedReplace(
    /(^|\n)([ \t]*)import\s*(["'])([^"']+)\3\s*;/g,
    (m, nl, indent, quote, spec) => {
      const mapped = mapRelSpec(spec);
      return mapped === null ? m : `${nl}${indent}import ${quote}${mapped}${quote};`;
    },
  );

  // -- 6. dynamic import(<ident>) bound to a const string ----------------------
  const dynIdents = new Set();
  forEachCodeMatch(/\bimport\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g, (m) => dynIdents.add(m[1]));
  for (const ident of dynIdents.values()) {
    const declRe = new RegExp(
      `(\\b(?:const|let|var)\\s+${ident}\\s*=\\s*)(["'])([^"']+)\\2`,
    );
    js = maskedReplace(declRe, (m, pre, quote, spec) => {
      const mapped = mapRelSpec(spec);
      return mapped === null ? m : `${pre}${quote}${mapped}${quote}`;
    });
  }

  // -- 5. import.meta.dir/dirname/filename/path → derived locals ---------------
  let needDir = false;
  let needFile = false;
  forEachCodeMatch(/\bimport\.meta\.(dir|dirname|filename|path)\b/g, (m) => {
    if (m[1] === "dir" || m[1] === "dirname") needDir = true;
    else needFile = true;
  });
  if (needDir || needFile) {
    let pro = `import { fileURLToPath as __ddFileURLToPath } from "node:url";\n`;
    if (needFile) pro += `const __ddMetaFile = __ddFileURLToPath(import.meta.url);\n`;
    if (needDir) pro += `const __ddMetaDir = __ddFileURLToPath(new URL(".", import.meta.url));\n`;
    js = pro + js;
    const metaReplacer = (to) => (m, offset) => (codeMask(js)(offset) ? to : m);
    js = js
      .replace(/\bimport\.meta\.dirname\b/g, metaReplacer("__ddMetaDir"))
      .replace(/\bimport\.meta\.dir\b/g, metaReplacer("__ddMetaDir"))
      .replace(/\bimport\.meta\.filename\b/g, metaReplacer("__ddMetaFile"))
      .replace(/\bimport\.meta\.path\b/g, metaReplacer("__ddMetaFile"));
  }

  // -- guards: things dist can't express --------------------------------------
  let warnedGlob = false;
  forEachCodeMatch(/\bimport\.meta\.glob\s*\(/g, () => {
    if (!warnedGlob) {
      warnedGlob = true;
      warnings.push(`${fileRel}: literal import.meta.glob() call — dist leaves it unimplemented (callers should use createGlob/globAssets)`);
    }
  });
  let warnedQuery = false;
  {
    const m = codeMask(js);
    for (const x of js.matchAll(/["'][^"']*\?(?:raw|url|json)["']/g)) {
      // Only flag quoted query specs sitting in an actual import/URL context —
      // plain strings like query: "?url" or endsWith(".wgsl?raw") are legal.
      const before = js.slice(Math.max(0, x.index - 20), x.index);
      if (
        !warnedQuery &&
        x.index > 0 &&
        m(x.index - 1) &&
        /(?:\bfrom\s*|\bimport\s*\(\s*|\bnew\s+URL\s*\(\s*)$/.test(before)
      ) {
        warnedQuery = true;
        warnings.push(`${fileRel}: unprocessed vite query import ${x[0]} — dist cannot resolve it`);
      }
    }
  }

  return js;
}

// ── Tree walk + emit ─────────────────────────────────────────────────────────

function* walk(dirAbs) {
  if (!existsSync(dirAbs)) return;
  for (const e of readdirSync(dirAbs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dirAbs, e.name));
    } else if (e.isFile() || e.isSymbolicLink()) {
      yield join(dirAbs, e.name);
    }
  }
}

function buildPackage(pkg) {
  const pkgDir = join(root, pkg.dir);
  const distDir = join(pkgDir, "dist");
  const warnings = [];
  const manifest = {};

  // Expand literal + glob roots to absolute dirs.
  const rootAbs = [];
  for (const r of pkg.roots.values()) {
    const abs = join(pkgDir, r);
    if (existsSync(abs)) rootAbs.push(abs);
  }
  for (const g of pkg.globRoots.values()) {
    const [pre, post] = g.split("*");
    const baseDir = join(pkgDir, pre.replace(/\/$/, ""));
    if (!existsSync(baseDir)) continue;
    for (const e of readdirSync(baseDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const abs = join(baseDir, e.name, post);
        if (existsSync(abs)) rootAbs.push(abs);
      }
    }
  }
  if (!rootAbs.length) {
    console.log(`${pkg.name}: no source roots found — skipped`);
    return warnings;
  }

  if (clean && existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

  // Prior manifest for incremental builds + stale-output deletion.
  const manifestPath = join(distDir, ".dd-manifest.json");
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(manifestPath, "utf8")).files ?? {};
  } catch { /* fresh build */ }

  let emitted = 0;
  let skipped = 0;

  for (const rootDir of rootAbs.values()) {
    for (const srcAbs of walk(rootDir)) {
      const pkgRel = toPosix(relative(pkgDir, srcAbs));
      if (SKIP_FILE_RE.test(pkgRel)) continue;
      const ext = extOf(pkgRel);
      const isDts = /\.d\.[cm]?ts$/.test(pkgRel);
      const outExt = isDts ? ext : CODE_EXT_MAP.get(ext) ?? ext;
      const distRel = "dist/" + pkgRel.slice(0, pkgRel.length - ext.length) + outExt;
      const distAbs = join(pkgDir, distRel);

      const st = statSync(srcAbs);
      manifest[distRel] = { src: pkgRel, mtimeMs: st.mtimeMs, size: st.size };
      const prev = prior[distRel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && existsSync(distAbs)) {
        skipped++;
        continue;
      }

      mkdirSync(dirname(distAbs), { recursive: true });
      const fileRel = `${pkg.name}/${pkgRel}`;

      if (isDts) {
        writeFileSync(distAbs, readFileSync(srcAbs));
      } else if (TRANSPILABLE.has(ext)) {
        const src = readFileSync(srcAbs, "utf8");
        const shebang = src.startsWith("#!") ? src.slice(0, src.indexOf("\n") + 1) : "";
        let out;
        try {
          out = ts.transpileModule(src, {
            fileName: srcAbs,
            reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
            sourceMap: false,
          },
          });
        } catch (e) {
          throw new Error(`transpile failed: ${fileRel} — ${e.message}`);
        }
        const errs = (out.diagnostics ?? []).filter(
          (d) => d.category === ts.DiagnosticCategory.Error,
        );
        if (errs.length) {
          warnings.push(
            `${fileRel}: tsc diagnostics — ${errs
              .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
              .join("; ")}`,
          );
        }
        let js = rewriteModule(out.outputText, {
          srcAbs, distAbs, pkgDir, rootAbs, warnings, fileRel,
        });
        if (shebang && !js.startsWith("#!")) js = shebang + js;
        writeFileSync(distAbs, js);
      } else if (PASSTHROUGH_CODE.has(ext)) {
        // .js/.mjs: not transpiled, but still repath relative specifiers so
        // stray "./x.ts" references keep resolving.
        const js = rewriteModule(readFileSync(srcAbs, "utf8"), {
          srcAbs, distAbs, pkgDir, rootAbs, warnings, fileRel,
        });
        writeFileSync(distAbs, js);
      } else {
        writeFileSync(distAbs, readFileSync(srcAbs));
      }
      emitted++;
      if (verbose) console.log(`  ${pkgRel} → ${distRel}`);
    }
  }

  // Delete dist outputs whose source disappeared.
  let removed = 0;
  if (existsSync(distDir)) {
    for (const distAbs of walk(distDir)) {
      const rel = toPosix(relative(pkgDir, distAbs));
      if (rel === "dist/.dd-manifest.json") continue;
      if (!(rel in manifest)) {
        rmSync(distAbs);
        removed++;
      }
    }
  }
  writeFileSync(manifestPath, JSON.stringify({ files: manifest }, null, 1));

  console.log(
    `${pkg.name}: ${emitted} emitted, ${skipped} unchanged, ${removed} removed → ${toPosix(relative(root, distDir))}`,
  );
  return warnings;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const targets = onlyPkg
  ? PACKAGES.filter((p) => p.name.endsWith(`/${onlyPkg}`) || p.dir.endsWith(`/${onlyPkg}`))
  : PACKAGES;
if (!targets.length) {
  console.error(`build-dist: unknown package "${onlyPkg}"`);
  process.exit(1);
}

let allWarnings = [];
for (const pkg of targets.values()) allWarnings = allWarnings.concat(buildPackage(pkg));

if (allWarnings.length) {
  console.warn(`\nbuild-dist: ${allWarnings.length} warning(s):`);
  for (const w of allWarnings.slice(0, 50)) console.warn(`  ${w}`);
  if (allWarnings.length > 50) console.warn(`  … and ${allWarnings.length - 50} more`);
}
