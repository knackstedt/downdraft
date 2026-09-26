// ============================================================================
// Sandbox shim — worker-side global restriction.
//
// Runs INSIDE the plugin's sandbox worker (sandbox-worker.ts) BEFORE the
// plugin's entry module is imported. It deletes/overrides every global on
// `self` that is NOT in the granted allowlist, then dynamically imports the
// plugin entry.
//
// This is best-effort same-origin isolation. For strong security, remote
// workshop plugins run from a blob:/data: origin with CSP (Phase 2).
// ============================================================================

import type { PluginPermission } from "./manifest";
import { BASELINE_GLOBALS, computeGlobalAllowlist } from "./permissions";

/** Result of restrictGlobals: the kept allowlist plus a restore() that puts
 *  every trapped/deleted global back. Callers that restrict a shared thread
 *  (InlinePluginLoader) must run restore() when the plugin unloads. */
export interface RestrictResult {
  keep: Set<string>;
  restore: () => void;
}

/**
 * Restrict `self` globals to the allowlist computed from `granted`.
 * Replaces stripped globals with a throwing trap so a plugin that reaches for
 * a denied capability gets a clear error rather than `undefined`.
 */
export function restrictGlobals(granted: ReadonlySet<PluginPermission>): RestrictResult {
  const keep = computeGlobalAllowlist(granted);
  const self = globalThis as Record<string, unknown>;
  // Collect own + inherited enumerable keys of self.
  const allKeys = new Set<string>();
  for (const k of Object.getOwnPropertyNames(self)) allKeys.add(k);
  // Don't strip the host bridge or baseline runtime globals.
  BASELINE_GLOBALS.forEach((g) => { keep.add(g);; });
  // Snapshot the original descriptors so the globals can be restored later.
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of allKeys.values()) {
    if (keep.has(key)) continue;
    // Skip non-configurable / non-writable props silently (can't delete them).
    const desc = Object.getOwnPropertyDescriptor(self, key);
    if (desc && !desc.configurable && !desc.writable) continue;
    if (!originals.has(key)) originals.set(key, desc);
    try {
      // Replace with a throwing trap so access yields a clear error.
      Object.defineProperty(self, key, {
        configurable: true,
        get() {
          throw new Error(
            `[downdraft:plugin-sandbox] global "${key}" is not available — permission not granted.`,
          );
        },
        set() {
          throw new Error(
            `[downdraft:plugin-sandbox] global "${key}" is not available — permission not granted.`,
          );
        },
      });
    } catch {
      // If defineProperty fails, try a plain delete.
      try {
        delete self[key];
      } catch {
        /* give up — leave as-is */
      }
    }
  }
  return {
    keep,
    restore() {
      for (const [key, desc] of originals.entries()) {
        try {
          if (desc) {
            Object.defineProperty(self, key, desc);
          } else {
            delete self[key];
          }
        } catch {
          /* property may be non-configurable — leave as-is */
        }
      }
      originals.clear();
    },
  };
}
