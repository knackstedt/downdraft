// prepare.mjs — materialize the mobile Node source tree.
//
//   1. fetch + sha256-verify the pinned upstream tarball (scripts/fetch.mjs)
//   2. extract into build/node-v<version>/ (always a fresh extract)
//   3. copy overlay/ verbatim into the tree
//   4. `git apply` every patch in `series`, in order — any reject is fatal
//
// The result is a build-ready tree; nothing is left in a half-applied state
// on failure (the directory is deleted before each run).

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDir, fetchTarball, nodeVersion, pkgDir } from "./fetch.mjs";

const overlayDir = join(pkgDir, "overlay");

export function seriesPatches() {
  return readFileSync(join(pkgDir, "series"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function copyOverlay(treeDir) {
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, e.name);
      const dest = join(treeDir, relative(overlayDir, src));
      if (e.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        walk(src);
      } else {
        cpSync(src, dest);
        console.log(`[node-mobile] overlay  ${relative(overlayDir, src)}`);
      }
    }
  };
  walk(overlayDir);
}

export async function prepare() {
  const version = nodeVersion();
  const tarball = await fetchTarball();
  const treeDir = join(buildDir, `node-v${version}`);

  console.log(`[node-mobile] extracting node-v${version} → ${relative(pkgDir, treeDir)}`);
  rmSync(treeDir, { recursive: true, force: true });
  mkdirSync(treeDir, { recursive: true });
  // tarball nests under node-v<ver>/ — strip the top dir
  execFileSync("tar", ["-xzf", tarball, "-C", treeDir, "--strip-components=1"], { stdio: "inherit" });

  copyOverlay(treeDir);

  // The build dir lives inside a git repo — `git apply` would interpret diff
  // paths relative to the OUTER repo top-level and silently skip every file
  // (exit 0, "Skipped patch"). GIT_CEILING_DIRECTORIES hides the parent repo
  // so apply runs in non-repo mode against treeDir.
  const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: buildDir };
  const gitApply = (mode) =>
    spawnSync("git", ["apply", ...mode], { cwd: treeDir, env: gitEnv, encoding: "utf8" });

  for (const patch of seriesPatches()) {
    const patchPath = join(pkgDir, "patches", patch);
    if (!existsSync(patchPath)) {
      throw new Error(`series lists ${patch} but patches/${patch} is missing`);
    }
    const check = gitApply(["--check", patchPath]);
    if (check.status !== 0) {
      const detail = gitApply(["--check", "--verbose", patchPath]);
      throw new Error(
        `[node-mobile] patch ${patch} does not apply to node-v${version}:\n${detail.stderr || detail.stdout}\n` +
          `Upstream drifted — see files.map for the files this patch owns, then re-port it.`,
      );
    }
    const r = gitApply([patchPath]);
    if (r.status !== 0) throw new Error(`[node-mobile] git apply failed on ${patch}:\n${r.stderr}`);
    console.log(`[node-mobile] applied  ${patch}`);
  }

  // Stamp the tree so later steps can assert they aren't running on a
  // half-materialized checkout.
  const stamp = join(treeDir, ".node-mobile-prepared");
  execFileSync("touch", [stamp]);
  console.log(`[node-mobile] prepared ${relative(pkgDir, treeDir)} (${seriesPatches().length} patches)`);
  return treeDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepare();
}
