import { defineChannel } from "./define";

export interface MultiInputChannelOptions {
  maxPlayers?: number;
  keyBitfieldCount?: number;
}

export function createMultiInputChannel(opts: MultiInputChannelOptions = {}) {
  const maxPlayers = opts.maxPlayers ?? 8;
  const keyCount = opts.keyBitfieldCount ?? 8;

  return defineChannel({
    name: "multi-input",
    magic: 0x4d495043,
    // v2: gamepadButtons is now a u32 bitmask pair ([lo, hi], W3C standard
    // button order = GP_BTN_* in ./gamepad-devices.ts), gamepadAxes grows to
    // 8 (lx ly rx ry lt rt dpadX dpadY), and gamepadSlot binds the player to
    // a device-table slot in the 'gamepad-devices' channel (0xFF = none).
    version: 2,
    mode: "slots",
    header: { size: 64, fields: {} },
    sections: [
      {
        name: "players",
        maxSlots: maxPlayers,
        slotSize: 256,
        fields: {
          keys: { type: "i32", count: keyCount },
          mouseX: { type: "f32" },
          mouseY: { type: "f32" },
          mouseDeltaX: { type: "f32" },
          mouseDeltaY: { type: "f32" },
          mouseButtons: { type: "i32", count: 3 },
          wheelDelta: { type: "f32" },
          gamepadButtons: { type: "u32", count: 2 },
          gamepadAxes: { type: "f32", count: 8 },
          gamepadSlot: { type: "u32" },
          flags: { type: "u32" },
        },
      },
    ],
  });
}

export const DEFAULT_MAX_PLAYERS = 8;
export const DEFAULT_KEY_BITFIELD_COUNT = 8;

export const MultiInputChannel = createMultiInputChannel();

export type MultiInputChannelInstance = ReturnType<typeof createMultiInputChannel>;
