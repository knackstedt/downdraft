// smoke.mjs — structural verification of the materialized tree and built
// artifacts. This does not execute Android binaries (no device here); it
// proves the overlay landed and, when artifacts exist, that they are sane.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildDir, nodeVersion } from "./fetch.mjs";

const treeDir = join(buildDir, `node-v${nodeVersion()}`);
let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

console.log(`[node-mobile] smoke — node-v${nodeVersion()}`);

// ── materialized tree ──
const treePrepared = existsSync(join(treeDir, ".node-mobile-prepared"));
check(`materialized tree present (${treeDir})`, treePrepared);

if (treePrepared) {
  const read = (p) => readFileSync(join(treeDir, p), "utf8");
  check("NODE_MOBILE define in node.gypi", read("node.gypi").includes("NODE_MOBILE"));
  check(
    "mobile version key in node_metadata.h",
    read("src/node_metadata.h").includes("NODE_VERSIONS_KEY_MOBILE"),
  );
  check(
    "trap handler disabled everywhere",
    read("deps/v8/src/trap-handler/trap-handler.h").includes(
      "#define V8_TRAP_HANDLER_SUPPORTED false",
    ) && !read("deps/v8/src/trap-handler/trap-handler.h").includes("V8_TRAP_HANDLER_VIA_SIMULATOR"),
  );
  check(
    "overlay: node_mobile_version.h",
    read("src/node_mobile_version.h").includes("NODE_MOBILE_REVISION"),
  );
  check(
    "overlay: tools/android_build.sh",
    existsSync(join(treeDir, "tools/android_build.sh")),
  );
  check(
    "android_configure.py rewritten (sccache/flavor)",
    read("android_configure.py").includes("NODEJS_MOBILE_FLAVOR"),
  );
  check(
    "orphaned upstream android patch removed",
    !existsSync(join(treeDir, "android-patches/trap-handler.h.patch")),
  );
  check(
    "ndk_cpufeatures gyp target",
    read("tools/v8_gypfiles/v8.gyp").includes("ndk_cpufeatures"),
  );
  check(
    "android credential guard",
    read("src/node_credentials.cc").match(/__ANDROID__|NODE_MOBILE/) !== null,
  );
  check(
    "atomic-ref shim header",
    existsSync(join(treeDir, "deps/v8/include/atomic-ref-shim.h")),
  );
  check(
    "simdutf atomic-ref include",
    read("deps/v8/third_party/simdutf/simdutf.h").includes("atomic-ref-shim.h"),
  );
}

// ── built artifacts (if present) ──
const distDir = join(buildDir, "dist", "android");
if (existsSync(distDir)) {
  for (const abi of ["arm64-v8a", "x86_64"].values()) {
    const so = join(distDir, abi, "libnode.so");
    if (!existsSync(so)) continue;
    const size = statSync(so).size;
    check(`${abi}/libnode.so present (${(size / 1e6).toFixed(1)} MB)`, size > 1e6);
    const elf = execFileSync("head", ["-c", "4", so], { encoding: "latin1" });
    check(`${abi}/libnode.so is ELF`, elf === "\x7fELF");
    // 16KB page-size compat: LOAD segments must be p_align=16384-aligned.
    // readelf -lW | check max alignment — accept anything >= 2**14.
    const r = execFileSync("readelf", ["-lW", so], { encoding: "utf8" });
    const aligns = [...r.matchAll(/LOAD.*0x([0-9a-f]+)\s*$/gm)].map((m) => parseInt(m[1], 16));
    const maxAlign = Math.max(0, ...aligns);
    check(`${abi} LOAD alignment 0x${maxAlign.toString(16)} (16KB pages)`, maxAlign >= 0x4000);
  }
  check("libnode headers staged", existsSync(join(distDir, "include", "node", "node.h")));
} else {
  console.log("  (no build/dist/android — skipping artifact checks)");
}

if (failures) {
  console.error(`\n[node-mobile] smoke FAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log("\n[node-mobile] smoke passed");
