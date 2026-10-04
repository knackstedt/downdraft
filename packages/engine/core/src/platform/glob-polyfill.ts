// ============================================================================
// glob-polyfill.ts — import.meta.glob replacement for the native runtime
//
// This module is imported by the bun-preload glob plugin. It provides a
// filesystem-based implementation of Vite's import.meta.glob().
// ============================================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Compiled-binary layout: `bun build --compile` embeds modules under
// /$bunfs/root/<repo-rel> (Windows: B:\~BUN\root\). Asset files aren't
// embedded — package-native.mjs stages them at <execDir>/dd-assets/
// <repo-rel>, so a $bunfs callerDir maps onto the staged tree. The keys
// stay identical because both trees share the same relative structure.
const BUNFS_ROOT_RE = /^\/\$bunfs\/root\/|^B:\\~BUN\\root\\/i;

function mapCallerDir(callerDir: string): string {
  if (!BUNFS_ROOT_RE.test(callerDir)) return callerDir;
  const rel = callerDir.replace(BUNFS_ROOT_RE, "");
  const root = process.env.DOWNDRAFT_ASSET_ROOT
    ?? join(dirname(process.execPath), "dd-assets");
  return join(root, rel);
}

function globToRegex(pattern: string): RegExp {
  // Order matters: `**` must be handled before `*` (a single `*` matches one
  // path segment; `**` matches zero or more segments). `**/` additionally
  // collapses to zero segments so `a/**/b` also matches `a/b`.
  let regex = pattern
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\x00")
    .replace(/\*\*/g, "\x01")
    .replace(/\*/g, "[^/]*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, "|")})`)
    .replace(/\x00/g, "(?:.*/)?")
    .replace(/\x01/g, ".*");
  return new RegExp(`^${regex}$`, "i");
}

function walkDir(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) walkDir(fullPath, results);
    else results.push(fullPath);
  }
  return results;
}

export function createGlob(callerDir: string): (pattern: string, options?: any) => Record<string, string> {
  const fsCallerDir = mapCallerDir(callerDir);
  return function glob(pattern: string, options?: any): Record<string, string> {
    // Extract the non-glob prefix to find the search root
    const patternParts = pattern.split("/");
    let rootParts: string[] = [];
    for (let _i = 0, _it = patternParts, _n = _it.length; _i < _n; _i++) { const part = _it[_i];
      if (part.includes("*") || part.includes("{")) break;
      rootParts.push(part);
    }
    const searchDir = resolve(fsCallerDir, ...rootParts);
    if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) return {};

    const allFiles = walkDir(searchDir);
    const result: Record<string, string> = {};
    const normalizedPattern = pattern.replace(/^\.\//, "");
    const matchRegex = globToRegex(normalizedPattern);

    allFiles.forEach((file) => {
      const relPath = relative(fsCallerDir, file).replace(/\\/g, "/");
      // Vite-style keys: `./x` for same-dir/child paths, `../x` for parent
      // traversal — NOT `./../x`. Callers match on these keys (startsWith
      // on the pattern's literal prefix, endsWith on subpaths).
      const key = relPath.startsWith("..") ? relPath : "./" + relPath;
      if (matchRegex.test(relPath) || matchRegex.test(key)) {
        // For ?url queries, return the file:// URL
        result[key] = pathToFileURL(file).href;
      }
    });
    return result;
  };
}

// ── globAssets — the canonical asset-glob call ──
//
// Games used to hand-roll the same shim at every call site:
//
//   const _glob = (import.meta as any).glob ?? ((pattern) => {
//     const { createGlob } = require("@downdraft/engine/platform/glob-polyfill");
//     return createGlob(import.meta.dir)(pattern, { query: "?url", eager: true });
//   });
//
// This is that shim, done once. Resolution order matches what the shims
// converged on:
//   1. `__nativeGlob` — installed by the native host (platform-native's
//      installAssetGlob); caller-relative via the baseDir argument.
//   2. `import.meta.glob` — a real implementation only ever exists when a
//      Vite transform rewrote a LITERAL `import.meta.glob(` call at the call
//      site; a passed-around meta object can't carry it. On Vite's
//      ModuleRunner the meta object DOES expose a `glob` property — but it
//      is a stub that throws ("statically replaced during file
//      transformation"), so the probe must tolerate the throw.
//   3. `createGlob(callerDir)` — filesystem glob relative to the caller's
//      module dir (packaged binaries, bare runtimes without the host global,
//      and the dev ModuleRunner where `meta.glob` is the throwing stub).
//
// Usage:
//   const models = globAssets("../assets/models/*.glb", import.meta);
//
// `meta` is the CALLER's import.meta — a module-level helper can't see it.
export function globAssets(
  pattern: string,
  meta: { url?: string; dir?: string; glob?: unknown },
  options?: { query?: string; import?: string; eager?: boolean },
): Record<string, string> {
  const callerDir = meta.dir ?? (meta.url ? dirname(fileURLToPath(meta.url)) : process.cwd());
  const opts = { eager: true, query: "?url", ...options };

  const native = (globalThis as { __nativeGlob?: unknown }).__nativeGlob;
  if (typeof native === "function") {
    return (native as (p: string, o?: unknown, baseDir?: string) => Record<string, string>)(pattern, opts, callerDir);
  }
  if (typeof meta.glob === "function") {
    try {
      return (meta.glob as (p: string, o?: unknown) => Record<string, string>)(pattern, opts);
    } catch { /* ModuleRunner stub — fall through to the filesystem glob */ }
  }
  return createGlob(callerDir)(pattern, opts);
}
