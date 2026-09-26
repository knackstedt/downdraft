// ============================================================================
// packaged.ts — detect Bun-compiled (packaged) binaries at runtime
// ============================================================================

/**
 * True when running inside a `bun build --compile` executable.
 * Bun-compiled binaries expose Bun.embeddedFiles; `DOWNDRAFT_PACKAGED=1`
 * overrides for tests and packaging dry-runs.
 */
export function isPackaged(): boolean {
  if (process.env.DOWNDRAFT_PACKAGED === "1") return true;
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Bun === "object" && g.Bun && Array.isArray((g.Bun as { embeddedFiles?: unknown[] }).embeddedFiles)) {
    return ((g.Bun as { embeddedFiles: unknown[] }).embeddedFiles?.length ?? 0) > 0;
  }
  return false;
}
