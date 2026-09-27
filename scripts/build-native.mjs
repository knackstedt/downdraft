// ============================================================================
// build-native.mjs — build all Rust cdylibs in the root Cargo workspace and
// stage the artifacts where the runtime library finders look for them.
//
// Replaces the per-crate `native/build.sh` scripts and the old C `gcc` shim
// builds.
//
// Usage:
//   node scripts/build-native.mjs                     # all libs, host, release
//   node scripts/build-native.mjs --debug
//   node scripts/build-native.mjs --profile=dist      # CI artifact builds
//   node scripts/build-native.mjs --target=x86_64-pc-windows-msvc
//   node scripts/build-native.mjs --pkg=downdraft-platform --pkg=downdraft-physics
//
// Output layout (what the TS library finders search):
//   <crateDir>/dist/<platform>-<arch>/<lib>          (explicit --target builds)
//   <crateDir>/dist/<lib>                            (host builds, flat copy)
// platform-native additionally stages into native/<platform>-<arch>/ — the
// fetch-at-install layout already searched by lib-paths.ts.
// ============================================================================

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CRATES, libFileName, NODE_TO_RUST, RUST_TO_NODE } from "./native-crates.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return out.match(/^host:\s*(\S+)/m)[1];
}

// ── args ──

const args = process.argv.slice(2);
const argVal = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

let profile = "release";
if (args.includes("--debug")) profile = "debug";
if (argVal("profile")) profile = argVal("profile");
if (!["debug", "release", "dist"].includes(profile)) {
  console.error(`unknown profile "${profile}" — use debug|release|dist`);
  process.exit(1);
}
// cargo names the dev profile "dev" but still writes to target/<t>/debug/.
const cargoProfile = profile === "debug" ? "dev" : profile;
const profileDir = profile === "debug" ? "debug" : profile;

const host = hostTriple();
const targets =
  argVal("target") === "all"
    ? Object.values(NODE_TO_RUST)
    : [argVal("target") ?? host];

const pkgFilter = args.filter((a) => a.startsWith("--pkg=")).map((a) => a.split("=")[1]);
const crates = pkgFilter.length ? CRATES.filter((c) => pkgFilter.includes(c.pkg) || pkgFilter.includes(c.lib)) : CRATES;
if (!crates.length) {
  console.error(`no crates matched ${pkgFilter.join(", ")} — known: ${CRATES.map((c) => c.pkg).join(", ")}`);
  process.exit(1);
}

// ── build ──

for (let _i = 0, _it = targets, _n = _it.length; _i < _n; _i++) {
  const target = _it[_i];
  const nodePlat = RUST_TO_NODE[target];
  if (!nodePlat) {
    console.warn(`[build-native] no node-triple mapping for ${target} — skipping staging`);
  }
  const cargoArgs = [
    "build",
    `--profile=${cargoProfile}`,
    `--target=${target}`,
    ...crates.flatMap((c) => ["-p", c.pkg]),
  ];
  console.log(`[build-native] cargo ${cargoArgs.join(" ")}`);
  const r = spawnSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);

  if (!nodePlat) continue;

  for (let _j = 0, _jt = crates, _m = _jt.length; _j < _m; _j++) {
    const crate = _jt[_j];
    const file = libFileName(crate.lib, nodePlat);
    const src = join(root, "target", target, profileDir, file);
    if (!existsSync(src)) {
      console.error(`[build-native] expected artifact missing: ${src}`);
      process.exit(1);
    }
    const destRoot = join(root, crate.dest);
    const platDir = join(destRoot, nodePlat);
    mkdirSync(platDir, { recursive: true });
    copyFileSync(src, join(platDir, file));
    if (crate.flatCopy && target === host) {
      copyFileSync(src, join(destRoot, file));
    }
    console.log(`[build-native] staged ${file} → ${platDir}${crate.flatCopy && target === host ? ` (+ ${destRoot})` : ""}`);
  }
}

console.log("[build-native] done.");
