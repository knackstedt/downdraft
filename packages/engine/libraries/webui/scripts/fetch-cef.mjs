#!/usr/bin/env node
// ============================================================================
// fetch-cef.mjs — fetch the pinned CEF binary distribution into
// libraries/webui/vendor/cef/<ver>/cef_<os>_<arch>/ for the native-cef crate.
//
//   bun fetch-cef.mjs                      # host platform, pinned version
//   bun fetch-cef.mjs --plat=linux-x64     # explicit platform
//   bun fetch-cef.mjs --cef-version=…      # override the pin
//
// The pinned version MUST match the `cef` crate dep in native-cef — the
// crate's build dep `cef-dll-sys` resolves CEF via CEF_PATH and requires
//   <CEF_PATH>/<cefVer>/cef_<os>_<arch>/   (merged Release+Resources tree)
//   <dir>/archive.json                   ({"type","name","sha1"} — the
//                                          minimal archive's index entry)
// Keep CEF_PIN synced with Cargo.toml's `cef = "x.y.z+x.y.z"` metadata
// version; mismatch = ABI breaks or a second build-time download.
//
// Output layout (native-cef/build.rs CEF_PATH + build-native staging probe):
//   vendor/cef/<ver>/cef_linux_x86_64/libcef.so (+ subprocess resources)
//   vendor/cef/<ver>/cef_linux_x86_64/include/  — C API headers
//   vendor/cef/<ver>/cef_linux_x86_64/locales/
//   vendor/cef/<ver>/cef_linux_x86_64/archive.json
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Pinned CEF build ──
// Must equal the `+…` metadata of the `cef`/`cef-dll-sys` crate version in
// native-cef/Cargo.toml (154.5.0+154.0.34 → CEF 154.0.34).
const CEF_PIN = "154.0.34";

const PLATMAP = {
  "linux-x64": ["linux64", "cef_linux_x86_64"],
  "linux-arm64": ["linuxarm64", "cef_linux_aarch64"],
  "win32-x64": ["windows64", "cef_windows_x86_64"],
  "win32-arm64": ["windowsarm64", "cef_windows_aarch64"],
  "darwin-x64": ["macosx64", "cef_macos_x86_64"],
  "darwin-arm64": ["macosarm64", "cef_macos_aarch64"],
};

const args = process.argv.slice(2);
const argVal = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const hostPlat = `${process.platform}-${process.arch}`;
const plat = argVal("plat") ?? hostPlat;
const cefVer = argVal("cef-version") ?? process.env.DD_CEF_VERSION ?? CEF_PIN;

const [cefPlat, cefDirName] = PLATMAP[plat] ?? [];
if (!cefPlat) {
  console.error(`[fetch-cef] no CEF build for platform "${plat}" — known: ${Object.keys(PLATMAP).join(", ")}`);
  process.exit(1);
}

const vendorDir = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const destDir = join(vendorDir, "cef", cefVer, cefDirName);
const CDN = process.env.CEF_DOWNLOAD_URL ?? "https://cef-builds.spotifycdn.com";

if (existsSync(join(destDir, "archive.json")) && existsSync(join(destDir, "include"))) {
  console.log(`[fetch-cef] ${destDir} already staged — delete to refetch`);
  process.exit(0);
}

mkdirSync(vendorDir, { recursive: true });

// ── Resolve the artifact from the CDN index (name embeds the git hash) ──
function fetchJson(u) {
  return new Promise((resolve, reject) => {
    get(u, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      }
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

console.log(`[fetch-cef] resolving ${cefVer} (${cefPlat}) from ${CDN}/index.json`);
const index = await fetchJson(`${CDN}/index.json`);
const entry = index[cefPlat]?.versions?.find((v) =>
  v.cef_version === cefVer || v.cef_version?.startsWith(`${cefVer}+`),
);
const file = entry?.files?.find((f) => f.type === "minimal");
if (!file) {
  console.error(`[fetch-cef] no minimal archive for ${cefVer} on ${cefPlat} — check the pin`);
  process.exit(1);
}
console.log(`[fetch-cef] ${file.name} (${(file.size / 1e6).toFixed(0)} MB)`);

// ── Download (redirect-following) + sha1 verify ──
function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      }
      const f = createWriteStream(dest);
      const hash = createHash("sha1");
      res.on("data", (c) => hash.update(c));
      res.pipe(f);
      f.on("finish", () => f.close(() => resolve(hash.digest("hex"))));
      f.on("error", reject);
    }).on("error", reject);
  });
}

const archive = join(vendorDir, file.name);
if (!existsSync(archive)) {
  const sha = await download(`${CDN}/${encodeURIComponent(file.name)}`, archive);
  if (sha !== file.sha1) {
    rmSync(archive, { force: true });
    console.error(`[fetch-cef] sha1 mismatch: got ${sha}, want ${file.sha1}`);
    process.exit(1);
  }
  console.log(`[fetch-cef] downloaded sha1=${sha}`);
} else {
  console.log(`[fetch-cef] using cached ${archive}`);
}

// ── Extract, then rearrange to the cef-dll-sys layout ──
//   <inner>/Release/* + <inner>/Resources/* + CMakeLists.txt + cmake/ +
//   include/ + libcef_dll/ + CREDITS.html  →  cef_<os>_<arch>/
const tmpExtract = join(vendorDir, `.cef-extract-${process.pid}`);
rmSync(tmpExtract, { recursive: true, force: true });
mkdirSync(tmpExtract, { recursive: true });
const r = spawnSync("tar", ["-xjf", archive, "-C", tmpExtract], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("[fetch-cef] tar extract failed — is bzip2 available?");
  process.exit(r.status ?? 1);
}

const inner = readdirSync(tmpExtract).find((d) => d.startsWith("cef_binary_"));
if (!inner) {
  console.error("[fetch-cef] unexpected archive layout");
  process.exit(1);
}
const innerDir = join(tmpExtract, inner);

rmSync(destDir, { recursive: true, force: true });
mkdirSync(dirname(destDir), { recursive: true });
mkdirSync(destDir, { recursive: true });
const move = (src, dst) => renameSync(src, dst);
for (const merged of ["Release", "Resources"]) {
  const from = join(innerDir, merged);
  if (existsSync(from)) {
    for (const entry of readdirSync(from)) move(join(from, entry), join(destDir, entry));
  }
}
for (const extra of ["CMakeLists.txt", "cmake", "include", "libcef_dll", "CREDITS.html"]) {
  const from = join(innerDir, extra);
  if (existsSync(from)) move(from, join(destDir, extra));
}
rmSync(tmpExtract, { recursive: true, force: true });

// archive.json — the marker cef-dll-sys's check_archive_json reads
// (name must start "cef_binary_<ver>" so its version regex matches).
writeFileSync(
  join(destDir, "archive.json"),
  JSON.stringify({ type: "minimal", name: file.name, sha1: file.sha1 }, null, 2) + "\n",
);

for (const want of ["include", "locales"]) {
  if (!existsSync(join(destDir, want))) {
    console.warn(`[fetch-cef] WARNING: ${want}/ missing in ${destDir}`);
  }
}
console.log(`[fetch-cef] staged → ${destDir}`);
console.log(`[fetch-cef] build with CEF_PATH=${join(vendorDir, "cef")} — bun run build:native --pkg=downdraft-webui-cef`);
