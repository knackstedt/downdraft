// ============================================================================
// SysfsGamepadEnricher — Linux sysfs enrichment for the 'gamepad-devices'
// channel's JS-owned hostMeta field. Ported from Ember's evdev.ts sysfs
// probing: Bluetooth RSSI (walk up the sysfs tree) + power_supply battery.
//
// Host-side only — uses node:fs. Wire in platform-native's host services and
// call `enrich()` on a ~1Hz timer; it writes rssi into each slot's hostMeta.
// ============================================================================

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  GamepadDevicesHostMetaWriter,
  PadConnType,
  type GamepadDeviceSlot,
} from "@downdraft/engine/sab/gamepad-devices";

const MAC_RE = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}/;

async function readSysfsText(path: string): Promise<string | null> {
  try {
    if (existsSync(path)) return (await fs.readFile(path, "utf-8")).trim();
  } catch {
    /* ignore */
  }
  return null;
}

async function readSysfsInt(path: string): Promise<number | undefined> {
  const text = await readSysfsText(path);
  if (text === null) return undefined;
  const n = parseInt(text, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Walk up the sysfs tree looking for a bluetooth device RSSI (dBm → 0..100). */
async function findBluetoothRssi(inputSysPath: string): Promise<number | undefined> {
  try {
    let cur = await fs.realpath(inputSysPath);
    for (let depth = 0; depth < 6; depth++) {
      const rssi = await readSysfsInt(join(cur, "rssi"));
      if (rssi !== undefined) {
        const clamped = Math.max(-90, Math.min(-30, rssi));
        return Math.round(((clamped + 90) / 60) * 100);
      }
      cur = await fs.realpath(join(cur, ".."));
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Battery % for a Bluetooth MAC-matched /sys/class/power_supply entry. */
async function findBatteryLevel(macHint: string | null): Promise<number | undefined> {
  if (!macHint) return undefined;
  try {
    const psDir = "/sys/class/power_supply";
    if (!existsSync(psDir)) return undefined;
    for (const entry of (await fs.readdir(psDir)).values()) {
      const macPath = join(psDir, entry, "mac");
      if (existsSync(macPath)) {
        const mac = (await fs.readFile(macPath, "utf-8")).trim().toLowerCase();
        if (mac === macHint.toLowerCase()) {
          return readSysfsInt(join(psDir, entry, "capacity"));
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface EnrichResult {
  slot: number;
  rssi?: number;
  battery?: number;
  connectionType?: "wired" | "bluetooth" | "dongle";
  physPath?: string;
  driverName?: string;
}

/**
 * Enriches gamepad-device slots with data gilrs doesn't expose (RSSI) and
 * refines connection classification via phys-path heuristics. Pure reads +
 * hostMeta writes; safe to run on a timer.
 */
export class SysfsGamepadEnricher {
  private writer: GamepadDevicesHostMetaWriter;

  constructor(sab: SharedArrayBuffer) {
    this.writer = new GamepadDevicesHostMetaWriter(sab);
  }

  /** Enrich a batch of connected slots. */
  async enrich(slots: GamepadDeviceSlot[]): Promise<EnrichResult[]> {
    if (process.platform !== "linux") return [];
    const out: EnrichResult[] = [];
    for (const s of slots.values()) {
      if (s.eventNode < 0) continue;
      const r = await this.enrichSlot(s);
      out.push(r);
    }
    return out;
  }

  async enrichSlot(s: GamepadDeviceSlot): Promise<EnrichResult> {
    const sysPath = `/sys/class/input/event${s.eventNode}/device`;
    const phys = await readSysfsText(join(sysPath, "phys"));
    const result: EnrichResult = { slot: s.slot, physPath: phys ?? undefined };

    // Connection-type refinement (Ember's detectConnectionType heuristics).
    const p = (phys ?? "").trim();
    if (MAC_RE.test(p) || p.toLowerCase().includes("bluetooth")) {
      result.connectionType = "bluetooth";
    } else if (s.vendorId === 0x054c && !p.startsWith("usb-")) {
      result.connectionType = "bluetooth"; // hid-sony non-USB
    } else if (p.startsWith("usb-")) {
      result.connectionType = s.connType === PadConnType.DONGLE ? "dongle" : "wired";
    }

    let rssi: number | undefined;
    let battery: number | undefined;
    if (result.connectionType === "bluetooth") {
      rssi = await findBluetoothRssi(sysPath);
      if (phys && MAC_RE.test(phys)) battery = await findBatteryLevel(phys);
    }

    if (rssi !== undefined) {
      result.rssi = rssi;
      this.writer.setHostMeta(s.slot, rssi, 0);
    }
    if (battery !== undefined) result.battery = battery;
    return result;
  }
}
