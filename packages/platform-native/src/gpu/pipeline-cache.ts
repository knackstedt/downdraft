// ============================================================================
// pipeline-cache.ts — persistent wgpu PipelineCache plumbing.
//
// The native side holds one PipelineCache per device (attached by
// wgpu_shim_pipeline_cache_init, consulted by every pipeline create). This
// module owns the on-disk half: it loads $DOWNDRAFT_USER_DATA/
// gpu-pipeline-cache.bin into the cache at device creation and writes the
// updated blob back on flush — registered on process exit plus exposed for
// engine shutdown paths.
//
// No-ops when the device lacks the "pipeline-cache" feature or the loaded
// platform lib predates the symbols (loadWgpuAsync() null / undefined entry).
// ============================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createLogger } from "@downdraft/engine/util/logger";
import type { WgpuDevice } from "./wgpu-device";
import { loadWgpuAsync } from "./wgpu-ffi";

const log = createLogger();

const FILE = "gpu-pipeline-cache.bin";

function cachePath(): string | null {
  const dir = process.env.DOWNDRAFT_USER_DATA;
  return dir ? join(dir, FILE) : null;
}

/**
 * Attach the persistent pipeline cache to a freshly created device.
 * Returns true when a cache is live (feature enabled + symbol present).
 */
export function initPipelineCache(device: WgpuDevice): boolean {
  if (!(device.features as { has(n: string): boolean }).has("pipeline-cache")) {
    return false;
  }
  const shim = loadWgpuAsync();
  if (!shim?.wgpu_shim_pipeline_cache_init) return false;

  let data: Uint8Array = new Uint8Array(0);
  const path = cachePath();
  if (path) {
    try {
      data = new Uint8Array(readFileSync(path));
    } catch {
      // First boot or unreadable file — start with an empty cache.
    }
  }
  const ok = shim.wgpu_shim_pipeline_cache_init(
    device.ptr,
    data as unknown as never,
    data.byteLength,
  );
  if (ok === 1 || ok === 2) {
    if (ok === 2 && path) {
      // Seed rejected (foreign device / corrupt) — the shim attached a fresh
      // empty cache; drop the stale blob so the next boot doesn't pay the
      // failed-validation round-trip again.
      try {
        rmSync(path, { force: true });
        log.info("gpu", "stale pipeline cache removed — will regenerate");
      } catch { /* best effort */ }
    }
    log.debug("gpu", `pipeline cache attached (${data.byteLength} B seed)`);
    registerExitFlush(device);
    return true;
  }
  return false;
}

/** Write the device's cache blob back to disk. Safe to call anytime —
 *  a no-op once destroy() has released the native ShimDevice (the exit
 *  flush registered at init can fire after host teardown freed it). */
export function flushPipelineCache(device: WgpuDevice): void {
  if (device.handlesReleased) return;
  const shim = loadWgpuAsync();
  if (!shim?.wgpu_shim_pipeline_cache_data_size) return;
  const size = Number(shim.wgpu_shim_pipeline_cache_data_size(device.ptr));
  if (size <= 0) return;
  const path = cachePath();
  if (!path) return;
  const buf = new Uint8Array(size);
  const written = Number(shim.wgpu_shim_pipeline_cache_data(device.ptr, buf as unknown as never, size));
  if (written <= 0) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf.subarray(0, written));
    log.debug("gpu", `pipeline cache saved (${written} B)`);
  } catch (e) {
    log.debug("gpu", `pipeline cache save failed: ${e}`);
  }
}


let exitFlushRegistered = false;
function registerExitFlush(device: WgpuDevice): void {
  if (exitFlushRegistered) return;
  exitFlushRegistered = true;
  // Sync FFI + sync fs both work in an exit handler.
  process.on("exit", () => flushPipelineCache(device));
}
