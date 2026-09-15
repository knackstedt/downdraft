// ============================================================================
// lib-paths.ts — unified native library resolution
//
// All shim libraries are resolved through a single code path so that lookup
// order, env-var overrides, and error messages stay consistent:
//
//   1. <NAME>_SHIM_PATH env var (explicit override, for tests/dev)
//   2. <pkg>/native/<lib>.<ext>            (repo/dev build, shim next to deps)
//   3. <pkg>/native/lib/<lib>.<ext>        (fetch-at-install layout)
//   4. <pkg>/native/<platform>-<arch>/<lib>.<ext> (per-platform artifacts)
//   5. /usr/local/lib/<lib>.<ext>          (system install)
//
// Directory layout is relative to the package root (two levels above this
// file: src/ffi → package root).
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

/** Absolute path of the package root (packages/platform-native). */
export const packageRoot: string = join(_dirname, "..", "..");

/** Absolute path of the native artifacts directory. */
export const nativeDir: string = join(packageRoot, "native");

const PLATFORM_DIR = `${process.platform}-${process.arch}`;

function libFileName(baseName: string): string {
  if (process.platform === "win32") return `${baseName}.dll`;
  if (process.platform === "darwin") return `lib${baseName}.dylib`;
  return `lib${baseName}.so`;
}

/**
 * Resolve a shim library path. `baseName` is the library name without the
 * platform prefix/suffix (e.g. "wgpu_shim" → libwgpu_shim.so).
 * `envVar` names the override variable (e.g. "WGPU_SHIM_PATH").
 * `buildHint` is appended to the error message to help the user recover.
 *
 * Throws with an actionable error when no candidate exists.
 */
export function resolveShimLibrary(baseName: string, envVar: string, buildHint?: string): string {
  const file = libFileName(baseName);
  const envPath = process.env[envVar];
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(
      `${envVar} is set to "${envPath}" but the file does not exist. ` +
      `Unset it or point it at a valid ${file}.`
    );
  }

  const candidates = [
    join(nativeDir, file),                       // dev build (rpath $ORIGIN/lib)
    join(nativeDir, "lib", file),                // legacy lib/ subdir
    join(nativeDir, PLATFORM_DIR, file),         // fetch-at-install layout
    join("/usr/local/lib", file),                // system install
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `${file} not found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
    `Set ${envVar}, or ${buildHint ?? `run "bun run fetch:native" / "bun run build:shims" in packages/platform-native`}.`
  );
}

/** Same as resolveShimLibrary but returns null instead of throwing. */
export function findShimLibrary(baseName: string, envVar: string): string | null {
  const file = libFileName(baseName);
  const envPath = process.env[envVar];
  if (envPath && existsSync(envPath)) return envPath;
  const candidates = [
    join(nativeDir, file),
    join(nativeDir, "lib", file),
    join(nativeDir, PLATFORM_DIR, file),
    join("/usr/local/lib", file),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
