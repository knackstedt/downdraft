// ============================================================================
// fetch-native.mjs — download native dependencies
//
// Native binaries are NOT committed to the repo — this script fetches them
// for the current platform and places them under native/ and each crate's
// dist/ dir:
//
//   downdraft-native-<plat>-<arch>.tar.gz   (our own CI-built cdylibs —
//     the unified platform lib plus the engine cdylibs) from the GitHub
//     release tagged native-v<platform-native version>
//
// Run: bun run fetch:native   (or: node native/fetch-native.mjs)
// ============================================================================

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = dirname(fileURLToPath(import.meta.url));

// Shared crate table lives in the monorepo's scripts/. When this file runs
// from an installed npm package (postinstall), only the platform crate's
// destination is known — the engine cdylibs ship inside @downdraft/engine.
let CRATES = [
  {
    pkg: "downdraft-platform",
    dest: join(nativeDir, ".."),
  },
];
try {
  ({ CRATES } = await import("../../../scripts/native-crates.mjs"));
} catch { /* published package — platform lib only */ }

function download(url, dest) {
  console.log(`  GET ${url}`);
  execSync(`curl -fSL "${url}" -o "${dest}"`, { stdio: "inherit" });
}

// Stage via temp + rename: a running dev shell has the previous .so mmap'd,
// and truncating it in place SIGBUSes the process on the next page-in.
// Rename swaps the directory entry atomically — mapped processes keep the
// old inode, new loads pick up the new file.
function stageFile(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

// ── downdraft-native artifact bundle (our own CI-built cdylibs) ──

const REPO = process.env.DD_NATIVE_REPO ?? "knackstedt/downdraft";

function fetchArtifacts() {
  const nodePlat = `${process.platform}-${process.arch}`;
  const pkg = JSON.parse(readFileSync(join(nativeDir, "..", "package.json"), "utf8"));
  const tag = `native-v${pkg.version}`;
  const url = `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/downdraft-native-${nodePlat}.tar.gz`;

  const repoRoot = resolve(nativeDir, "..", "..", "..");
  const bundleDir = join(nativeDir, `bundle-${nodePlat}`);
  const tarball = join(nativeDir, `downdraft-native-${nodePlat}.tar.gz`);

  try {
    download(url, tarball);
  } catch {
    console.warn(`  warning: no artifact bundle for ${nodePlat} on ${tag} — build locally with "bun run build:native"`);
    return;
  }

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", bundleDir], { stdio: "inherit" });

  let installed = 0;
  for (let _i = 0, _it = CRATES, _n = _it.length; _i < _n; _i++) {
    const crate = _it[_i];
    const crateDir = join(bundleDir, crate.pkg);
    if (!existsSync(crateDir)) continue;
    // dest/<nodePlat>/ — matches what build-native.mjs produces locally.
    const destDir = resolve(repoRoot, crate.dest, nodePlat);
    mkdirSync(destDir, { recursive: true });
    for (const f of readdirSync(crateDir)) {
      stageFile(join(crateDir, f), join(destDir, f));
      installed++;
    }
  }

  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(tarball, { force: true });
  console.log(`  installed ${installed} native artifact(s) for ${nodePlat}`);
}

// ── main ──

console.log("Fetching native dependencies...");
try {
  fetchArtifacts();
} catch (e) {
  console.warn(`artifact bundle fetch failed: ${e.message ?? e} — build locally with "bun run build:native"`);
}
console.log("Done. To build the Rust natives locally: bun run build:native");
