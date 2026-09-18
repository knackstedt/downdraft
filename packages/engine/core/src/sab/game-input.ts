// ============================================================================
// Game Input Buffer — SharedArrayBuffer for per-player input state
// Multi-player slot-based input channel with keys, mouse, gamepad, and builder state.
// ============================================================================

import { defineChannel } from "./define";

export const MAX_INPUT_PLAYERS = 4;

export const InputChannel = defineChannel({
  name: "game-input",
  magic: 0x494e5054,
  version: 1,
  mode: "slots",
  header: {
    size: 64,
    fields: {
      playerCount: { type: "u32" },
    },
  },
  sections: [
    {
      name: "players",
      maxSlots: MAX_INPUT_PLAYERS,
      slotSize: 128,
      fields: {
        keys: { type: "u32", count: 8 },
        mouseX: { type: "f32" },
        mouseY: { type: "f32" },
        mouseBtn: { type: "u32" },
        wheel: { type: "f32" },
        gpAxes: { type: "f32", count: 8 },
        gpBtn: { type: "u32" },
        flags: { type: "u32" },
        mouseDx: { type: "f32" },
        mouseDy: { type: "f32" },
        cameraZoom: { type: "f32" },
        lookHeading: { type: "f32" },
        lookPitch: { type: "f32" },
        builderCellType: { type: "u32" },
        builderRotation: { type: "u32" },
      },
    },
  ],
});

export const INPUT_MAGIC = 0x494e5054;
export const INPUT_VERSION = 1;

export const INP_HDR = {
  MAGIC: 0,
  VERSION: 1,
  PLAYER_COUNT: 3,
  SEQUENCE: 2,
} as const;

export const INP = {
  KEYS: 0,
  MOUSE_X: 8,
  MOUSE_Y: 9,
  MOUSE_BTN: 10,
  WHEEL: 11,
  GP_AXES: 12,
  GP_BTN: 20,
  FLAGS: 21,
  MOUSE_DX: 22,
  MOUSE_DY: 23,
  CAMERA_ZOOM: 24,
  LOOK_HEADING: 25,
  LOOK_PITCH: 26,
  BUILDER_CELL_TYPE: 27,
  BUILDER_ROTATION: 28,
} as const;

export const INP_FLAG = {
  CONNECTED: 1 << 0,
  HAS_GAMEPAD: 1 << 1,
} as const;

export const KEY = {
  W: 87, A: 65, S: 83, D: 68,
  Q: 81, E: 69, R: 82, F: 70,
  SHIFT: 16, CTRL: 17, ALT: 18, TAB: 9,
  SPACE: 32, ENTER: 13, ESC: 27,
  ONE: 49, TWO: 50, THREE: 51, FOUR: 52,
  FIVE: 53, SIX: 54, SEVEN: 55, EIGHT: 56,
  NINE: 57, ZERO: 48,
  I: 73, B: 66, C: 67, M: 77, P: 80,
  T: 84, V: 86, Z: 90, X: 88,
  UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  BRACKET_LEFT: 219,
  BRACKET_RIGHT: 221,
} as const;

export class InputBufferWriter {
  private writer: ReturnType<typeof InputChannel.writer>;
  private slots: ReturnType<typeof InputChannel.writer>["sections"]["players"];

  constructor(sab: SharedArrayBuffer) {
    this.writer = InputChannel.writer(sab);
    this.slots = this.writer.sections.players;
  }

  init() {
    this.writer.header.u32[InputChannel.offsets.header.playerCount] = 0;
  }

  setPlayerCount(n: number) { this.writer.header.u32[InputChannel.offsets.header.playerCount] = n; }

  incrementSequence() { this.writer.bumpSequence(); }

  private slot(playerIdx: number) {
    return this.slots.slot(playerIdx);
  }

