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
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = dirname(fileURLToPath(import.meta.url));

// Shared crate table lives in the monorepo's scripts/. When this file runs
// from an installed npm package (postinstall) the monorepo table isn't
// reachable — fall back to absolute dests resolved through node: the
// platform lib and its optional sidecars land in native/<plat>-<arch>/
// (what resolveNativeLibrary searches), engine cdylibs go to the resolved
// @downdraft/engine package's per-crate dist/ (what their crateDir
// resolution searches). Missing bundle entries are skipped below.
let CRATES;
try {
  ({ CRATES } = await import("../../../scripts/native-crates.mjs"));
} catch {
  CRATES = [
    { pkg: "downdraft-platform", dest: nativeDir },
    { pkg: "downdraft-controller", dest: nativeDir },
    { pkg: "downdraft-secrets", dest: nativeDir },
  ];
  try {
    const req = createRequire(import.meta.url);
    const engineRoot = dirname(req.resolve("@downdraft/engine/package.json"));
    const lib = (...p) => join(engineRoot, "libraries", ...p, "dist");
    CRATES.push(
      { pkg: "downdraft-physics", dest: lib("physics-native", "native") },
      { pkg: "downdraft-blitz-osr", dest: lib("blitz-ui", "native-osr") },
      { pkg: "downdraft-audio", dest: lib("audio-kira", "native") },
      { pkg: "downdraft-webui-cef", dest: lib("webui", "native-cef") },
      { pkg: "downdraft-webui-wpe", dest: lib("webui", "native-wpe") },
    );
  } catch { /* @downdraft/engine not installed — platform libs only */ }
}

function download(url, dest) {
  console.log(`  GET ${url}`);
  execSync(`curl -fSL "${url}" -o "${dest}"`, { stdio: "inherit" });
}

// The cdylibs in the bundle run in-process with full access — verify the
// tarball against the .sha256 published alongside it by the native.yml
// workflow. Mismatch = hard fail; missing checksum file = loud warning
// (older releases predate checksum publication).
function verifySha256(tarball, shaUrl) {
  const shaFile = `${tarball}.sha256`;
  try {
    download(shaUrl, shaFile);
  } catch {
    console.warn(`  warning: no checksum published at ${shaUrl} — bundle integrity unverified`);
    return;
  }
  const expected = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  rmSync(shaFile, { force: true });
  if (actual !== expected) {
    rmSync(tarball, { force: true });
    throw new Error(
      `sha256 mismatch for ${tarball}\n  expected: ${expected}\n  actual:   ${actual}\n` +
      `  The bundle may be corrupt or tampered with — refusing to install.`,
    );
  }
  console.log(`  sha256 verified: ${actual}`);
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

  // Integrity failure is fatal — never fall back to installing an
  // unverifiable or mismatched bundle.
  verifySha256(tarball, `${url}.sha256`);

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
  // Non-zero exit: a checksum mismatch or corrupt bundle must not silently
  // degrade to "skipped" — the cdylibs run in-process with full access.
  console.error(`artifact bundle fetch failed: ${e.message ?? e}`);
  process.exitCode = 1;
}
console.log("Done. To build the Rust natives locally: bun run build:native");
