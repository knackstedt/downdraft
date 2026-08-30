// ============================================================================
// Plugin diagnostics — snapshot type for the doctor panel + cross-thread report.
// ============================================================================

import type { PluginFormat, PluginPermission, PluginTier, PluginThread } from "./manifest";

export type PluginStatus = "pending" | "loading" | "active" | "error" | "disabled";

/** Per-plugin info returned by `PluginHost.snapshot()`. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  format: PluginFormat;
  tier: PluginTier;
  thread: PluginThread;
  permissions: PluginPermission[];
  provides: string[];
  requires: string[];
  dependencies: string[];
  status: PluginStatus;
  /** Present when status === "error". */
  error?: string;
  /** Permissions requested but denied (with reasons). */
  deniedPermissions?: Array<{ permission: PluginPermission; reason: string }>;
  /** Source: "local" | "workshop". */
  source?: string;
}

/** Build a PluginInfo from a manifest + runtime status. */
export function pluginInfoFromManifest(
  m: {
    id: string;
    name: string;
    version: string;
    format: PluginFormat;
    tier: PluginTier;
    thread: PluginThread;
    permissions?: PluginPermission[];
    provides?: string[];
    requires?: string[];
    dependencies?: string[];
  },
  status: PluginStatus,
  extra?: Partial<PluginInfo>,
): PluginInfo {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    format: m.format,
    tier: m.tier,
    thread: m.thread,
    permissions: m.permissions ?? [],
    provides: m.provides ?? [],
    requires: m.requires ?? [],
    dependencies: m.dependencies ?? [],
    status,
    ...extra,
  };
}
