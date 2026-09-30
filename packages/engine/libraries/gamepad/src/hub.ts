// ============================================================================
// GamepadHub — engine-native gamepad device API over the 'gamepad-devices'
// SAB channel. Runtime-agnostic: reads whatever producer wrote the channel
// (native downdraft_gamepad cdylib today; other producers possible).
//
// This is the object games and UI toolkits consume — an evented, per-device
// API. Do NOT polyfill navigator.getGamepads() on native; that API can't
// express hotplug ordering, battery, or device identity.
// ============================================================================

import {
  GamepadDevicesChannel,
  GamepadDevicesReader,
  GAMEPAD_MAX_SLOTS,
  PAD_FLAG,
  PAD_BATTERY_UNKNOWN,
  PAD_BATTERY_WIRED,
  type GamepadDeviceSlot,
  type PadTypeValue,
  type PadConnTypeValue,
} from "@downdraft/engine/sab/gamepad-devices";
import { glyphFor, type GlyphResult } from "./glyphs";

export interface GamepadDeviceInfo {
  slot: number;
  name: string;
  padType: PadTypeValue;
  connType: PadConnTypeValue;
  vendorId: number;
  productId: number;
  /** Linux /dev/input/eventN index; -1 when unknown. */
  eventNode: number;
  ffSupported: boolean;
}

/** A live view of one device slot. Cheap to construct — wraps the reader. */
export class GamepadDevice {
  constructor(
    private reader: GamepadDevicesReader,
    private hub: GamepadHub,
    readonly info: GamepadDeviceInfo,
  ) {}

  private state(): GamepadDeviceSlot | null {
    return this.reader.readSlot(this.info.slot);
  }

  get slot(): number {
    return this.info.slot;
  }

  get connected(): boolean {
    return this.state() !== null;
  }

  /** Battery 0..100, or null when unknown/wired. */
  get batteryPercent(): number | null {
    const s = this.state();
    if (!s) return null;
    if (s.battery === PAD_BATTERY_UNKNOWN || s.battery === PAD_BATTERY_WIRED) return null;
    return s.battery;
  }

  get charging(): boolean {
    const s = this.state();
    return s !== null && (s.flags & PAD_FLAG.CHARGING) !== 0;
  }

  /** RSSI 0..100 (JS sysfs enrichment), null when unknown. */
  get signalPercent(): number | null {
    const s = this.state();
    if (!s || s.rssi === 0xff) return null;
    return s.rssi;
  }

  /** Is a W3C-standard button bit currently held? */
  pressed(bit: number): boolean {
    const s = this.state();
    if (!s) return false;
    return bit < 32
      ? (s.buttonsLo & (1 << bit)) !== 0
      : (s.buttonsHi & (1 << (bit - 32))) !== 0;
  }

  /** Raw axis value: lx ly rx ry lt rt dpadX dpadY (0..7). */
  axis(i: number): number {
    const s = this.state();
    return s ? s.axes[i] : 0;
  }

  /** All 8 axes, copied into `out` when provided. */
  axes(out?: Float32Array): Float32Array {
    const s = this.state();
    const dst = out ?? new Float32Array(8);
    if (s) dst.set(s.axes);
    else dst.fill(0);
    return dst;
  }

  /** Glyph descriptor for a button bit on this pad type. */
  glyphFor(bit: number): GlyphResult {
    return glyphFor(this.info.padType, bit);
  }

  /** Rumble (dual-motor). Requires the host to have provided a rumble hook. */
  rumble(weak: number, strong: number, ms: number): void {
    this.hub.rumble(this.info.slot, weak, strong, ms);
  }
}

export interface GamepadHubOptions {
  /**
   * Host-provided rumble hook (slot, weak 0..65535, strong 0..65535, ms).
   * On the native runtime platform-native wires this to dd_pad_rumble.
   */
  rumble?: (slot: number, weak: number, strong: number, ms: number) => void;
}

type HubEvent = "connect" | "disconnect";

/**
 * Device-table facade. Call `poll()` once per frame (or per UI update) — it
 * diffs the connected mask and emits connect/disconnect events.
 */
export class GamepadHub {
  private reader: GamepadDevicesReader;
  private devices = new Map<number, GamepadDevice>();
  private listeners: Record<HubEvent, ((dev: GamepadDevice) => void)[]> = {
    connect: [],
    disconnect: [],
  };
  private opts: GamepadHubOptions;
  private lastSeq = -1;

  constructor(sab: SharedArrayBuffer, opts: GamepadHubOptions = {}) {
    this.reader = new GamepadDevicesReader(sab);
    this.opts = opts;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  on(event: HubEvent, cb: (dev: GamepadDevice) => void): () => void {
    this.listeners[event].push(cb);
    return () => {
      const arr = this.listeners[event];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Snapshot the device table; emits connect/disconnect on changes. */
  poll(): void {
    const mask = this.reader.getConnectedMask();
    for (let slot = 0; slot < GAMEPAD_MAX_SLOTS; slot++) {
      const connected = (mask & (1 << slot)) !== 0;
      const existing = this.devices.get(slot);

      if (connected && !existing) {
        const s = this.reader.readSlot(slot);
        if (!s) continue;
        const dev = new GamepadDevice(this.reader, this, {
          slot,
          name: s.name,
          padType: s.padType,
          connType: s.connType,
          vendorId: s.vendorId,
          productId: s.productId,
          eventNode: s.eventNode,
          ffSupported: (s.flags & PAD_FLAG.FF_SUPPORTED) !== 0,
        });
        this.devices.set(slot, dev);
        for (const cb of this.listeners.connect) cb(dev);
      } else if (!connected && existing) {
        this.devices.delete(slot);
        for (const cb of this.listeners.disconnect) cb(existing);
      }
    }
    this.lastSeq = this.reader.getSequence();
  }

  /** Sequence counter from the channel header — bumped once per native pass. */
  get sequence(): number {
    return this.reader.getSequence();
  }

  /** Whether new state has been written since the last poll. */
  hasChanged(): boolean {
    return this.reader.getSequence() !== this.lastSeq;
  }

  /** Currently-connected devices, slot order. */
  list(): GamepadDevice[] {
    this.poll();
    return [...this.devices.values()].sort((a, b) => a.slot - b.slot);
  }

  device(slot: number): GamepadDevice | undefined {
    return this.devices.get(slot);
  }

  rumble(slot: number, weak: number, strong: number, ms: number): void {
    this.opts.rumble?.(slot, weak, strong, ms);
  }
}
