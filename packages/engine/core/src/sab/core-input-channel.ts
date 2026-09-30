import { defineChannel } from "./define";

export const CoreInputChannel = defineChannel({
  name: "core-input",
  magic: 0x434f4950,
  // v2: gamepadButtons → u32 bitmask pair [lo, hi] (W3C standard order,
  // GP_BTN_* in gamepad-devices.ts); gamepadAxes → 8 (lx ly rx ry lt rt
  // dpadX dpadY). Mirrors the multi-input v2 upgrade.
  version: 2,
  mode: "record",
  header: { size: 64, fields: {} },
  fields: {
    keys: { type: "i32", count: 8 },
    mouseX: { type: "f32" },
    mouseY: { type: "f32" },
    mouseDeltaX: { type: "f32" },
    mouseDeltaY: { type: "f32" },
    mouseButtons: { type: "i32", count: 3 },
    wheelDelta: { type: "f32" },
    gamepadButtons: { type: "u32", count: 2 },
    gamepadAxes: { type: "f32", count: 8 },
  },
});
