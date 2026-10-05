// ============================================================================
// lib-paths.ts — unified native library resolution
//
// All native libraries (the unified downdraft_platform cdylib and engine
// cdylibs like physics/blitz-osr) resolve through one code path so
// lookup order, env-var overrides, and error messages stay consistent:
//
//   1. env var override (e.g. WGPU_SHIM_PATH, DOWNDRAFT_PHYSICS_LIB)
//   2. caller-supplied dirs (crate-local layouts — see crateDirs() below)
//   3. <platform-native>/native/<lib>.<ext>            (repo/dev build)
//   4. <platform-native>/native/lib/<lib>.<ext>        (fetch-at-install)
//   5. <platform-native>/native/<platform>-<arch>/<lib>.<ext> (artifacts)
//   6. repo <root>/target/**                           (bare cargo builds)
//   7. node_modules/@downdraft/native-<platform>-<arch>/lib/<lib>.<ext>
//   8. <execDir>/native/<lib>.<ext>                    (packaged binary)
//   9. /usr/local/lib/<lib>.<ext>                      (system install)
// ============================================================================

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

/** Absolute path of the platform-native package root. */
export const packageRoot: string = join(_dirname, "..", "..");

/** Absolute path of the platform-native native artifacts directory. */
export const nativeDir: string = join(packageRoot, "native");

/** Monorepo root (packages/platform-native → packages → root). In a
 * standalone npm install this resolves two levels above the installed
 * package — the candidates it feeds simply don't exist there. */
export const repoRoot: string = join(packageRoot, "..", "..");

export const PLATFORM_DIR = `${process.platform}-${process.arch}`;

/**
 * Native build profile. "release" (default) resolves only release/dist
 * artifacts — debug dirs are never searched, so a stray `cargo build` or
 * `build-native.mjs --debug` can never silently downgrade the runtime.
 * Debug builds stage to `<plat>-<arch>-debug/` siblings and load only when
 * the game is started with DD_NATIVE_PROFILE=debug (or `draft dev
 * --native-debug`, which sets this env for the spawned shell).
 */
export const NATIVE_PROFILE: "release" | "debug" =
  process.env.DD_NATIVE_PROFILE === "debug" ? "debug" : "release";

/** Rust target triple for the current platform (null when unsupported). */
export const RUST_TRIPLE: string | null = ({
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
} as Record<string, Record<string, string>>)[process.platform]?.[process.arch] ?? null;

// Packaged layout: bun --compile produces a single binary; the native libs
// ship in a native/ dir next to it. In dev, process.execPath is the bun
// binary — dirname(execPath)/native doesn't exist, so this is a no-op there.
const execDir = dirname(process.execPath);

export function libFileName(baseName: string): string {
  if (process.platform === "win32") return `${baseName}.dll`;
  if (process.platform === "darwin") return `lib${baseName}.dylib`;
  return `lib${baseName}.so`;
}

/**
 * Standard search dirs for a crate directory (the dir that holds the crate's
 * Cargo.toml). Covers the `dist/` layout written by scripts/build-native.mjs
 * plus the legacy standalone-crate `target/` layout.
 */
function crateDirs(crateDir: string): string[] {
  if (NATIVE_PROFILE === "debug") {
    return [
      join(crateDir, "dist", `${PLATFORM_DIR}-debug`),
      join(crateDir, "target", "debug"),
      join(crateDir, "dist", PLATFORM_DIR),
      join(crateDir, "dist"),
      join(crateDir, "target", "release"),
      crateDir,
    ];
  }
  return [
    join(crateDir, "dist", PLATFORM_DIR),
    join(crateDir, "dist"),
    join(crateDir, "target", "release"),
    crateDir,
  ];
}

/** Dirs under the workspace target/ that bare `cargo build` writes to. */
function repoTargetDirs(): string[] {
  const profiles = NATIVE_PROFILE === "debug" ? ["debug", "release", "dist"] : ["release", "dist"];
  const dirs = profiles.map((p) => join(repoRoot, "target", p));
  if (RUST_TRIPLE) {
    dirs.unshift(...profiles.map((p) => join(repoRoot, "target", RUST_TRIPLE, p)));
  }
  return dirs;
}

/** One-time profile reporting — when debug is requested, say so loudly per
 *  resolved lib (debug dir hit) or warn that the fallback was a release
 *  artifact, so "I built --debug but it still feels fast" is diagnosable. */
const reportedLibs = new Set<string>();
function reportProfileHit(file: string, resolved: string): void {
  if (NATIVE_PROFILE !== "debug" || reportedLibs.has(file)) return;
  reportedLibs.add(file);
  if (resolved.includes("debug")) {
    console.warn(`[lib-paths] DEBUG build: ${file} ← ${resolved}`);
  } else {
    console.warn(`[lib-paths] DD_NATIVE_PROFILE=debug but no debug-staged ${file} — using release build at ${resolved}`);
  }
}

