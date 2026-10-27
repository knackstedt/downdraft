// ============================================================================
// controller — binding for the optional `downdraft_controller` cdylib (gilrs).
//
// Loads the library through the shared ffi-adapter (Bun/Node/Deno), owns the
// 'controller-devices' SAB channel, and hands the buffer + control hooks to the
// engine's ControllerLib (which builds ControllerHub / SabControllerSource on it).
//
// The library is intentionally optional: it hard-links libudev on Linux, so
// absence or dlopen failure just means "no controller" — the platform itself
// keeps working.
// ============================================================================

import {
    ControllerDevicesChannel,
    ControllerDevicesReader,
} from "@downdraft/engine/sab/controller-devices";
import { createLogger } from "@downdraft/engine/util/logger";
import { join } from "node:path";
import { dlopen, ptr } from "../ffi/ffi-adapter";
import { packageRoot, resolveNativeLibrary } from "../ffi/lib-paths";

const log = createLogger("info");

export interface NativeControllerHandle {
  /** The 'controller-devices' channel buffer — shared with the native worker. */
  sab: SharedArrayBuffer;
  /** Dual-motor rumble: magnitudes 0..65535, duration in ms. */
  rumble(slot: number, weak: number, strong: number, ms: number): void;
  /** Circular stick deadzone radius (0..0.9). */
  setDeadzone(radius: number): void;
  /** Re-scan connected devices (sleep/wake, missed hotplug). */
  rescan(): void;
  destroy(): void;
}

let active: NativeControllerHandle | null = null;

interface PadSymbols {
  dd_pad_init(): number;
  dd_pad_attach_sab(ptr: ptr, len: number): number;
  dd_pad_detach_sab(): void;
  dd_pad_rumble(slot: number, weak: number, strong: number, ms: number): number;
  dd_pad_set_deadzone(radius: number): number;
  dd_pad_rescan(): number;
  dd_pad_destroy(): number;
}

/**
 * Load + start the controller backend. Returns null when the library is absent
 * or fails to initialize — callers must treat controller as unavailable.
 */
export function initNativeController(): NativeControllerHandle | null {
  if (active) return active;

  const path = resolveNativeLibrary("downdraft_controller", {
    optional: true,
    crateDir: join(packageRoot, "native-controller"),
    envVars: ["DD_CONTROLLER_LIB"],
    buildHint: 'run "cargo build -p downdraft-controller" from the repo root',
  });
  if (!path) return null;

  let lib: { symbols: PadSymbols };
  try {
    lib = dlopen(path, {
      dd_pad_init: { args: [], returns: "i32" },
      dd_pad_attach_sab: { args: ["usize", "usize"], returns: "i32" },
      dd_pad_detach_sab: { args: [], returns: "void" },
      dd_pad_rumble: { args: ["u32", "u16", "u16", "u32"], returns: "i32" },
      dd_pad_set_deadzone: { args: ["f32"], returns: "i32" },
      dd_pad_rescan: { args: [], returns: "i32" },
      dd_pad_destroy: { args: [], returns: "i32" },
    }) as unknown as { symbols: PadSymbols };
  } catch (e) {
    log.warn("controller", `failed to load ${path}: ${e}`);
    return null;
  }
  const sym = lib.symbols;

  if (sym.dd_pad_init() !== 0) {
    log.warn("controller", "dd_pad_init failed — gilrs unavailable");
    return null;
  }

  const sab = ControllerDevicesChannel.allocate();
  // ptr() accepts ArrayBufferLike at runtime on all three backends (bun:ffi,
  // koffi, Deno); the type union is ArrayBuffer-shaped, so cast.
  const rc = sym.dd_pad_attach_sab(ptr(sab as unknown as ArrayBuffer), sab.byteLength);
  if (rc !== 0) {
    log.warn("controller", `dd_pad_attach_sab failed (rc=${rc})`);
    sym.dd_pad_destroy();
    return null;
  }

  active = {
    sab,
    rumble(slot, weak, strong, ms) {
      sym.dd_pad_rumble(slot, weak & 0xffff, strong & 0xffff, ms >>> 0);
    },
    setDeadzone(radius) {
      sym.dd_pad_set_deadzone(radius);
    },
    rescan() {
      sym.dd_pad_rescan();
    },
    destroy() {
      if (!active) return;
      sym.dd_pad_detach_sab();
      sym.dd_pad_destroy();
      active = null;
    },
  };
  return active;
}

/** Enrichment timer state (started lazily by startControllerEnrichment). */
let enrichTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the 1Hz sysfs enrichment loop (RSSI + refined conn type) writing the
 * JS-owned hostMeta slot fields. Linux-only; no-ops elsewhere.
 */
export async function startControllerEnrichment(sab: SharedArrayBuffer): Promise<() => void> {
  if (enrichTimer) return () => {};
  if (process.platform !== "linux") return () => {};

  const { SysfsControllerEnricher } = await import("@downdraft/engine/libraries/controller/sysfs-enrich");
  const enricher = new SysfsControllerEnricher(sab);
  const reader = new ControllerDevicesReader(sab);

  const tick = () => {
    try {
      const slots = [...reader.readConnected()];
      if (slots.length === 0) return;
      void enricher.enrich(slots);
    } catch {
      /* never let enrichment kill the timer */
    }
  };
  enrichTimer = setInterval(tick, 1000);
  tick();

  return () => {
    if (enrichTimer) clearInterval(enrichTimer);
    enrichTimer = null;
  };
}
