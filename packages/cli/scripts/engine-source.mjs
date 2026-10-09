// engine-source.mjs — decides whether bundling resolves @downdraft/* via
// the "downdraft-source" export condition (TypeScript src/) or the default
// condition (pre-built dist/).
//
// Published packages ship dist/ so standalone consumers bundle fast-built
// ESM. In the engine monorepo (or any install where dist/ hasn't been
// generated) the default target doesn't exist — without this the packager
// fails with "Could not resolve: @downdraft/...". Mirrors `draft dev`'s
// rule: monorepo defaults to source, everything else defaults to dist,
// --engine-source / --engine-dist override.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_CONDITION = "downdraft-source";

const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function enginePkgRoot(fromFile) {
  try {
    const req = createRequire(resolve(fromFile));
    return dirname(req.resolve("@downdraft/engine/package.json"));
  } catch {
    return null;
  }
}

/**
 * @param {string[]} argv raw flag list (process.argv.slice(2))
 * @param {string} fromFile file to anchor @downdraft/engine resolution at
 *   (typically the game entry — covers workspace links and standalone repos)
 * @returns {string[] | undefined} Bun.build `conditions` override
 */
export function engineConditions(argv, fromFile) {
  if (argv.includes("--engine-dist")) return undefined;
  if (argv.includes("--engine-source")) return [SOURCE_CONDITION];
  const pkg = enginePkgRoot(fromFile);
  // Workspace-linked engine → always source (a stale dist/ would silently
  // package old code). Standalone consumer → dist when it exists.
  if (!pkg || pkg.startsWith(monorepoRoot + sep) || !existsSync(join(pkg, "dist"))) {
    return [SOURCE_CONDITION];
  }
  return undefined;
}