/** Platform-package artifact inside node_modules (npm optional dep). */
function platformPackageFile(file: string): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve(`@downdraft/native-${PLATFORM_DIR}/package.json`);
    const p = join(dirname(pkgJson), "lib", file);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export interface NativeLibraryOptions {
  /** Env vars checked in order — the first set value wins. A set-but-missing
   * path throws in strict mode and is ignored when `optional` is set. */
  envVars?: string[];
  /** Crate directory (dir holding Cargo.toml). Its dist/ and legacy target/
   * layouts are searched automatically — see crateDirs(). */
  crateDir?: string;
  /** Fully custom extra dirs, searched before bundled locations. */
  dirs?: string[];
  /** Return null instead of throwing when nothing resolves. */
  optional?: boolean;
  /** Recovery hint appended to the "not found" error. */
  buildHint?: string;
}

/**
 * Resolve a native library path. `baseName` is the library name without the
 * platform prefix/suffix (e.g. "downdraft_platform" → libdowndraft_platform.so).
 * Throws with an actionable error unless `optional` is set.
 */
export function resolveNativeLibrary(baseName: string, opts?: NativeLibraryOptions & { optional?: false }): string;
export function resolveNativeLibrary(baseName: string, opts: NativeLibraryOptions & { optional: true }): string | null;
export function resolveNativeLibrary(baseName: string, opts: NativeLibraryOptions = {}): string | null {
  const file = libFileName(baseName);

  for (let _i = 0, _it = opts.envVars ?? [], _n = _it.length; _i < _n; _i++) {
    const envVar = _it[_i];
    const envPath = process.env[envVar];
    if (!envPath) continue;
    if (existsSync(envPath)) return envPath;
    if (!opts.optional) {
      throw new Error(
        `${envVar} is set to "${envPath}" but the file does not exist. ` +
        `Unset it or point it at a valid ${file}.`
      );
    }
  }

  // Android: every native lib ships in the APK's jniLibs — dlopen by bare
  // soname resolves through the app's native library dir, no filesystem
  // path needed (or exists). The platform crate is statically linked into
  // the shell's libdowndraft_android.so so its statics are shared with the
  // winit loop on the app thread.
  if (process.platform === "android") {
    return baseName === "downdraft_platform" ? "libdowndraft_android.so" : file;
  }

  const candidates = [
    ...(opts.dirs ?? []).map((d) => join(d, file)),
    ...(opts.crateDir ? crateDirs(opts.crateDir) : []).map((d) => join(d, file)),
    ...(NATIVE_PROFILE === "debug"
      ? [join(nativeDir, `${PLATFORM_DIR}-debug`, file)] // build-native --debug staging
      : []),
    join(nativeDir, file),                       // platform-native dev build
    join(nativeDir, "lib", file),                // fetch-at-install layout
    join(nativeDir, PLATFORM_DIR, file),         // per-platform artifacts
    ...repoTargetDirs().map((d) => join(d, file)),
    join(execDir, "native", file),               // packaged binary layout
    join("/usr/local/lib", file),                // system install
  ];

  for (let _i = 0, _it = candidates, _n = _it.length; _i < _n; _i++) { const p = _it[_i];
    if (existsSync(p)) { reportProfileHit(file, p); return p; }
  }

  const pkgFile = platformPackageFile(file);
  if (pkgFile) return pkgFile;

  if (opts.optional) return null;
  throw new Error(
    `${file} not found. Searched:\n${[...candidates, `node_modules/@downdraft/native-${PLATFORM_DIR}/lib`].map((c) => `  - ${c}`).join("\n")}\n` +
    `Set ${opts.envVars?.[0] ?? "the override env var"}, or ${opts.buildHint ?? `run "bun run build:native" (or "bun run fetch:native") from the repo root`}.`
  );
}

/** Resolve the unified platform cdylib (libdowndraft_platform). */
export function resolvePlatformLibrary(optional?: false): string;
export function resolvePlatformLibrary(optional: true): string | null;
export function resolvePlatformLibrary(optional = false): string | null {
  const base = {
    envVars: ["DD_PLATFORM_PATH"],
    crateDir: join(packageRoot, "native-rs"),
    buildHint: 'run "bun run build:native" from the repo root, or "bun run fetch:native"',
  };
  return optional
    ? resolveNativeLibrary("downdraft_platform", { ...base, optional: true })
    : resolveNativeLibrary("downdraft_platform", base);
}

// ── Env-var override helpers ──
// Kept so the *_SHIM_PATH escape hatches still work for custom/debug builds
// (the C shims are gone — these now only fire when the env var is set).

/**
 * Resolve a shim library path. `baseName` is the library name without the
 * platform prefix/suffix (e.g. "wgpu_shim" → libwgpu_shim.so).
 */
export function resolveShimLibrary(baseName: string, envVar: string, buildHint?: string): string {
  return resolveNativeLibrary(baseName, { envVars: [envVar], buildHint }) as string;
}

/** Same as resolveShimLibrary but returns null instead of throwing. */
export function findShimLibrary(baseName: string, envVar: string): string | null {
  return resolveNativeLibrary(baseName, { envVars: [envVar], optional: true });
}
