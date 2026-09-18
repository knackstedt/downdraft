#!/usr/bin/env node
// ============================================================================
// gen-deno-import-map.mjs — regenerate the root deno.json import map from
// tsconfig.web.json `paths`.
//
// deno.json is a generated file (per AGENTS.md): it mirrors the web tsconfig's
// path aliases so `deno run --config ../../deno.json` resolves the same
// imports as tsc/vite. Deno import maps use the trailing-slash prefix form:
//   "@foo/bar/*": ["./src/*"]   →   "@foo/bar/": "./src/"
// When a tsconfig path has multiple targets (fallback array), the FIRST
// target wins — Deno import maps don't support resolution fallback.
//
// Usage: node scripts/gen-deno-import-map.mjs [--check]
//   --check  verify deno.json is up-to-date (exit 1 if stale); don't write.
// ============================================================================

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsconfigPath = join(root, "tsconfig.web.json");
const denoPath = join(root, "deno.json");

const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
const paths = tsconfig.compilerOptions?.paths ?? {};

const imports = {};
for (const [key, targets] of Object.entries(paths)) {
  const target = targets[0];
  if (key.endsWith("/*")) {
    // Prefix mapping: strip the "/*" from both sides, keep trailing "/".
    imports[key.slice(0, -1)] = target.replace(/\*$/, "");
  } else {
    imports[key] = target;
  }
}

// @downdraft/engine is a real package resolved via its exports map — translate
// that map into import-map entries (exact keys → files; "<dir>/*" → "<dir>/src/"
// prefixes). Extension-trailer patterns (*.ts/*.wgsl) are redundant under the
// src/ prefix mapping and are skipped.
const enginePkgPath = join(root, "packages/engine/package.json");
if (existsSync(enginePkgPath)) {
  const engineExports = JSON.parse(readFileSync(enginePkgPath, "utf8")).exports ?? {};
  for (const [key, target] of Object.entries(engineExports)) {
    if (!key.includes("*")) {
      imports[`@downdraft/engine${key.slice(1)}`] = `./packages/engine${target.slice(1)}`;
    } else {
      const m = key.match(/^(\.[a-z0-9\-/]*)\/\*$/i);
      const t = target.match(/^(\.[a-z0-9\-/]*)\/src\/\*\.ts$/i);
      if (m && t) imports[`@downdraft/engine${m[1].slice(1)}/`] = `./packages/engine${t[1].slice(1)}/src/`;
    }
  }
}

const out = JSON.stringify({ imports }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(denoPath, "utf8");
  if (current !== out) {
    console.error("deno.json is stale — run `bun run gen:deno-import-map` to regenerate.");
    process.exit(1);
  }
  console.log("deno.json is up-to-date.");
} else {
  writeFileSync(denoPath, out);
  console.log(`deno.json regenerated (${Object.keys(imports).length} imports).`);
}
