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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
