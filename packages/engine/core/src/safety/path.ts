/**
 * Path validation utilities — browser-safe (no `node:path` dependency).
 *
 * These functions work with POSIX-style paths (`/` separator) which is
 * sufficient for URI validation and path traversal prevention in both
 * browser and Node.js contexts.
 */

/** Returns true if the path starts with `/` (POSIX absolute) or a Windows drive letter. */
function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/")) return true;
  // Windows drive: C:\ or C:/
  return /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Normalizes a path by resolving `.` and `..` segments.
 * Does NOT resolve symlinks or check filesystem existence.
 * Works on POSIX-style paths (forward slashes).
 */
function normalizePath(p: string): string {
  const isAbs = isAbsolutePath(p);
  const parts = p.replace(/\\/g, "/").split("/");
  const result: string[] = [];

  for (let _i = 0, _it = parts, _n = _it.length; _i < _n; _i++) { const part = _it[_i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") {
        result.pop();
      } else if (!isAbs) {
        result.push("..");
      }
      // For absolute paths, .. at root stays at root (pop nothing)
    } else {
      result.push(part);
    }
  }

  let normalized = result.join("/");
  if (isAbs) normalized = "/" + normalized;
  return normalized || (isAbs ? "/" : ".");
}

/**
 * Joins `base` and `target` into a single normalized path.
 * If `target` is absolute, `base` is ignored.
 */
function joinPath(base: string, target: string): string {
  if (isAbsolutePath(target)) return normalizePath(target);
  const sep = base.endsWith("/") ? "" : "/";
  return normalizePath(base + sep + target);
}

/**
 * Computes the relative path from `from` to `to`.
 * If `to` is not under `from`, the result starts with `..`.
 */
function relativePath(from: string, to: string): string {
  const fromNorm = normalizePath(from);
  const toNorm = normalizePath(to);
  const fromParts = fromNorm.split("/").filter(Boolean);
  const toParts = toNorm.split("/").filter(Boolean);

  // Find common prefix
  let commonLen = 0;
  while (
    commonLen < fromParts.length &&
    commonLen < toParts.length &&
    fromParts[commonLen] === toParts[commonLen]
  ) {
    commonLen++;
  }

  const upCount = fromParts.length - commonLen;
  const downParts = toParts.slice(commonLen);

  const result = [
    ...Array(upCount).fill(".."),
    ...downParts,
  ];

  if (result.length === 0) return ".";
  return result.join("/");
}

/**
 * Resolves `targetPath` relative to `baseDir` and ensures the result does not
 * escape `baseDir` via `..` segments or absolute paths.
 *
 * Throws if the resolved path would be outside `baseDir`.
 * Returns the resolved absolute path on success.
 */
export function confinePath(baseDir: string, targetPath: string): string {
  const base = normalizePath(baseDir);
  let target: string;
  if (isAbsolutePath(targetPath)) {
    target = normalizePath(targetPath);
  } else {
    target = joinPath(base, targetPath);
  }

  const rel = relativePath(base, target);
  // If the relative path starts with `..` or is an absolute path (different drive on Windows),
  // the target escapes the base directory.
  if (rel.startsWith("..") || isAbsolutePath(rel)) {
    throw new Error(
      `Path "${targetPath}" escapes base directory "${baseDir}"`,
    );
  }
  return target;
}

/**
 * Boolean variant of {@link confinePath}. Returns `true` if `targetPath` is
 * confined within `baseDir`, `false` otherwise.
 */
export function isPathSafe(baseDir: string, targetPath: string): boolean {
  try {
    confinePath(baseDir, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a URI string (e.g. from glTF texture references). Only allows:
 * - Relative paths without `..` segments
 * - `data:` URIs
 *
 * Rejects: absolute paths, `file://`, `..` traversal, `http://`/`https://` to
 * arbitrary hosts (unless `allowRemote` is true).
 */
export function sanitizeUri(
  uri: string,
  opts: { allowRemote?: boolean; baseDir?: string } = {},
): string {
  if (uri.startsWith("data:")) return uri;

  if (uri.startsWith("file://")) {
    throw new Error(`file:// URIs are not allowed: "${uri}"`);
  }

  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    if (!opts.allowRemote) {
      throw new Error(`Remote URIs are not allowed: "${uri}"`);
    }
    return uri;
  }

  // Relative path — reject `..` segments
  if (uri.includes("..")) {
    throw new Error(`Path traversal detected in URI: "${uri}"`);
  }

  if (isAbsolutePath(uri)) {
    throw new Error(`Absolute paths are not allowed: "${uri}"`);
  }

  // If baseDir provided, verify confinement
  if (opts.baseDir) {
    return confinePath(opts.baseDir, uri);
  }

  return uri;
}
