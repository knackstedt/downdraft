#!/usr/bin/env node
// ============================================================================
// rewrite-engine-imports.mjs — codemod @downdraft/* specifiers to the
// consolidated @downdraft/engine package.
//
//   @downdraft/engine[/<p>]         → @downdraft/engine[/<p>]
//   @downdraft/engine/app[/<p>]          → @downdraft/engine/app[/<p>]
//   @downdraft/engine/libraries/<n>[/<p>]  → @downdraft/engine/libraries/<n>[/<p>]
//   @downdraft/engine/modules/<n>[/<p>]   → @downdraft/engine/modules/<n>[/<p>]
//   @downdraft/engine/ui|shader-graph|mcp|test|asset-bake → @downdraft/engine/<same>
//   @downdraft/cli, @downdraft/platform-native    → unchanged (still separate)
//
// Also rewrites path-pattern strings (e.g. "/@downdraft/engine/" hot-reload
// watch prefixes) since they're plain text matches of the same specifiers.
//
// Deliberately does NOT touch:
//   - package.json files (dependency keys are rewritten by the manifest
//     updater — "@downdraft/engine/libraries/x" is not a valid dep name)
//   - tsconfig*.json, deno.json (regenerated / hand-rewritten)
//   - bunfig.toml, CI yml, link-games.mjs, publish-packages.mjs (path refs)
//
// Usage: node scripts/rewrite-engine-imports.mjs [--dry-run]
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dryRun = process.argv.includes("--dry-run");

// Prefix rules first (library-/module- cover every shard in one shot, and
// suffix variants like -native/-fx fall out correctly). Exact-name rules use
// a lookahead so "@downdraft/engine" can't match "@downdraft/corex".
const RULES = [
  [/@downdraft\/library-/g, "@downdraft/engine/libraries/"],
  [/@downdraft\/module-/g, "@downdraft/engine/modules/"],
  [/@downdraft\/core(?![\w-])/g, "@downdraft/engine"],
  [/@downdraft\/app(?![\w-])/g, "@downdraft/engine/app"],
  [/@downdraft\/shader-graph(?![\w-])/g, "@downdraft/engine/shader-graph"],
  [/@downdraft\/asset-bake(?![\w-])/g, "@downdraft/engine/asset-bake"],
  [/@downdraft\/mcp(?![\w-])/g, "@downdraft/engine/mcp"],
  [/@downdraft\/test(?![\w-])/g, "@downdraft/engine/test"],
  [/@downdraft\/ui(?![\w-])/g, "@downdraft/engine/ui"],
];

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".eta", ".md", ".wgsl", ".txt", ".html", ".css", ".toml",
]);

const SKIP_BASENAMES = new Set([
  "package.json", "deno.json", "bun.lock", "bun.lockb",
  "bunfig.toml", "CHANGELOG.md",
]);
const SKIP_PREFIXES = ["tsconfig"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "release", "out", ".downdraft",
  "android", "ios",
]);
const ROOTS = ["packages", "games", "examples", "tests", "docs", "scripts", ".github"];
const ROOT_FILES = ["AGENTS.md", "README.md"];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const e = _it[_i];
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

function isTargetFile(path) {
  const base = path.split("/").pop();
  if (SKIP_BASENAMES.has(base)) return false;
  if (SKIP_PREFIXES.some((p) => base.startsWith(p))) return false;
  const dot = base.lastIndexOf(".");
  return dot > 0 && TEXT_EXT.has(base.slice(dot));
}

let filesChanged = 0;
let totalReplacements = 0;
const inventory = new Map(); // specifier -> count (post-rewrite view is what matters)

for (let _i = 0, _it = ROOTS, _n = _it.length; _i < _n; _i++) { const rel = _it[_i];
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (!isTargetFile(file)) continue;
    const src = readFileSync(file, "utf8");
    let out = src;
    RULES.forEach(([re, rep]) => { out = out.replace(re, rep);; });
    if (out !== src) {
      filesChanged++;
      if (!dryRun) writeFileSync(file, out);
    }
  }
}
for (let _i = 0, _it = ROOT_FILES, _n = _it.length; _i < _n; _i++) { const rel = _it[_i];
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, "utf8");
  let out = src;
  RULES.forEach(([re, rep]) => { out = out.replace(re, rep);; });
  if (out !== src) {
    filesChanged++;
    if (!dryRun) writeFileSync(abs, out);
  }
}

// Inventory pass (always on current file contents — after rewrite when not dry).
for (let _i = 0, _it = ROOTS, _n = _it.length; _i < _n; _i++) { const rel = _it[_i];
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (!isTargetFile(file)) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/@downdraft\/[A-Za-z0-9_./~?=-]+/g)) {
      inventory.set(m[0], (inventory.get(m[0]) ?? 0) + 1);
    }
  }
}

console.log(`${dryRun ? "[dry-run] would rewrite" : "rewrote"} ${filesChanged} file(s)`);
console.log(`--- specifier inventory (${inventory.size} distinct) ---`);
for (const [spec, n] of [...inventory.entries()].sort()) {
  console.log(`${String(n).padStart(5)}  ${spec}`);
}
