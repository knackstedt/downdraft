// ============================================================================
// native-assets.ts — Asset discovery replacing import.meta.glob
//
// In Vite, `import.meta.glob("../../assets/models/**/*.fbx", { query: "?url", eager: true })`
// returns a Record<string, string> mapping file paths to resolved URLs.
//
// In native Bun mode, we replace this with filesystem globbing using Bun's
// readdirRecursive or a manual recursive walk.
// ============================================================================

import { createLogger } from "@downdraft/core";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const log = createLogger();

const _dirname = typeof (globalThis as any).__dirname !== "undefined"
  ? (globalThis as any).__dirname
  : dirname(fileURLToPath(import.meta.url));

// ── Glob pattern matching ──
// Supports: ** (recursive), * (single-level wildcard), {a,b} (alternation)
function globToRegex(pattern: string): RegExp {
  // Escape regex special chars except * and {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, (m) => m === "{" || m === "}" || m === "," ? m : "\\" + m)
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, "|")})`)
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`, "i");
}

// ── Recursive directory walk ──
function walkDir(dir: string, results: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkDir(fullPath, results);
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// ── nativeGlob: drop-in replacement for import.meta.glob ──
//
// Usage (matching Vite's import.meta.glob):
//   const models = nativeGlob("../../assets/models/**/*.fbx", { query: "?url", eager: true });
//
// Returns: Record<string, string> mapping relative paths to file:// URLs
//
export function nativeGlob(
  pattern: string,
  _options?: { query?: string; import?: string; eager?: boolean },
): Record<string, string> {
  // Resolve the pattern relative to the caller's directory
  // In Vite, import.meta.glob paths are relative to the importing file.
  // In native mode, we resolve relative to the game's source directory.
  const baseDir = resolve(_dirname, pattern.split("/").slice(0, -1).join("/").replace(/\*\*/g, ""));
  const globPattern = pattern.split("/").pop() || "";

  // Build the full glob pattern
  const fullPattern = pattern.replace(/^\.\.\//g, "");
  const regex = globToRegex(fullPattern);

  // Walk the base directory and collect matching files
  const searchRoot = resolve(_dirname, pattern.replace(/\/[^/]*\*[^/]*$/, "").replace(/\*\*\/?$/, ""));
  let searchDir = searchRoot;

  // Try to find the actual search root by stripping glob parts
  const patternParts = pattern.split("/");
  let rootParts: string[] = [];
  for (const part of patternParts) {
    if (part.includes("*") || part.includes("{")) break;
    rootParts.push(part);
  }
  searchDir = resolve(_dirname, ...rootParts);

  if (!statSync(searchDir).isDirectory()) {
    return {};
  }

  const allFiles = walkDir(searchDir);
  const result: Record<string, string> = {};

  for (const file of allFiles) {
    // Make relative path with forward slashes
    const relPath = relative(_dirname, file).replace(/\\/g, "/");
    const prefixedPath = relPath.startsWith("..") ? relPath : "./" + relPath;

    // Check if the file matches the pattern
    // Normalize the pattern for matching
    const normalizedPattern = pattern.replace(/^\.\//, "");
    const matchRegex = globToRegex(normalizedPattern);

    if (matchRegex.test(relPath) || matchRegex.test(prefixedPath)) {
      // For ?url queries, return the file:// URL
      result["./" + relPath] = pathToFileURL(file).href;
    }
  }

  return result;
}

// ── Install nativeGlob as a global polyfill ──
// The engine code calls import.meta.glob() which is a Vite-specific feature.
// In native mode, we can't intercept import.meta.glob directly, but we can
// provide a helper that game code can use conditionally.
//
// The approach: game code checks for native mode and calls nativeGlob() instead
// of import.meta.glob(). This is done via the runtime detection utility.
export function installAssetGlob(): void {
  (globalThis as any).__nativeGlob = nativeGlob;
  log.info("platform-native", "Asset glob installed (filesystem-based)");
}
