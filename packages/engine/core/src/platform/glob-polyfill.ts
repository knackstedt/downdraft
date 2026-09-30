// ============================================================================
// glob-polyfill.ts — import.meta.glob replacement for the native runtime
//
// This module is imported by the bun-preload glob plugin. It provides a
// filesystem-based implementation of Vite's import.meta.glob().
// ============================================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
      const prefixedPath = relPath.startsWith("..") ? relPath : "./" + relPath;
      if (matchRegex.test(relPath) || matchRegex.test(prefixedPath)) {
        // For ?url queries, return the file:// URL
        result["./" + relPath] = pathToFileURL(file).href;
      }
    });
    return result;
  };
}
