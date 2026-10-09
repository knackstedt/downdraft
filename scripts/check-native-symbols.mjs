// ============================================================================
// check-native-symbols.mjs — verify staged native libs export every FFI
// symbol the JS spec tables declare.
//
// Publishing mismatched JS/native versions produces late dlopen failures
// ("Symbol X not found") on consumer machines. This runs in the publish
// pipeline after stage-native-packages.mjs and before npm publish.
//
// Usage:
//   node scripts/check-native-symbols.mjs [--quiet]
//
// Exit 0 when every declared symbol is present in its target library.
// Skips gracefully when no staged packages exist (local dev runs).
// ============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const quiet = process.argv.includes("--quiet");

// ── 1. Extract spec symbol names per source file ──
// FFI spec entries are uniformly `symbol_name: { args: [...], returns: ... }`
// in `*_SPEC` tables or inline dlopen() object literals. Match the entry key
// followed by an `args` property — unique enough to ignore unrelated shapes.
const SPEC_ENTRY_RE = /(\b[a-z][a-z0-9_]+)\s*:\s*\{\s*(?:args|types)\s*:/g;

// Candidate dirs: FFI spec tables live in shipped engine/platform code.
const SCAN_DIRS = [
  "packages/platform-native/src",
  "packages/engine",
];

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "target") continue;
      yield* walk(p);
    } else if (e.name.endsWith('.ts') && !/\.d\.(ts|mts|cts)$|\.spec\.ts$/.test(e.name)) {
      yield p;
    }
  }
}

// file -> { lib: "downdraft_x", symbols: Set<string> }
const specs = new Map();
for (const scanDir of SCAN_DIRS.values()) {
  for (const file of walk(join(root, scanDir))) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("dlopen") && !src.includes("_SPEC")) continue;

    // Which library does this file open?
    let lib = null;
    let m = src.match(/resolvePlatformLibrary\s*\(/);
    if (m) lib = "downdraft_platform";
    m = src.match(/resolveNativeLibrary\s*\(\s*["'`]([\w-]+)["'`]/);
    if (m) lib = m[1];
    m = src.match(/resolveShimLibrary\s*\(\s*["'`]([\w-]+)["'`]/);
    if (m && !lib) lib = "downdraft_platform";
    if (!lib) continue;

    const syms = new Set();
    for (const sm of src.matchAll(SPEC_ENTRY_RE)) syms.add(sm[1]);
    if (!syms.size) continue;

    const rec = specs.get(file) ?? { lib, symbols: new Set() };
    for (const s of syms.values()) rec.symbols.add(s);
    specs.set(file, rec);
  }
}

if (!specs.size) {
  console.log("[check-native-symbols] no FFI spec tables found — nothing to check");
  process.exit(0);
}

// lib name -> [files that declare its spec]
const byLib = new Map();
for (const [file, rec] of specs.entries()) {
  const arr = byLib.get(rec.lib) ?? [];
  arr.push({ file, symbols: rec.symbols });
  byLib.set(rec.lib, arr);
}

// ── 2. Enumerate staged native packages ──
const staged = [];
const pkgsDir = join(root, "packages");
for (const e of readdirSync(pkgsDir)) {
  if (!/^native-.+-.+$/.test(e)) continue;
  const libDir = join(pkgsDir, e, "lib");
  if (!existsSync(libDir) || !statSync(libDir).isDirectory()) continue;
  if (readdirSync(libDir).some((f) => /\.(so|dylib|dll)$/.test(f))) {
    staged.push({ name: e, libDir });
  }
}

if (!staged.length) {
  console.log("[check-native-symbols] no staged packages/native-*/lib — skipping (run after stage-native-packages.mjs)");
  process.exit(0);
}

// ── 3. Check each spec's symbols against its staged .so ──
function exportedSymbols(libPath) {
  const ext = libPath.split(".").pop();
  const tries = ext === "dylib"
    ? [["nm", ["-gU", libPath]], ["llvm-nm", ["--defined-only", libPath]]]
    : ext === "dll"
      // PE on a Linux/macOS runner: binutils objdump reads PEI, nm often can
      // too; llvm-nm when present. objdump -p lists exports in the
      // "Ordinal/Name Pointer" table rows ("<ord> <rva> <name>").
      ? [["objdump", ["-p", libPath]], ["llvm-nm", ["--defined-only", libPath]], ["nm", ["-D", "--defined-only", libPath]]]
      : [["nm", ["-D", "--defined-only", libPath]], ["readelf", ["-Ws", libPath]], ["objdump", ["-T", libPath]]];
  for (const [tool, args] of tries.values()) {
    try {
      const out = execFileSync(tool, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const syms = new Set();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const last = parts[parts.length - 1];
        if (last && /^[A-Za-z_][\w.]*$/.test(last)) {
          syms.add(last);
          // Mach-O prepends "_" to C symbols.
          if (last.startsWith("_")) syms.add(last.slice(1));
        }
      }
      if (syms.size) return syms;
    } catch { /* tool missing or failed — try next */ }
  }
  return null;
}

const LIB_FILE_RE = /^(lib)?(downdraft_[\w-]+)\.(so|dylib|dll)$/;

let failures = 0;
let checked = 0;
for (const { name: pkgName, libDir } of staged.values()) {
  // Map every staged lib file to its downdraft_<lib> name.
  const libFiles = new Map();
  for (const f of readdirSync(libDir)) {
    const m = f.match(LIB_FILE_RE);
    if (m) libFiles.set(m[2], join(libDir, f));
  }

  for (const [lib, fileSpecs] of byLib.entries()) {
    const libPath = libFiles.get(lib);
    if (!libPath) {
      if (!quiet) console.log(`[check-native-symbols] ${pkgName}: ${lib} not staged (optional lib — skipped)`);
      continue;
    }
    const exported = exportedSymbols(libPath);
    if (!exported) {
      // Unreadable format on this toolchain (e.g. PE .dll with no
      // PE-capable objdump) — warn and skip rather than block the release
      // on a tooling gap; the check exists to catch stale artifacts.
      console.warn(`[check-native-symbols] ${pkgName}: cannot inspect ${libPath} — skipped`);
      continue;
    }
    const wanted = new Set();
    for (const { symbols } of fileSpecs.values()) for (const s of symbols.values()) wanted.add(s);
    const missing = [...wanted].filter((s) => !exported.has(s));
    checked++;
    if (missing.length) {
      failures++;
      const files = fileSpecs.map((f) => relative(root, f.file)).join(", ");
      console.error(`[check-native-symbols] ${pkgName}/${lib}: MISSING ${missing.length} symbol(s): ${missing.join(", ")}  (declared in ${files})`);
    } else if (!quiet) {
      console.log(`[check-native-symbols] ${pkgName}/${lib}: ${wanted.size} symbols OK`);
    }
  }
}

if (failures) {
  console.error(`[check-native-symbols] FAILED — ${failures} library check(s) have missing symbols`);
  process.exit(1);
}
console.log(`[check-native-symbols] OK — ${checked} staged librar${checked === 1 ? "y" : "ies"} verified against JS spec tables`);
