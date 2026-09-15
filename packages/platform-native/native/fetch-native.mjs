// ============================================================================
// fetch-native.mjs — download native dependencies (wgpu-native, tint)
//
// Native binaries are NOT committed to the repo — this script fetches them
// for the current platform and places them under native/:
//
//   native/lib/libwgpu_native.so   (+ .a, headers land under native/include)
//   native/bin/tint                (WGSL validator, used by packages/app)
//
// The pinned wgpu-native version is read from
// native/wgpu-native-meta/wgpu-native-git-tag. Tint comes from
// eliemichel/dawn-prebuilt (same source as app/src/vite/tint-binary.ts).
//
// Run: bun run fetch:native   (or: node native/fetch-native.mjs)
// ============================================================================

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = dirname(fileURLToPath(import.meta.url));
const metaDir = join(nativeDir, "wgpu-native-meta");
const libDir = join(nativeDir, "lib");
const binDir = join(nativeDir, "bin");
const includeDir = join(nativeDir, "include");

function platformTag() {
  const p = process.platform;
  const a = process.arch;
  if (p === "linux" && a === "x64") return "linux-x86_64";
  if (p === "linux" && a === "arm64") return "linux-aarch64";
  if (p === "darwin" && a === "arm64") return "macos-aarch64";
  if (p === "darwin" && a === "x64") return "macos-x86_64";
  if (p === "win32" && a === "x64") return "windows-x86_64";
  return null;
}

function tintPlatformTag() {
  const p = process.platform;
  const a = process.arch;
  if (p === "linux" && a === "x64") return "linux-x64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  if (p === "darwin" && a === "arm64") return "macos-aarch64";
  if (p === "darwin" && a === "x64") return "macos-x64";
  if (p === "win32" && a === "x64") return "windows-x64";
  return null;
}

function download(url, dest) {
  console.log(`  GET ${url}`);
  execSync(`curl -fSL "${url}" -o "${dest}"`, { stdio: "inherit" });
}

function unzip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execSync(`powershell -Command "Expand-Archive -Force '${zipPath}' '${destDir}'"`, { stdio: "inherit" });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  }
}

/** Recursively find a file by exact name. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry === name) {
      return full;
    }
  }
  return null;
}

// ── wgpu-native ──

function fetchWgpuNative() {
  const tag = readFileSync(join(metaDir, "wgpu-native-git-tag"), "utf8").trim();
  const plat = platformTag();
  if (!plat) throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);

  const libName = process.platform === "win32" ? "wgpu_native.dll" : process.platform === "darwin" ? "libwgpu_native.dylib" : "libwgpu_native.so";
  const staticName = process.platform === "win32" ? "wgpu_native.lib" : "libwgpu_native.a";
  if (existsSync(join(libDir, libName)) && existsSync(join(includeDir, "webgpu", "wgpu.h"))) {
    console.log(`wgpu-native already present (${libName}) — skipping. Delete native/lib to re-fetch.`);
    return;
  }

  const url = `https://github.com/gfx-rs/wgpu-native/releases/download/${encodeURIComponent(tag)}/wgpu-${plat}-release.zip`;
  const zipPath = join(nativeDir, "wgpu-download.zip");
  const extractDir = join(nativeDir, "wgpu-extract");

  download(url, zipPath);
  unzip(zipPath, extractDir);

  mkdirSync(libDir, { recursive: true });
  mkdirSync(join(includeDir, "webgpu"), { recursive: true });

  for (const [name, dest] of [
    [libName, join(libDir, libName)],
    [staticName, join(libDir, staticName)],
    ["webgpu.h", join(includeDir, "webgpu", "webgpu.h")],
    ["wgpu.h", join(includeDir, "webgpu", "wgpu.h")],
  ]) {
    const found = findFile(extractDir, name);
    if (found) {
      renameSync(found, dest);
      console.log(`  installed ${name}`);
    } else {
      console.warn(`  warning: ${name} not found in archive`);
    }
  }

  execSync(`rm -rf "${extractDir}" "${zipPath}"`, { stdio: "ignore" });
}

// ── tint ──

const TINT_RELEASE_TAG = "tint/7213";

function fetchTint() {
  const plat = tintPlatformTag();
  if (!plat) {
    console.warn(`  warning: no prebuilt tint for ${process.platform}-${process.arch} — skipping`);
    return;
  }
  const binName = process.platform === "win32" ? "tint.exe" : "tint";
  if (existsSync(join(binDir, binName))) {
    console.log("tint already present — skipping.");
    return;
  }

  const url = `https://github.com/eliemichel/dawn-prebuilt/releases/download/${encodeURIComponent(TINT_RELEASE_TAG)}/Tint-7213-${plat}-Release.zip`;
  const zipPath = join(nativeDir, "tint-download.zip");
  const extractDir = join(nativeDir, "tint-extract");

  download(url, zipPath);
  unzip(zipPath, extractDir);

  mkdirSync(binDir, { recursive: true });
  const found = findFile(extractDir, binName);
  if (!found) throw new Error("tint binary not found in archive");
  renameSync(found, join(binDir, binName));
  if (process.platform !== "win32") {
    execSync(`chmod +x "${join(binDir, binName)}"`, { stdio: "ignore" });
  }
  console.log(`  installed ${binName}`);

  execSync(`rm -rf "${extractDir}" "${zipPath}"`, { stdio: "ignore" });
}

// ── main ──

console.log("Fetching native dependencies...");
try {
  fetchWgpuNative();
} catch (e) {
  console.error(`wgpu-native fetch failed: ${e.message ?? e}`);
  process.exitCode = 1;
}
try {
  fetchTint();
} catch (e) {
  console.error(`tint fetch failed: ${e.message ?? e}`);
  process.exitCode = 1;
}
console.log("Done. Shim libraries (lib*_shim) are built from source via: bun run build:shims");
