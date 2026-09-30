// ============================================================================
// Gamepad Devices Buffer — per-device gamepad metadata + state
// Writer: the native downdraft_gamepad cdylib worker thread (Rust) writes every
//   field EXCEPT `hostMeta`, which is owned by JS sysfs/enrichment code.
// Readers: renderer/main thread (device discovery, nav, enrichment output).
//
// This channel is a *device table* — identity, connection, battery, name — and
// a raw-state mirror. Per-player routed input lives in MultiInputChannel.
// ============================================================================

import { defineChannel } from "./define";

export const GAMEPAD_DEVICES_MAGIC = 0x50474444; // "DDGP"
export const GAMEPAD_DEVICES_VERSION = 1;
export const GAMEPAD_MAX_SLOTS = 16;

/** Pad classification written by the native backend (mirrors Rust pad_type). */
export const PadType = {
  UNKNOWN: 0,
  XBOX: 1,
  PS3: 2,
  PS4: 3,
  PS5: 4,
  SWITCH: 5,
  GAMECUBE: 6,
  N64: 7,
  WIIMOTE: 8,
  STEAM: 9,
  GENERIC: 10,
} as const;
export type PadTypeValue = (typeof PadType)[keyof typeof PadType];

/** Connection classification (mirrors Rust conn_type). */
export const PadConnType = {
  UNKNOWN: 0,
  WIRED: 1,
  BLUETOOTH: 2,
  DONGLE: 3,
} as const;
export type PadConnTypeValue = (typeof PadConnType)[keyof typeof PadConnType];

/** meta1 flag bits. */
export const PAD_FLAG = {
  FF_SUPPORTED: 1 << 0,
  CHARGING: 1 << 1,
  AUX_DEVICE: 1 << 2,
} as const;

/** Battery sentinels (meta0 >> 24). */
export const PAD_BATTERY_UNKNOWN = 255;
export const PAD_BATTERY_WIRED = 254;

/** Standard-layout button bitmask (buttonsLo; buttonsHi is reserved for
 *  touchpad/paddle/misc). Bit indices match W3C standard mapping order. */
export const GP_BTN = {
  SOUTH: 0,
  EAST: 1,
  WEST: 2,
  NORTH: 3,
  LEFT_SHOULDER: 4,
  RIGHT_SHOULDER: 5,
  LEFT_TRIGGER_BTN: 6,
  RIGHT_TRIGGER_BTN: 7,
  SELECT: 8,
  START: 9,
  HOME: 10,
  LEFT_STICK: 11,
  RIGHT_STICK: 12,
  DPAD_UP: 13,
  DPAD_DOWN: 14,
  DPAD_LEFT: 15,
  DPAD_RIGHT: 16,
  C: 17,
  Z: 18,
  CAPTURE: 19,
} as const;

/** Axis indices in axes[8]. */
export const GP_AXIS = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
  LEFT_TRIGGER: 4,
  RIGHT_TRIGGER: 5,
  DPAD_X: 6,
  DPAD_Y: 7,
} as const;

export const GamepadDevicesChannel = defineChannel({
  name: "gamepad-devices",
  magic: GAMEPAD_DEVICES_MAGIC,
  version: GAMEPAD_DEVICES_VERSION,
  mode: "slots",
  header: {
    size: 64,
    fields: {
      connectedMask: { type: "u32" },
    },
  },
  sections: [
    {
      name: "pads",
      maxSlots: GAMEPAD_MAX_SLOTS,
      slotSize: 128,
      // Field order is the ABI — must stay in sync with
      // packages/platform-native/native-gamepad/src/lib.rs SLOT_* offsets.
      fields: {
        meta0: { type: "u32" }, // connected | padType<<8 | connType<<16 | battery<<24
        meta1: { type: "u32" }, // PAD_FLAG_*
        hostMeta: { type: "u32" }, // rssi | jsFlags<<8 | reserved — JS writes this
        buttonsLo: { type: "u32" },
        buttonsHi: { type: "u32" },
        axes: { type: "f32", count: 8 },
        lastEventMs: { type: "u32" },
        slotSeq: { type: "u32" },
        vendorId: { type: "u32" },
        productId: { type: "u32" },
        name: { type: "u32", count: 14 }, // 56 B NUL-padded UTF-8
        aux: { type: "u32" }, // Linux: /dev/input/eventN index; 0xFFFF unknown
      },
    },
  ],
});

export type GamepadDevicesChannelInstance = typeof GamepadDevicesChannel;

