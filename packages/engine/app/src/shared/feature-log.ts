// ============================================================================
// Host-process feature log — collects OS/CPU/RAM/runtime/flags/GPU identity
// ============================================================================
//
// Synchronous collector for the `dd-host|...` startup line — used by the
// native host bridge. GPU identity is passed in by the caller (wgpu adapter
// info); otherwise the fields are omitted and the renderer's WebGPU adapter
// line carries GPU identity.
// ============================================================================

import { condenseText, formatBytesShort, type FeatureLogData } from "@downdraft/engine/util/feature-log";
import { ENGINE_VERSION } from "@downdraft/engine/version";
import os from "node:os";

export interface CollectHostFeatureLogOptions {
  isDev: boolean;
  deterministic: boolean;
  /** Applied host flag names (e.g. native shim options). */
  flags: string[];
  /** GPU device name (best-effort). Omitted when unknown. */
  gpuDevice?: string | null;
  /** GPU driver version (best-effort). Omitted when unknown. */
  gpuDriverVersion?: string | null;
  /** Runtime tag — "bun", "node", "deno". Defaults from process. */
  runtime?: string;
  /** Scope label — the single-process native runtime (dd-host|...). */
  scope?: "host";
}

/**
 * Collect the host-process feature log data. Synchronous; safe to call at
 * startup. Returns the data (callers cache it if they want to serve it later).
 */
export function collectHostFeatureLog(opts: CollectHostFeatureLogOptions): FeatureLogData {
  const { isDev, deterministic, flags } = opts;
  const versions = process.versions;
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0]!.model : "";

  const data: FeatureLogData = {
    sv: 1,
    scope: opts.scope ?? "host",
    v: ENGINE_VERSION,
    mode: deterministic ? "deterministic" : isDev ? "dev" : "packaged",
    os: process.platform,
    osRel: os.release(),
    arch: process.arch,
    cpu: condenseText(cpuModel, 48),
    cpuCores: cpus.length,
    mem: formatBytesShort(os.totalmem()),
    node: versions.node,
    v8: versions.v8,
    sw: flags.length > 0 ? flags.join(",") : undefined,
  };

  // GPU identity (best-effort, provided by the caller).
  if (opts.gpuDevice) data.gpu = condenseText(opts.gpuDevice, 48);
  if (opts.gpuDriverVersion) data.drv = condenseText(opts.gpuDriverVersion, 32);

  // Runtime tag — distinguishes bun/node/deno hosts in combined views.
  data.rt = opts.runtime ?? runtimeTag();

  return data;
}

/** Detect the JS runtime for the feature log's `rt` field. */
function runtimeTag(): string {
  const p = process as unknown as Record<string, unknown>;
  if (typeof p.bun !== "undefined" || (process.versions as Record<string, string>).bun) return "bun";
  if ((globalThis as unknown as Record<string, unknown>).Deno) return "deno";
  return "node";
}
