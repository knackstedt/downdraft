// ============================================================================
// icd-sticky.ts — sticky-vendor ICD narrowing for the primary instance
//
// The Rust ICD filter (native-rs gpu/mod.rs) restricts vkCreateInstance to
// ICDs for hardware that is actually present — but on a multi-GPU host that
// still probes every present vendor's driver, and each probe dlopens +
// initializes it (mesa ICDs map a ~40MB libLLVM). When gpu-state.json's
// lastHardwareAdapterInfo records which vendor's adapter won last boot,
// installGPU/early-host pin the primary instance's ICD set to just that
// vendor via applyStickyIcdFilter() before the instance is created.
//
// Recovery is layered so the pin can never wedge a boot:
//   1. Rust ignores an allowlist that would empty the detected ICD set
//      (pinned hardware removed → full enumeration).
//   2. adapter-boot retries on a widened instance when a narrowed instance
//      returns no adapter (icdFilterNarrowed → clearIcdAllowlist + retry).
//   3. Explicit ICD control (DOWNDRAFT_VULKAN_ICD / VK_DRIVER_FILES),
//      adapter:"software", a software crash-latch, and non-Vulkan backends
//      all skip narrowing (stickyIcdAllowlist → null).
// ============================================================================

import type { ptr } from "../ffi/ffi-adapter";
import { stickyIcdAllowlist, type GpuPolicyInput } from "./adapter-policy";
import { loadWgpuEx } from "./wgpu-ffi";

const enc = new TextEncoder();

/** Whether the primary instance was created with a narrowed ICD set — the
 *  boot's widen-retry checks this before paying for a second instance. */
let narrowed = false;

/**
 * Install the sticky-vendor allowlist consumed by the next wgpu instance's
 * ICD filter. Call immediately before `new WgpuGPU()` on the primary path
 * — the allowlist is read at vkCreateInstance time. A no-op when the
 * resolved policy/override says not to narrow, or when the platform lib
 * predates the export.
 */
export function applyStickyIcdFilter(input: GpuPolicyInput = {}): void {
  narrowed = false;
  // No appId → no per-app gpu-state.json to pin from (test harnesses and
  // bare installGPU() calls take the full enumeration).
  if (!input.appId) return;
  const ex = loadWgpuEx();
  if (!ex) return;
  const allow = stickyIcdAllowlist(input);
  if (!allow?.length) return;
  const bytes = enc.encode(allow.join(":"));
  ex.wgpu_shim_set_icd_allowlist(bytes as unknown as ptr, bytes.length);
  narrowed = true;
}

export function icdFilterNarrowed(): boolean {
  return narrowed;
}

/** Clear the installed allowlist — the widened-retry instance path calls
 *  this before creating the fallback instance. */
export function clearIcdAllowlist(): void {
  narrowed = false;
  try {
    loadWgpuEx()?.wgpu_shim_set_icd_allowlist(0 as unknown as ptr, 0);
  } catch { /* old lib / dead handle — the next instance filters normally */ }
}
