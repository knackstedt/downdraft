// ============================================================================
// stage-node-packages.mjs — populate the npm node-mobile packages
// (@downdraft/native-mobile-android-<arch>) from artifact bundles.
//
// Usage: node scripts/stage-node-packages.mjs <dir-of-tarballs>
//
// Unpacks each downdraft-node-mobile-android-<arch>.tar.gz into
// packages/native-mobile-android-<arch>/{lib,include}/. Called by publish.yml
// before scripts/publish-packages.mjs.
//
// Bundle layout (produced by packages/node-mobile/scripts/package-android.mjs
// / the node-mobile.yml workflow):
//   libnode.so          → lib/libnode.so
//   include/node/*.h    → include/node/*.h
// ============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = process.argv[2];
if (!srcDir || !existsSync(srcDir)) {
  console.error("usage: node scripts/stage-node-packages.mjs <dir containing downdraft-node-mobile-*.tar.gz>");
  process.exit(1);
}

const tarballs = readdirSync(srcDir).filter((f) => /^downdraft-node-mobile-android-.+\.tar\.gz$/.test(f));
if (!tarballs.length) {
  console.error(`no downdraft-node-mobile-android-*.tar.gz found in ${srcDir}`);
  process.exit(1);
}

for (const tarball of tarballs.values()) {
  const arch = tarball.slice("downdraft-node-mobile-android-".length, -".tar.gz".length);
  const pkgDir = join(root, "packages", `native-mobile-android-${arch}`);
  if (!existsSync(join(pkgDir, "package.json"))) {
    console.error(`[stage] no packages/native-mobile-android-${arch} — unknown bundle arch`);
    process.exit(1);
  }

  const extractDir = join(pkgDir, ".staging");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", join(srcDir, tarball), "-C", extractDir], { stdio: "inherit" });

  const libDir = join(pkgDir, "lib");
  const incDir = join(pkgDir, "include");
  rmSync(libDir, { recursive: true, force: true });
  rmSync(incDir, { recursive: true, force: true });
  mkdirSync(libDir, { recursive: true });

  // Bundle layout: <abi>/libnode.so + include/node/*.h
  const abiDir = readdirSync(extractDir).find((d) => {
    return existsSync(join(extractDir, d, "libnode.so"));
  });
  if (!abiDir) {
    console.error(`[stage] ${tarball}: no libnode.so found at bundle root`);
    process.exit(1);
  }
  execFileSync("cp", [join(extractDir, abiDir, "libnode.so"), join(libDir, "libnode.so")]);
  // libc++_shared.so ships beside libnode — same-NDK pairing matters.
  const cxxShared = join(extractDir, abiDir, "libc++_shared.so");
  if (existsSync(cxxShared)) execFileSync("cp", [cxxShared, join(libDir, "libc++_shared.so")]);
  const incSrc = join(extractDir, "include");
  if (existsSync(incSrc)) {
    execFileSync("cp", ["-r", incSrc, join(pkgDir, "include")]);
  }
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[stage] @downdraft/native-mobile-android-${arch}: lib/libnode.so + include/`);
}

console.log("[stage] node-mobile packages staged");
