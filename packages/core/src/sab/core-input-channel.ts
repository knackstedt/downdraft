import { defineChannel } from "./define.ts";

export const CoreInputChannel = defineChannel({
  name: "core-input",
  magic: 0x434f4950,
  version: 1,
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
    gamepadButtons: { type: "i32", count: 4 },
    gamepadAxes: { type: "f32", count: 4 },
  },
});
