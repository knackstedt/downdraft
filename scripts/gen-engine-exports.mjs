#!/usr/bin/env node
// ============================================================================
// gen-engine-exports.mjs — regenerate the `exports` map in
// packages/engine/package.json by scanning the source tree.
//
// Why a generator: Node's `*` in exports patterns is greedy (it captures `/`),
// so a single-star pattern like "./libraries/*" always beats "./libraries/*/*".
// Deep imports therefore need per-directory prefix patterns
// ("./libraries/persistence/*" wins over "./libraries/*" on longer base), plus
// explicit entries for directory-index subpaths ("./libraries/models/fbx" →
// ".../src/fbx/index.ts"). Scanning the tree emits all of it deterministically.
//
// Usage:
//   node scripts/gen-engine-exports.mjs           regenerate in place
//   node scripts/gen-engine-exports.mjs --check   verify up-to-date (CI)
// ============================================================================

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const engineDir = join(root, "packages/engine");
const pkgPath = join(engineDir, "package.json");
const checkOnly = process.argv.includes("--check");

// Subpaths that don't follow the <name>/src/<rest> convention.
const OVERRIDES = {
  "./lint-plugin": "./lint-plugin.mjs",
};

// Non-source extensions that must map to themselves (not "*.ts").
const PASSTHROUGH_EXTS = [".wgsl", ".css"];

const hasExt = (dir, ext) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (hasExt(join(dir, e.name), ext)) return true;
    } else if (e.name.endsWith(ext)) {
      return true;
    }
  }
  return false;
};

/** All dirs under src (recursive) that contain index.ts — need explicit
 *  directory-index entries since patterns only cover "*.ts" files. */
const indexDirs = (srcDir) => {
  const out = [];
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    if (existsSync(join(dir, "index.ts"))) out.push(rel);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(srcDir, "");
  return out;
};

/** Emit the standard pattern trio for a package dir:
 *  "<prefix>/<n>/*" → src/*.ts (+ passthrough exts present under src). */
const dirPatterns = (prefix, name, srcDir) => {
  const base = `${prefix}/${name}`;
  const out = [[`${base}/*`, `${base}/src/*.ts`], [`${base}/*.ts`, `${base}/src/*.ts`]];
  PASSTHROUGH_EXTS.forEach((ext) => {
    if (hasExt(srcDir, ext)) out.push([`${base}/*${ext}`, `${base}/src/*${ext}`]);
  });
  return out;
};

const entries = [];

// -- "." + core ------------------------------------------------------------
entries.push([".", "./core/src/index.ts"], ["./package.json", "./package.json"]);

const coreSrc = join(engineDir, "core/src");
// Explicit entries for core directory-index subpaths ("./ecs" → ecs/index.ts)
// at any depth; "./ecs/foo" deep files are covered by the "./*" catch-all.
for (const rel of indexDirs(coreSrc)) {
  if (rel) entries.push([`./${rel}`, `./core/src/${rel}/index.ts`]);
}

// -- app -------------------------------------------------------------------
const appSrc = join(engineDir, "app/src");
entries.push(
  ["./app", "./app/src/index.ts"],
  ["./app/renderer", "./app/src/renderer/index.ts"],
  ["./app/shared", "./app/src/shared/index.ts"],
  ["./app/renderer/downdraft-base.css", "./app/src/renderer/downdraft-base.css"],
);
for (const rel of indexDirs(appSrc)) {
  if (rel && !["renderer", "shared"].includes(rel)) {
    entries.push([`./app/${rel}`, `./app/src/${rel}/index.ts`]);
  }
}
entries.push(["./app/*", "./app/src/*.ts"], ["./app/*.ts", "./app/src/*.ts"]);
PASSTHROUGH_EXTS.forEach((ext) => {
  if (hasExt(appSrc, ext)) entries.push([`./app/*${ext}`, `./app/src/*${ext}`]);
});

// -- other folded top-level dirs --------------------------------------------
for (let _i = 0, _it = ["ui", "shader-graph", "mcp", "test", "asset-bake"], _n = _it.length; _i < _n; _i++) { const name = _it[_i];
  const srcDir = join(engineDir, name, "src");
  if (!existsSync(srcDir)) continue;
  entries.push([`./${name}`, `./${name}/src/index.ts`]);
  for (const rel of indexDirs(srcDir)) {
    if (rel) entries.push([`./${name}/${rel}`, `./${name}/src/${rel}/index.ts`]);
  }
  entries.push(...dirPatterns(".", name, srcDir));
}

// -- libraries + modules -----------------------------------------------------
for (let _i = 0, _it = ["./libraries", "./modules"], _n = _it.length; _i < _n; _i++) { const prefix = _it[_i];
  const baseDir = join(engineDir, prefix.slice(2));
  if (!existsSync(baseDir)) continue;
  for (const name of readdirSync(baseDir).sort()) {
    const srcDir = join(baseDir, name, "src");
    if (!existsSync(srcDir) || !existsSync(join(srcDir, "index.ts"))) continue;
    entries.push([`${prefix}/${name}`, `${prefix}/${name}/src/index.ts`]);
    for (const rel of indexDirs(srcDir)) {
      if (rel) entries.push([`${prefix}/${name}/${rel}`, `${prefix}/${name}/src/${rel}/index.ts`]);
    }
    entries.push(...dirPatterns(prefix, name, srcDir));
  }
}

// -- irregular overrides ------------------------------------------------------
for (const [k, v] of Object.entries(OVERRIDES)) entries.push([k, v]);

// -- core catch-alls (least specific; lose to every longer-base pattern) ------
entries.push(["./*", "./core/src/*.ts"], ["./*.ts", "./core/src/*.ts"]);
[...PASSTHROUGH_EXTS, ".md"].forEach((ext) => {
  if (hasExt(coreSrc, ext) || ext === ".md") entries.push([`./*${ext}`, `./core/src/*${ext}`]);
});

// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const oldExports = pkg.exports ?? {};
const newExports = Object.fromEntries(entries);

const added = Object.keys(newExports).filter((k) => !(k in oldExports));
const removed = Object.keys(oldExports).filter((k) => !(k in newExports));
const changed = Object.keys(newExports).filter((k) => oldExports[k] !== newExports[k]);

if (checkOnly) {
  if (!added.length && !removed.length && !changed.length) {
    console.log("engine exports map is up-to-date.");
    process.exit(0);
  }
  console.error("engine exports map is stale — run `node scripts/gen-engine-exports.mjs`.");
  added.forEach((k) => { console.error(`  + ${k}`);; });
  removed.forEach((k) => { console.error(`  - ${k}`);; });
  changed.forEach((k) => { console.error(`  ~ ${k}`);; });
  process.exit(1);
}

pkg.exports = newExports;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`engine exports: ${entries.length} entries (${added.length} added, ${removed.length} removed, ${changed.length} changed)`);
