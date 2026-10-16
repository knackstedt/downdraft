// ============================================================================
// make-native-bundle.mjs — assemble downdraft-native-<platform>-<arch>.tar.gz
// bundles from staged native artifacts (built by build-native.mjs).
//
// Usage: node scripts/make-native-bundle.mjs [linux-x64 darwin-arm64 ...]
//        (defaults to the host platform)
//
// Bundle layout:
//   downdraft-platform/libdowndraft_platform.so   (etc. per crate)
//   downdraft-physics/libdowndraft_physics.so
//   ...
//
// fetch-native.mjs unpacks crate dirs back into each crate's staged
// location; stage-native-packages.mjs flattens them into the npm
// @downdraft/native-* packages.
// ============================================================================

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRATES, libFileName } from "./native-crates.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const nodePlats = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [`${process.platform}-${process.arch}`];

const artifactsDir = join(root, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

for (let _i = 0, _it = nodePlats, _n = _it.length; _i < _n; _i++) {
  const nodePlat = _it[_i];
  const staging = join(artifactsDir, `bundle-${nodePlat}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let count = 0;
  for (let _j = 0, _jt = CRATES, _m = _jt.length; _j < _m; _j++) {
    const crate = _jt[_j];
    const file = libFileName(crate.lib, nodePlat);
    const src = join(root, crate.dest, nodePlat, file);
    if (!existsSync(src)) {
      console.warn(`[bundle] skipping missing artifact: ${src}`);
      continue;
    }
    const destDir = join(staging, crate.pkg);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, file));
    count++;
    // Companion binaries (e.g. the CEF render-process helper) — build-native
    // stages them next to the lib; the bundle must carry them too.
    (crate.bins ?? []).forEach((bin) => {
      const binFile = nodePlat.startsWith("win32") ? `${bin}.exe` : bin;
      const binSrc = join(root, crate.dest, nodePlat, binFile);
      if (!existsSync(binSrc)) {
        console.warn(`[bundle] skipping missing bin artifact: ${binSrc}`);
        return;
      }
      copyFileSync(binSrc, join(destDir, binFile));
    });
  }


  if (!count) {
    console.error(`[bundle] no artifacts staged for ${nodePlat} — run build-native.mjs first`);
    process.exit(1);
  }

  const tarball = join(artifactsDir, `downdraft-native-${nodePlat}.tar.gz`);
  rmSync(tarball, { force: true });
  execFileSync("tar", ["-czf", tarball, "-C", staging, "."], { stdio: "inherit" });
  // Publish a sha256sum-compatible checksum beside the tarball — fetch-native.mjs
  // and publish.yml verify downloads against it.
  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${sha}  ${basename(tarball)}\n`);
  rmSync(staging, { recursive: true, force: true });
  console.log(`[bundle] ${tarball} (${count} libs) sha256=${sha}`);
}
