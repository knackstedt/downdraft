// fetch.mjs — download the pinned upstream Node tarball into build/ and
// verify it against tarball-sha256.txt. Safe to re-run; existing archives are
// re-verified rather than re-downloaded.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const buildDir = join(pkgDir, "build");

export function nodeVersion() {
  return readFileSync(join(pkgDir, "node-version.txt"), "utf8").trim();
}

export function tarballInfo(version = nodeVersion()) {
  const name = `node-v${version}.tar.gz`;
  const line = readFileSync(join(pkgDir, "tarball-sha256.txt"), "utf8").trim();
  const [sha256, file] = line.split(/\s+/);
  if (file !== name) {
    throw new Error(
      `tarball-sha256.txt lists "${file}" but node-version.txt pins ${name} — run scripts/bump.mjs to update both`,
    );
  }
  return { name, sha256, url: `https://nodejs.org/dist/v${version}/${name}`, dest: join(buildDir, name) };
}

export async function verifySha256(path, expected) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) hash.update(chunk);
  });
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${path}\n  expected ${expected}\n  actual   ${actual}`);
  }
  return true;
}

export async function fetchTarball() {
  const info = tarballInfo();
  mkdirSync(buildDir, { recursive: true });
  if (!existsSync(info.dest)) {
    console.log(`[node-mobile] downloading ${info.url}`);
    const r = spawnSync("curl", ["-fSL", info.url, "-o", info.dest], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`curl failed (${r.status}) for ${info.url}`);
  } else {
    console.log(`[node-mobile] archive cached: ${info.dest}`);
  }
  await verifySha256(info.dest, info.sha256);
  console.log(`[node-mobile] sha256 verified: ${info.sha256.slice(0, 16)}…`);
  return info.dest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fetchTarball();
}
