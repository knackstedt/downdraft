// scripts/patch-pixi.mjs
// Applies targeted patches to pixi.js in node_modules after install.
// These patches fix bugs that haven't been upstreamed or released yet.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let patchesApplied = 0;

function patchFile(relPath, find, replace, label) {
  const absPath = join(root, relPath);
  if (!existsSync(absPath)) {
    console.warn(`[patch-pixi] SKIP: ${relPath} not found`);
    return;
  }
  let content = readFileSync(absPath, "utf8");
  if (!content.includes(find)) {
    console.log(`[patch-pixi] SKIP: ${label} — already patched or pattern not found`);
    return;
  }
  content = content.replace(find, replace);
  writeFileSync(absPath, content, "utf8");
  console.log(`[patch-pixi] APPLIED: ${label} (${relPath})`);
  patchesApplied++;
}

// ── Fix: getCanvasFillStyle crashes when fillStyle.matrix is null ──
// In the native runtime, FillStyle objects can have a null matrix when
// they're created without explicit pattern transforms. The canvas text
// renderer dereferences fillStyle.matrix without a null check, causing
// a TypeError that silently kills the entire render pass (the command
// encoder finishes with an open render pass, producing an invalid
// command buffer, so the texture stays in its previous state).
// This patch adds a null-safe fallback to Matrix.identity.
const fillStyleFixMjs = `  } else if (!fillStyle.fill) {
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = fillStyle.matrix.copyTo(Matrix.shared);`;
const fillStyleFixMjsNew = `  } else if (!fillStyle.fill) {
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = (fillStyle.matrix ?? new Matrix()).copyTo(Matrix.shared);`;

patchFile(
  "node_modules/pixi.js/lib/scene/text/canvas/utils/getCanvasFillStyle.mjs",
  fillStyleFixMjs,
  fillStyleFixMjsNew,
  "getCanvasFillStyle null-matrix fix (.mjs)",
);

const fillStyleFixJs = `  } else if (!fillStyle.fill) {
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = fillStyle.matrix.copyTo(Matrix.Matrix.shared);`;
const fillStyleFixJsNew = `  } else if (!fillStyle.fill) {
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = (fillStyle.matrix ?? new Matrix.Matrix()).copyTo(Matrix.Matrix.shared);`;

patchFile(
  "node_modules/pixi.js/lib/scene/text/canvas/utils/getCanvasFillStyle.js",
  fillStyleFixJs,
  fillStyleFixJsNew,
  "getCanvasFillStyle null-matrix fix (.js)",
);

// Also patch the bun-cached copy if it exists (bun uses a separate cache).
const bunCachePath =
  "node_modules/.bun/pixi.js@8.18.0/node_modules/pixi.js/lib/scene/text/canvas/utils/getCanvasFillStyle.mjs";
if (existsSync(join(root, bunCachePath))) {
  patchFile(bunCachePath, fillStyleFixMjs, fillStyleFixMjsNew, "getCanvasFillStyle null-matrix fix (bun cache .mjs)");
}
const bunCachePathJs =
  "node_modules/.bun/pixi.js@8.18.0/node_modules/pixi.js/lib/scene/text/canvas/utils/getCanvasFillStyle.js";
if (existsSync(join(root, bunCachePathJs))) {
  patchFile(bunCachePathJs, fillStyleFixJs, fillStyleFixJsNew, "getCanvasFillStyle null-matrix fix (bun cache .js)");
}

if (patchesApplied === 0) {
  console.log("[patch-pixi] No patches needed — all already applied or files not found.");
} else {
  console.log(`[patch-pixi] ${patchesApplied} patch(es) applied successfully.`);
}
