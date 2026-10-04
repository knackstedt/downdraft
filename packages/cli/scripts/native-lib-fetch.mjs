// ============================================================================
// native-lib-fetch.mjs — fetch @downdraft/native-<plat>-<arch> lib dirs
//
// The per-platform binary packages are published to npm as optional deps of
// @downdraft/platform-native, but npm/bun/deno skip installing packages whose
// os/cpu don't match the host — so cross-packaging (--target=win from linux,
// etc.) has no local copy of the target's cdylibs. The tarballs are still on
// the registry though; this fetches and caches them under
// <cacheRoot>/downdraft-native/<plat>-<arch>/lib.
// ============================================================================

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Return a dir containing the target platform's cdylibs — the first existing
 * candidate, else the @downdraft/native-<platKey> npm tarball fetched into
 * the cache. Returns null when nothing is available.
 *
 * @param {string} platKey e.g. "win32-x64", "darwin-arm64"
 * @param {string[]} candidates existing dirs to try before fetching
 * @param {string} cacheRoot parent dir for the fetch cache
 * @param {string|null} version preferred package version (platform-native's,
 *   lockstep) — falls back to the registry's latest tag
 */
export async function resolvePlatLibDir(platKey, candidates, cacheRoot, version) {
  const hit = candidates.find((d) => d && existsSync(d));
  if (hit) return hit;

  const pkgName = `@downdraft/native-${platKey}`;
  const cacheDir = join(cacheRoot, "downdraft-native", platKey, "lib");
  if (existsSync(cacheDir) && readdirSync(cacheDir).length > 0) return cacheDir;

  try {
    const meta = await (await fetch(
      `https://registry.npmjs.org/${pkgName.replace("/", "%2F")}`)).json();
    const ver = meta?.versions?.[version] ? version : meta?.["dist-tags"]?.latest;
    const tarball = ver && meta.versions[ver]?.dist?.tarball;
    if (!tarball) return null;

    const tmp = mkdtempSync(join(tmpdir(), "dd-native-"));
    try {
      const tgz = join(tmp, "pkg.tgz");
      writeFileSync(tgz, Buffer.from(await (await fetch(tarball)).arrayBuffer()));
      execFileSync("tar", ["-xzf", tgz, "-C", tmp], { stdio: "pipe" });
      const libDir = join(tmp, "package", "lib");
      if (!existsSync(libDir) || readdirSync(libDir).length === 0) return null;
      rmSync(dirname(cacheDir), { recursive: true, force: true });
      mkdirSync(dirname(cacheDir), { recursive: true });
      // cpSync not renameSync: TMPDIR may be a different filesystem.
      cpSync(libDir, cacheDir, { recursive: true });
      console.log(`[package] fetched ${pkgName}@${ver} from npm → ${cacheDir}`);
      return cacheDir;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn(`[package] ${pkgName} fetch failed: ${e?.message ?? e}`);
    return null;
  }
}
