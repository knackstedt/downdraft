// ============================================================================
// Plugin permissions — the sandbox permission model.
//
// Each `PluginPermission` maps to a set of Web Worker globals the sandbox
// shim keeps (vs. strips) before the plugin's code runs. The host resolves
// the *granted* permission set = (requested ∩ tier-allowed ∩ game-allowlist),
// then hands it to the sandbox shim which deletes/overrides disallowed
// globals.
//
// This module is the single source of truth for:
//   - the per-tier allowed permission sets (mirrored in manifest.ts)
//   - the permission → global-allowlist mapping
//   - permission resolution + grant computation
// ============================================================================

import type { PluginPermission, PluginTier } from "./manifest";

// ── Per-tier allowed permissions (mirror of manifest.ts rules) ──

export const TIER_ALLOWED: Record<PluginTier, ReadonlySet<PluginPermission>> = {
  data: new Set<PluginPermission>([]),
  script: new Set<PluginPermission>(["events", "state", "tick", "storage", "log"]),
  native: new Set<PluginPermission>([
    "ecs",
    "sab",
    "gpu",
    "events",
    "state",
    "tick",
    "storage",
    "network",
    "log",
    "physics",
    "assets",
  ]),
};

// ── Permission → worker-global allowlist ──
//
// The sandbox shim deletes every global NOT in the granted allowlist. The
// allowlist is the union of (a) a baseline set always kept (needed for the
// plugin runtime itself) and (b) per-permission additions.
//
// Baseline: the JS runtime essentials + the host-provided `ddPlugin` bridge.
// These are NEVER stripped — without them the plugin can't run at all.

export const BASELINE_GLOBALS: readonly string[] = [
  // JS runtime
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "JSON",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
  "TextEncoder",
  "TextDecoder",
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "atob",
  "btoa",
  "structuredClone",
  "performance",
  "self",
  "globalThis",
  // Host bridge (injected by the sandbox shim)
  "ddPlugin",
];

/** Globals kept when a given permission is granted. */
export const PERMISSION_GLOBALS: Record<PluginPermission, readonly string[]> = {
  network: ["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Request", "Response", "Headers", "URL", "URLSearchParams"],
  storage: ["indexedDB", "caches"],
  // ecs/sab/gpu/events/state/tick/log don't add raw globals — they're
  // mediated through the `ddPlugin` host bridge (typed APIs on the context).
  // Listing them empty keeps the mapping explicit and extensible.
  ecs: [],
  sab: [],
  gpu: [],
  events: [],
  state: [],
  tick: [],
  log: [],
  physics: [],
  assets: [],
};

// ── Permission resolution ──

export interface PermissionGrant {
  /** The final granted permission set (requested ∩ tier ∩ game-allowlist). */
  granted: ReadonlySet<PluginPermission>;
  /** Permissions requested but denied (with reason). */
  denied: Array<{ permission: PluginPermission; reason: string }>;
}

/**
 * Resolve the granted permission set for a plugin.
 *
 * @param requested  Permissions requested in the manifest.
 * @param tier       The plugin's tier.
 * @param gameAllow  Optional game-defined allowlist. If provided, only
 *                   permissions in this set can be granted (game can forbid
 *                   e.g. `network` even for native-tier plugins). If omitted,
 *                   the tier set is the only constraint.
 */
export function resolvePermissions(
  requested: PluginPermission[],
  tier: PluginTier,
  gameAllow?: ReadonlySet<PluginPermission>,
): PermissionGrant {
  const tierSet = TIER_ALLOWED[tier];
  const granted = new Set<PluginPermission>();
  const denied: Array<{ permission: PluginPermission; reason: string }> = [];

  for (const p of requested) {
    if (!tierSet.has(p)) {
      denied.push({ permission: p, reason: `not allowed for tier "${tier}"` });
      continue;
    }
    if (gameAllow && !gameAllow.has(p)) {
      denied.push({ permission: p, reason: "denied by game allowlist" });
      continue;
    }
    granted.add(p);
  }

  return { granted, denied };
}

/**
 * Compute the full set of worker-global names the sandbox shim should KEEP
 * for a plugin with the given granted permissions. Everything else on `self`
 * gets deleted/replaced with a throwing trap.
 */
export function computeGlobalAllowlist(granted: ReadonlySet<PluginPermission>): Set<string> {
  const keep = new Set<string>(BASELINE_GLOBALS);
  for (const p of granted) {
    for (const g of PERMISSION_GLOBALS[p]) keep.add(g);
  }
  return keep;
}
