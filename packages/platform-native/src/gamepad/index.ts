// ============================================================================
// gamepad — binding for the optional `downdraft_gamepad` cdylib (gilrs).
//
// Loads the library through the shared ffi-adapter (Bun/Node/Deno), owns the
// 'gamepad-devices' SAB channel, and hands the buffer + control hooks to the
// engine's GamepadLib (which builds GamepadHub / SabGamepadSource on it).
//
// The library is intentionally optional: it hard-links libudev on Linux, so
// absence or dlopen failure just means "no gamepad" — the platform itself
// keeps working.
// ============================================================================

import {
    GamepadDevicesChannel,
    GamepadDevicesReader,
} from "@downdraft/engine/sab/gamepad-devices";
import { createLogger } from "@downdraft/engine/util/logger";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dlopen, ptr } from "../ffi/ffi-adapter";
import { resolveNativeLibrary } from "../ffi/lib-paths";

const log = createLogger("info");

const _dirname =
  typeof (globalThis as { __dirname?: string }).__dirname !== "undefined"
    ? (globalThis as { __dirname: string }).__dirname
    : join(fileURLToPath(import.meta.url), "..");

export interface NativeGamepadHandle {
  /** The 'gamepad-devices' channel buffer — shared with the native worker. */
  sab: SharedArrayBuffer;
  /** Dual-motor rumble: magnitudes 0..65535, duration in ms. */
  rumble(slot: number, weak: number, strong: number, ms: number): void;
  /** Circular stick deadzone radius (0..0.9). */
  setDeadzone(radius: number): void;
  /** Re-scan connected devices (sleep/wake, missed hotplug). */
  rescan(): void;
  destroy(): void;
}

let active: NativeGamepadHandle | null = null;

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
 * Load + start the gamepad backend. Returns null when the library is absent
 * or fails to initialize — callers must treat gamepad as unavailable.
 */
export function initNativeGamepad(): NativeGamepadHandle | null {
  if (active) return active;

  const path = resolveNativeLibrary("downdraft_gamepad", {
    optional: true,
    crateDir: join(_dirname, "..", "..", "native-gamepad"),
    envVars: ["DD_GAMEPAD_LIB"],
    buildHint: 'run "cargo build -p downdraft-gamepad" from the repo root',
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
    log.warn("gamepad", `failed to load ${path}: ${e}`);
    return null;
  }
  const sym = lib.symbols;

  if (sym.dd_pad_init() !== 0) {
    log.warn("gamepad", "dd_pad_init failed — gilrs unavailable");
    return null;
  }

  const sab = GamepadDevicesChannel.allocate();
  // ptr() accepts ArrayBufferLike at runtime on all three backends (bun:ffi,
  // koffi, Deno); the type union is ArrayBuffer-shaped, so cast.
  const rc = sym.dd_pad_attach_sab(ptr(sab as unknown as ArrayBuffer), sab.byteLength);
  if (rc !== 0) {
    log.warn("gamepad", `dd_pad_attach_sab failed (rc=${rc})`);
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

/** Enrichment timer state (started lazily by startGamepadEnrichment). */
let enrichTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the 1Hz sysfs enrichment loop (RSSI + refined conn type) writing the
 * JS-owned hostMeta slot fields. Linux-only; no-ops elsewhere.
 */
export async function startGamepadEnrichment(sab: SharedArrayBuffer): Promise<() => void> {
  if (enrichTimer) return () => {};
  if (process.platform !== "linux") return () => {};

  const { SysfsGamepadEnricher } = await import("@downdraft/engine/libraries/gamepad/sysfs-enrich");
  const enricher = new SysfsGamepadEnricher(sab);
  const reader = new GamepadDevicesReader(sab);

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