  setKey(playerIdx: number, keyCode: number, pressed: boolean) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    const wordIdx = Math.floor(keyCode / 32);
    const bitIdx = keyCode % 32;
    if (pressed) {
      sv.u32[f.keys + wordIdx] |= (1 << bitIdx);
    } else {
      sv.u32[f.keys + wordIdx] &= ~(1 << bitIdx);
    }
  }

  setMousePos(playerIdx: number, x: number, y: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.mouseX] = x;
    sv.f32[f.mouseY] = y;
  }

  setMouseButton(playerIdx: number, button: number, pressed: boolean) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    if (pressed) {
      sv.u32[f.mouseBtn] |= (1 << button);
    } else {
      sv.u32[f.mouseBtn] &= ~(1 << button);
    }
  }

  setWheel(playerIdx: number, delta: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.wheel] += delta;
  }

  setMouseDelta(playerIdx: number, dx: number, dy: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.mouseDx] = dx;
    sv.f32[f.mouseDy] = dy;
  }

  setGamepadAxis(playerIdx: number, axis: number, value: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.gpAxes + axis] = value;
  }

  setGamepadButton(playerIdx: number, button: number, pressed: boolean) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    if (pressed) {
      sv.u32[f.gpBtn] |= (1 << button);
    } else {
      sv.u32[f.gpBtn] &= ~(1 << button);
    }
  }

  setFlags(playerIdx: number, flags: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.u32[f.flags] = flags;
  }

  setCameraZoom(playerIdx: number, zoom: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.cameraZoom] = zoom;
  }

  setLookHeading(playerIdx: number, heading: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.lookHeading] = heading;
  }

  setLookPitch(playerIdx: number, pitch: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.f32[f.lookPitch] = pitch;
  }

  setBuilderCellType(playerIdx: number, cellTypeIdx: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.u32[f.builderCellType] = cellTypeIdx;
  }

  setBuilderRotation(playerIdx: number, rotation: number) {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    sv.u32[f.builderRotation] = rotation;
  }
}

export class InputBufferReader {
  private reader: ReturnType<typeof InputChannel.reader>;
  private slots: ReturnType<typeof InputChannel.reader>["sections"]["players"];

  constructor(sab: SharedArrayBuffer) {
    this.reader = InputChannel.reader(sab);
    this.slots = this.reader.sections.players;
  }

  isValid(): boolean {
    return this.reader.isValid();
  }

  validationError(): string | null {
    return this.reader.validationError();
  }

  getSequence(): number { return this.reader.getSequence(); }
  getPlayerCount(): number { return this.reader.header.u32[InputChannel.offsets.header.playerCount]; }

  private slot(playerIdx: number) {
    return this.slots.slot(playerIdx);
  }

  isKeyDown(playerIdx: number, keyCode: number): boolean {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    const wordIdx = Math.floor(keyCode / 32);
    const bitIdx = keyCode % 32;
    return (sv.u32[f.keys + wordIdx] & (1 << bitIdx)) !== 0;
  }

  getMousePos(playerIdx: number): { x: number; y: number } {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return { x: sv.f32[f.mouseX], y: sv.f32[f.mouseY] };
  }

  isMouseDown(playerIdx: number, button: number): boolean {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return (sv.u32[f.mouseBtn] & (1 << button)) !== 0;
  }

  getWheel(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.f32[f.wheel];
  }

  consumeWheel(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    const w = sv.f32[f.wheel];
    sv.f32[f.wheel] = 0;
    return w;
  }

  getMouseDelta(playerIdx: number): { dx: number; dy: number } {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return { dx: sv.f32[f.mouseDx], dy: sv.f32[f.mouseDy] };
  }

  consumeMouseDelta(playerIdx: number): { dx: number; dy: number } {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    const dx = sv.f32[f.mouseDx];
    const dy = sv.f32[f.mouseDy];
    sv.f32[f.mouseDx] = 0;
    sv.f32[f.mouseDy] = 0;
    return { dx, dy };
  }

  getGamepadAxis(playerIdx: number, axis: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.f32[f.gpAxes + axis];
  }

  isGamepadButtonDown(playerIdx: number, button: number): boolean {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return (sv.u32[f.gpBtn] & (1 << button)) !== 0;
  }

  getFlags(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.u32[f.flags];
  }

  getCameraZoom(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.f32[f.cameraZoom];
  }

  getLookHeading(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.f32[f.lookHeading];
  }

  getLookPitch(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.f32[f.lookPitch];
  }

  getBuilderCellType(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.u32[f.builderCellType];
  }

  getBuilderRotation(playerIdx: number): number {
    const sv = this.slot(playerIdx);
    const f = InputChannel.offsets.sections.players.fields;
    return sv.u32[f.builderRotation];
  }
}
