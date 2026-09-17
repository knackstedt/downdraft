// packages/cli/scripts/patch-pixi.mjs
// Applies targeted patches to pixi.js in node_modules after install.
// These patches fix bugs that haven't been upstreamed or released yet.
//
// Invoked as `draft patch-pixi` (see src/index.ts) from a project's
// postinstall. The install root is the cwd — postinstall scripts run from
// the project root in both the monorepo and standalone game repos.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

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
// In the native runtime, FillStyle objects created from a simple color
// (via handleColorLike) set texture=Texture.WHITE but don't set matrix.
// The Texture.WHITE identity check in getCanvasFillStyle can fail due to
// dual module instances in Bun's module resolution, causing it to fall
// into the pattern branch where it dereferences fillStyle.matrix (null),
// causing a TypeError that silently kills the entire render pass.
// Fix: when matrix is null, fall back to the solid color path.
const fillStyleFixMjs = `  } else if (!fillStyle.fill) {
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = fillStyle.matrix.copyTo(Matrix.shared);`;
const fillStyleFixMjsNew = `  } else if (!fillStyle.fill) {
    if (!fillStyle.matrix) {
      return Color.shared.setValue(fillStyle.color).setAlpha(fillStyle.alpha ?? 1).toHexa();
    }
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = fillStyle.matrix.copyTo(Matrix.shared);`;

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
    if (!fillStyle.matrix) {
      return Color.Color.shared.setValue(fillStyle.color).setAlpha(fillStyle.alpha ?? 1).toHexa();
    }
    const pattern = context.createPattern(fillStyle.texture.source.resource, "repeat");
    const tempMatrix = fillStyle.matrix.copyTo(Matrix.Matrix.shared);`;

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
