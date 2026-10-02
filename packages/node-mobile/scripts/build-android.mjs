// build-android.mjs — cross-compile libnode.so for Android.
//
//   node scripts/build-android.mjs [--arch=arm64|x86_64|all] [--sdk=<api>]
//
// Env:
//   ANDROID_NDK_HOME / ANDROID_NDK / NDK_PATH — path to the Android NDK
//   NODEJS_MOBILE_SCCACHE=1                   — route compiles through sccache
//   NODEJS_MOBILE_FLAVOR=full|lite            — build flavor (default full)
//
// Output: build/dist/android/<abi>/libnode.so plus shared libnode headers in
// build/dist/android/include/node/.

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildDir, nodeVersion } from "./fetch.mjs";
import { prepare } from "./prepare.mjs";

// Node arch → Android ABI name used for the output dir (jniLibs layout).
const ABIS = { arm64: "arm64-v8a", x86_64: "x86_64" };
// Node arch → NDK LLVM triple (for locating libc++_shared.so).
const NDK_TRIPLES = { arm64: "aarch64-linux-android", x86_64: "x86_64-linux-android" };

const args = process.argv.slice(2);
const archArg = args.find((a) => a.startsWith("--arch="))?.split("=")[1] ?? "all";
const sdk = args.find((a) => a.startsWith("--sdk="))?.split("=")[1] ?? "30";
const arches = archArg === "all" ? Object.keys(ABIS) : [archArg];

for (const a of arches) {
  if (!ABIS[a]) throw new Error(`unknown arch "${a}" — expected one of: ${Object.keys(ABIS).join(", ")}, all`);
}

const ndk =
  process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK ?? process.env.NDK_PATH;
if (!ndk || !existsSync(ndk)) {
  throw new Error(
    "Android NDK not found — set ANDROID_NDK_HOME (e.g. $ANDROID_HOME/ndk/<ver> or $ANDROID_SDK_ROOT/ndk/<ver>)",
  );
}

const treeDir = join(buildDir, `node-v${nodeVersion()}`);
if (!existsSync(join(treeDir, ".node-mobile-prepared"))) {
  console.log("[node-mobile] source tree not prepared — running prepare");
  await prepare();
}

const distDir = join(buildDir, "dist", "android");
const jobs = process.env.NODEJS_MOBILE_JOBS ?? `${(await import("node:os")).cpus().length}`;

// Host toolset: gyp builds V8's host generators with CC.host/CXX.host.
// V8 (Node 26) uses C++20 features the distro clang-18 lacks (CTAD for
// alias templates), so prefer g++ — GCC ≥10 has them — unless overridden.
const hostEnv = {
  ...process.env,
  CC_host: process.env.CC_host ?? "gcc",
  CXX_host: process.env.CXX_host ?? "g++",
  LINK_host: process.env.LINK_host ?? "g++",
};

for (const arch of arches) {
  const abi = ABIS[arch];
  console.log(`\n[node-mobile] === ${abi} (arch=${arch}, api=${sdk}) ===`);

  // Each arch needs a clean configure — out/ is shared state.
  execSync("make clean >/dev/null 2>&1 || true", { cwd: treeDir, shell: "/bin/bash" });
  execFileSync("./android-configure", [ndk, sdk, arch], { cwd: treeDir, stdio: "inherit", env: hostEnv });
  execFileSync("make", ["-j", jobs], { cwd: treeDir, stdio: "inherit", env: hostEnv });

  const candidates = [
    join(treeDir, "out/Release/lib.target/libnode.so"),
    join(treeDir, "out/Release/obj.target/libnode.so"),
    join(treeDir, "out/Release/libnode.so"),
  ];
  const so = candidates.find(existsSync);
  if (!so) throw new Error(`libnode.so not found after ${arch} build (looked in out/Release)`);

  const dest = join(distDir, abi);
  mkdirSync(dest, { recursive: true });
  cpSync(so, join(dest, "libnode.so"));

  // libc++_shared.so — libnode links the shared STL (DT_NEEDED). Stage it
  // beside libnode.so so packagers ship the STL from the *same* NDK that
  // produced the binary — a mismatched libc++ can lack symbols libnode
  // references (e.g. __hash_memory exists only in newer NDKs).
  const prebuilt = readdirSync(join(ndk, "toolchains/llvm/prebuilt"))[0];
  const cxxShared = join(ndk, "toolchains/llvm/prebuilt", prebuilt,
    "sysroot/usr/lib", NDK_TRIPLES[arch], "libc++_shared.so");
  if (existsSync(cxxShared)) cpSync(cxxShared, join(dest, "libc++_shared.so"));
  else console.warn(`[node-mobile] libc++_shared.so not found — expected at ${cxxShared}`);

  console.log(`[node-mobile] ${abi} → ${join(distDir, abi, "libnode.so")}`);
}

// Shared headers (identical across ABIs — copied once).
execFileSync("bash", ["tools/copy_libnode_headers.sh", "android"], { cwd: treeDir, stdio: "inherit" });
const hdrSrc = join(treeDir, "out_android", "libnode", "include");
if (existsSync(hdrSrc)) {
  mkdirSync(distDir, { recursive: true });
  cpSync(hdrSrc, join(distDir, "include"), { recursive: true });
}

console.log(`\n[node-mobile] done — ${distDir}`);
console.log(`  ABIs: ${arches.map((a) => ABIS[a]).join(", ")}`);
