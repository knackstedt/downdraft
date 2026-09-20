// Copies the compiled cdylib to the napi-style filename the host searches for
// (e.g. libdowndraft_raw_input.so → index.linux-x64-gnu.node).
import { copyFileSync } from "node:fs";
import { join } from "node:path";

const tripleMap = {
  linux: { x64: "linux-x64-gnu", arm64: "linux-arm64-gnu" },
  darwin: { x64: "darwin-x64", arm64: "darwin-arm64" },
  win32: { x64: "win32-x64-msvc", arm64: "win32-arm64-msvc" },
};
const libName = {
  linux: "libdowndraft_raw_input.so",
  darwin: "libdowndraft_raw_input.dylib",
  win32: "downdraft_raw_input.dll",
};

const triple = tripleMap[process.platform]?.[process.arch];
const lib = libName[process.platform];
if (!triple || !lib) {
  console.error(`[raw-input] Unsupported platform: ${process.platform}/${process.arch}`);
  process.exit(1);
}
const src = join("target", "release", lib);
const dst = `index.${triple}.node`;
copyFileSync(src, dst);
console.log(`[raw-input] Built ${dst}`);
