// bump.mjs — move the Node pin forward.
//
//   node scripts/bump.mjs <new-version>        e.g. 26.11.0
//
// Fetches the new tarball's sha256 (from nodejs.org SHASUMS256.txt), rewrites
// node-version.txt / tarball-sha256.txt / overlay/src/node_mobile_version.h,
// then trial-applies the whole patch series against the NEW version and
// reports which patches reject — i.e. exactly which files drifted upstream.
// The worktree it leaves behind (build/node-v<new>) is half-patched; re-run
// `prepare` to get a clean tree, and re-port rejected patches before building.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeVersion, pkgDir } from "./fetch.mjs";
import { prepare, seriesPatches } from "./prepare.mjs";

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error("usage: node scripts/bump.mjs <new-version>   e.g. 26.11.0");
  process.exit(1);
}
const oldVersion = nodeVersion();
if (newVersion === oldVersion) {
  console.log(`already pinned to ${newVersion}`);
  process.exit(0);
}

// ── fetch the new sha256 from upstream SHASUMS256.txt ──
const sums = execFileSync(
  "curl",
  ["-fsSL", `https://nodejs.org/dist/v${newVersion}/SHASUMS256.txt`],
  { encoding: "utf8" },
);
const tarballName = `node-v${newVersion}.tar.gz`;
const shaLine = sums.split("\n").find((l) => l.trim().endsWith(tarballName));
if (!shaLine) throw new Error(`${tarballName} not found in upstream SHASUMS256.txt`);
const sha256 = shaLine.trim().split(/\s+/)[0];
console.log(`[node-mobile] node ${oldVersion} → ${newVersion}`);
console.log(`[node-mobile] sha256: ${sha256}`);

// ── rewrite the pins ──
writeFileSync(join(pkgDir, "node-version.txt"), `${newVersion}\n`);
writeFileSync(join(pkgDir, "tarball-sha256.txt"), `${sha256}  ${tarballName}\n`);

const [maj, min, patch] = newVersion.split(".").map(Number);
const verH = join(pkgDir, "overlay/src/node_mobile_version.h");
writeFileSync(
  verH,
  readFileSync(verH, "utf8")
    .replace(/#define NODE_MOBILE_MAJOR_VERSION \d+/, `#define NODE_MOBILE_MAJOR_VERSION ${maj}`)
    .replace(/#define NODE_MOBILE_MINOR_VERSION \d+/, `#define NODE_MOBILE_MINOR_VERSION ${min}`)
    .replace(/#define NODE_MOBILE_PATCH_VERSION \d+/, `#define NODE_MOBILE_PATCH_VERSION ${patch}`)
    // A version bump resets the rebuild revision.
    .replace(/#define NODE_MOBILE_REVISION \d+/, `#define NODE_MOBILE_REVISION 0`),
);

// ── trial-apply the series against the new tree ──
console.log(`[node-mobile] materializing node-v${newVersion} to test patch drift…`);
let failed = [];
try {
  await prepare(); // fetches new tarball, extracts, applies all patches
  console.log(`[node-mobile] all ${seriesPatches().length} patches apply clean on ${newVersion}`);
} catch (e) {
  console.error(`\n[node-mobile] ${e.message}\n`);

  // prepare() fails on the first rejecting patch; everything after it in the
  // series is untested rather than known-bad.
  const m = /patch (\S+) does not apply/.exec(e.message);
  const series = seriesPatches();
  const failed = m ? [m[1]] : [];
  const untested = m ? series.slice(series.indexOf(m[1]) + 1) : series;
  const owned = readFileSync(join(pkgDir, "files.map"), "utf8")
    .split("\n")
    .filter((l) => failed.some((p) => l.startsWith(p)))
    .map((l) => l.split("\t")[1]);
  console.error(`[node-mobile] patches needing re-port: ${failed.join(", ") || "(unknown — prepare failed before patching)"}`);
  if (untested.length) console.error(`[node-mobile] untested this run: ${untested.join(", ")}`);
  console.error(`[node-mobile] upstream files to inspect: ${[...new Set(owned)].join(", ") || "(see patch bodies)"}`);
  console.error(`\nFix the patches under patches/ then re-run: node scripts/prepare.mjs`);
  process.exit(1);
}