/** Decoded view of one pad slot. */
export interface GamepadDeviceSlot {
  slot: number;
  connected: boolean;
  padType: PadTypeValue;
  connType: PadConnTypeValue;
  /** 0..100, or PAD_BATTERY_UNKNOWN / PAD_BATTERY_WIRED. */
  battery: number;
  rssi: number; // 0..100, 255 = unknown
  flags: number;
  buttonsLo: number;
  buttonsHi: number;
  axes: Float32Array;
  lastEventMs: number;
  slotSeq: number;
  vendorId: number;
  productId: number;
  name: string;
  /** Linux /dev/input/eventN index for sysfs correlation; -1 when unknown. */
  eventNode: number;
}

const textDecoder = new TextDecoder();

/**
 * Reader for the device table. Construct per-thread over the shared buffer;
 * call `readSlot`/`readConnected` from the consuming side only.
 */
export class GamepadDevicesReader {
  private reader: ReturnType<typeof GamepadDevicesChannel.reader>;
  private pads: ReturnType<typeof GamepadDevicesChannel.reader>["sections"]["pads"];

  constructor(sab: SharedArrayBuffer) {
    this.reader = GamepadDevicesChannel.reader(sab);
    this.pads = this.reader.sections.pads;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  validationError(): string | null {
    return this.reader.validationError();
  }

  getSequence(): number {
    return this.reader.getSequence();
  }

  hasChanged(lastSeen: number): boolean {
    return this.reader.hasChanged(lastSeen);
  }

  getConnectedMask(): number {
    return this.reader.header.u32[GamepadDevicesChannel.offsets.header.connectedMask];
  }

  private slotViews(slot: number) {
    return this.pads.slot(slot);
  }

  readSlot(slot: number, out?: Partial<GamepadDeviceSlot>): GamepadDeviceSlot | null {
    const f = GamepadDevicesChannel.offsets.sections.pads.fields;
    const sv = this.slotViews(slot);
    const meta0 = sv.u32[f.meta0];
    if ((meta0 & 0xff) === 0) return null;

    const axes =
      (out?.axes as Float32Array | undefined) ?? new Float32Array(8);
    axes.set(sv.f32.subarray(f.axes, f.axes + 8));

    // Decode the 56-byte NUL-padded name. Reinterpret the slot u32 region.
    const nameBytes = new Uint8Array(
      sv.u32.buffer,
      sv.u32.byteOffset + f.name * 4,
      56,
    );
    let nameLen = nameBytes.indexOf(0);
    if (nameLen < 0) nameLen = 56;

    return {
      slot,
      connected: true,
      padType: ((meta0 >>> 8) & 0xff) as PadTypeValue,
      connType: ((meta0 >>> 16) & 0xff) as PadConnTypeValue,
      battery: (meta0 >>> 24) & 0xff,
      rssi: sv.u32[f.hostMeta] & 0xff,
      flags: sv.u32[f.meta1],
      buttonsLo: sv.u32[f.buttonsLo],
      buttonsHi: sv.u32[f.buttonsHi],
      axes,
      lastEventMs: sv.u32[f.lastEventMs],
      slotSeq: sv.u32[f.slotSeq],
      vendorId: sv.u32[f.vendorId],
      productId: sv.u32[f.productId],
      name: textDecoder.decode(nameBytes.subarray(0, nameLen)),
      eventNode: (sv.u32[f.aux] & 0xffff) === 0xffff ? -1 : sv.u32[f.aux] & 0xffff,
    };
  }

  /** Iterate all currently-connected slots. Allocates one object per pad —
   *  fine for UI/discovery at event cadence; for per-frame input read
   *  axes/buttons directly via `rawSlot`. */
  *readConnected(): Generator<GamepadDeviceSlot> {
    const mask = this.getConnectedMask();
    for (let i = 0; i < GAMEPAD_MAX_SLOTS; i++) {
      if (mask & (1 << i)) {
        const d = this.readSlot(i);
        if (d) yield d;
      }
    }
  }
}

/**
 * Writer for the JS-owned enrichment field (`hostMeta`). Only JS sysfs
 * enrichment should construct this — the native worker owns everything else.
 */
export class GamepadDevicesHostMetaWriter {
  private pads: ReturnType<typeof GamepadDevicesChannel.writer>["sections"]["pads"];

  constructor(sab: SharedArrayBuffer) {
    this.pads = GamepadDevicesChannel.writer(sab).sections.pads;
  }

  /** Write RSSI (0..100, 255 unknown) + JS flag byte for a slot. */
  setHostMeta(slot: number, rssi: number, jsFlags = 0) {
    const f = GamepadDevicesChannel.offsets.sections.pads.fields;
    const sv = this.pads.slot(slot);
    sv.u32[f.hostMeta] = ((rssi & 0xff) | ((jsFlags & 0xff) << 8)) >>> 0;
  }
}
