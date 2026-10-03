// ============================================================================
// stage-native-packages.mjs — populate the npm platform packages
// (@downdraft/native-<platform>-<arch>) from artifact bundles.
//
// Usage: node scripts/stage-native-packages.mjs <dir-of-tarballs>
//
// Unpacks each downdraft-native-<plat>-<arch>.tar.gz into
// packages/native-<plat>-<arch>/lib/ (flattened — every cdylib from every
// crate lands in one lib/ dir, matching the resolver's search path).
// Called by publish.yml before scripts/publish-packages.mjs.
// ============================================================================

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = process.argv[2];
if (!srcDir || !existsSync(srcDir)) {
  console.error("usage: node scripts/stage-native-packages.mjs <dir containing downdraft-native-*.tar.gz>");
  process.exit(1);
}

const tarballs = readdirSync(srcDir).filter((f) => /^downdraft-native-.+\.tar\.gz$/.test(f));
if (!tarballs.length) {
  console.error(`no downdraft-native-*.tar.gz found in ${srcDir}`);
  process.exit(1);
}

for (let _i = 0, _it = tarballs, _n = _it.length; _i < _n; _i++) {
  const tarball = _it[_i];
  const nodePlat = tarball.slice("downdraft-native-".length, -".tar.gz".length);
  const pkgDir = join(root, "packages", `native-${nodePlat}`);
  if (!existsSync(join(pkgDir, "package.json"))) {
    console.error(`[stage] no packages/native-${nodePlat} — unknown bundle platform`);
    process.exit(1);
  }

  const extractDir = join(pkgDir, ".staging");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", join(srcDir, tarball), "-C", extractDir], { stdio: "inherit" });

  const libDir = join(pkgDir, "lib");
  rmSync(libDir, { recursive: true, force: true });
  mkdirSync(libDir, { recursive: true });

  let count = 0;
  // Bundle layout: <crate-pkg>/<libfile> — flatten all crates into lib/.
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(so|dylib|dll)$/.test(e.name)) {
        cpSync(p, join(libDir, e.name));
        count++;
      }
    }
  };
  walk(extractDir);
  rmSync(extractDir, { recursive: true, force: true });
  console.log(`[stage] ${tarball} → packages/native-${nodePlat}/lib/ (${count} libs)`);
}
