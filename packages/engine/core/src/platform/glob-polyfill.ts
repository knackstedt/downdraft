// ============================================================================
// glob-polyfill.ts — import.meta.glob replacement for Bun-native mode
//
// This module is imported by the bun-preload glob plugin. It provides a
// filesystem-based implementation of Vite's import.meta.glob().
// ============================================================================

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function globToRegex(pattern: string): RegExp {
  let regex = pattern
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\*\*/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, "|")})`);
  return new RegExp(`^${regex}$`, "i");
}

function walkDir(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) walkDir(fullPath, results);
    else results.push(fullPath);
  }
  return results;
}

export function createGlob(callerDir: string): (pattern: string, options?: any) => Record<string, string> {
  return function glob(pattern: string, options?: any): Record<string, string> {
    // Extract the non-glob prefix to find the search root
    const patternParts = pattern.split("/");
    let rootParts: string[] = [];
    for (const part of patternParts) {
      if (part.includes("*") || part.includes("{")) break;
      rootParts.push(part);
    }
    const searchDir = resolve(callerDir, ...rootParts);
    if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) return {};

    const allFiles = walkDir(searchDir);
    const result: Record<string, string> = {};
    const normalizedPattern = pattern.replace(/^\.\//, "");
    const matchRegex = globToRegex(normalizedPattern);

    for (const file of allFiles) {
      const relPath = relative(callerDir, file).replace(/\\/g, "/");
      const prefixedPath = relPath.startsWith("..") ? relPath : "./" + relPath;
      if (matchRegex.test(relPath) || matchRegex.test(prefixedPath)) {
        // For ?url queries, return the file:// URL
        result["./" + relPath] = pathToFileURL(file).href;
      }
    }
    return result;
  };
}
