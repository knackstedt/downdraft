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

import { BASELINE_GLOBALS, computeGlobalAllowlist } from "./permissions";
import type { PluginPermission } from "./manifest";

/**
 * Restrict `self` globals to the allowlist computed from `granted`.
 * Replaces stripped globals with a throwing trap so a plugin that reaches for
 * a denied capability gets a clear error rather than `undefined`.
 */
export function restrictGlobals(granted: ReadonlySet<PluginPermission>): Set<string> {
  const keep = computeGlobalAllowlist(granted);
  const self = globalThis as Record<string, unknown>;
  // Collect own + inherited enumerable keys of self.
  const allKeys = new Set<string>();
  for (const k of Object.getOwnPropertyNames(self)) allKeys.add(k);
  // Don't strip the host bridge or baseline runtime globals.
  for (const g of BASELINE_GLOBALS) keep.add(g);
  for (const key of allKeys) {
    if (keep.has(key)) continue;
    // Skip non-configurable / non-writable props silently (can't delete them).
    const desc = Object.getOwnPropertyDescriptor(self, key);
    if (desc && !desc.configurable && !desc.writable) continue;
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
  return keep;
}
