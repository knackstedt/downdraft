// ============================================================================
// Input Buffer — SharedArrayBuffer for per-player input state
// ============================================================================

const MAX_PLAYERS = 4;

export const INPUT_MAGIC = 0x494e5054; // 'INPT'
export const INPUT_VERSION = 1;

// Header (64 bytes / 16 u32s)
// [0] magic, [1] version, [2] playerCount, [3] sequence (atomic)
// [4..15] reserved

export const INP_HDR = {
  MAGIC: 0,
  VERSION: 1,
  PLAYER_COUNT: 2,
  SEQUENCE: 3,
} as const;

// Per-player slot (128 bytes = 32 f32s)
// [0..7]   key bitmask (8 x u32 = 256 bits)
// [8]  mouse X (f32)
// [9]  mouse Y (f32)
// [10] mouse buttons (u32 bitmask: bit0=left, bit1=right, bit2=middle)
// [11] wheel delta (f32)
// [12..19] gamepad axes (f32x8: lx, ly, rx, ry, lt, rt, dpadX, dpadY)
// [20] gamepad buttons (u32 bitmask)
// [21] flags (u32: connected, hasGamepad)
// [22] mouse delta X (f32) — for mouse-look
// [23] mouse delta Y (f32) — for mouse-look
// [24..31] reserved

export const INP = {
  KEYS: 0,        // first 8 u32s = 256 key bits
  MOUSE_X: 8,
  MOUSE_Y: 9,
  MOUSE_BTN: 10,
  WHEEL: 11,
  GP_AXES: 12,    // 8 f32s
  GP_BTN: 20,
  FLAGS: 21,
  MOUSE_DX: 22,
  MOUSE_DY: 23,
  CAMERA_ZOOM: 24, // third-person camera distance (f32)
  LOOK_HEADING: 25, // renderer-side heading (f32) — sim reads for movement
  LOOK_PITCH: 26,   // renderer-side pitch (f32)
  BUILDER_CELL_TYPE: 27, // u32 — selected cell type index into BUILDER_CELL_OPTIONS
  BUILDER_ROTATION: 28, // u32 — rotation steps (0-3) for builder placement
} as const;

export const INP_FLAG = {
  CONNECTED: 1 << 0,
  HAS_GAMEPAD: 1 << 1,
} as const;

// Key codes (subset — mapped to bit positions in the 256-bit key bitmask)
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
  F5: 116,
  BRACKET_LEFT: 219,  // [ key
  BRACKET_RIGHT: 221, // ] key
} as const;

export class InputBufferWriter {
  private u32: Uint32Array;
  private f32: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
  }

  init() {
    this.u32[INP_HDR.MAGIC] = INPUT_MAGIC;
    this.u32[INP_HDR.VERSION] = INPUT_VERSION;
    this.u32[INP_HDR.PLAYER_COUNT] = 0;
  }

  setPlayerCount(n: number) { this.u32[INP_HDR.PLAYER_COUNT] = n; }

  incrementSequence() { Atomics.add(this.u32, INP_HDR.SEQUENCE, 1); }

  setKey(playerIdx: number, keyCode: number, pressed: boolean) {
    const base = 16 + playerIdx * 32; // 16 header u32s + 32 per slot
    const wordIdx = Math.floor(keyCode / 32);
    const bitIdx = keyCode % 32;
    if (pressed) {
      this.u32[base + INP.KEYS + wordIdx] |= (1 << bitIdx);
    } else {
      this.u32[base + INP.KEYS + wordIdx] &= ~(1 << bitIdx);
    }
  }

  setMousePos(playerIdx: number, x: number, y: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.MOUSE_X] = x;
    this.f32[base + INP.MOUSE_Y] = y;
  }

  setMouseButton(playerIdx: number, button: number, pressed: boolean) {
    const base = 16 + playerIdx * 32;
    if (pressed) {
      this.u32[base + INP.MOUSE_BTN] |= (1 << button);
    } else {
      this.u32[base + INP.MOUSE_BTN] &= ~(1 << button);
    }
  }

  setWheel(playerIdx: number, delta: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.WHEEL] = delta;
  }

  setMouseDelta(playerIdx: number, dx: number, dy: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.MOUSE_DX] = dx;
    this.f32[base + INP.MOUSE_DY] = dy;
  }

  setGamepadAxis(playerIdx: number, axis: number, value: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.GP_AXES + axis] = value;
  }

  setGamepadButton(playerIdx: number, button: number, pressed: boolean) {
    const base = 16 + playerIdx * 32;
    if (pressed) {
      this.u32[base + INP.GP_BTN] |= (1 << button);
    } else {
      this.u32[base + INP.GP_BTN] &= ~(1 << button);
    }
  }

  setFlags(playerIdx: number, flags: number) {
    const base = 16 + playerIdx * 32;
    this.u32[base + INP.FLAGS] = flags;
  }

  setCameraZoom(playerIdx: number, zoom: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.CAMERA_ZOOM] = zoom;
  }

  setLookHeading(playerIdx: number, heading: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.LOOK_HEADING] = heading;
  }

  setLookPitch(playerIdx: number, pitch: number) {
    const base = 16 + playerIdx * 32;
    this.f32[base + INP.LOOK_PITCH] = pitch;
  }

  setBuilderCellType(playerIdx: number, cellTypeIdx: number) {
    const base = 16 + playerIdx * 32;
    this.u32[base + INP.BUILDER_CELL_TYPE] = cellTypeIdx;
  }

  setBuilderRotation(playerIdx: number, rotation: number) {
    const base = 16 + playerIdx * 32;
    this.u32[base + INP.BUILDER_ROTATION] = rotation;
  }
}

export class InputBufferReader {
  private sab: SharedArrayBuffer;
  private u32: Uint32Array;
  private f32: Float32Array;

  constructor(sab: SharedArrayBuffer) {
    this.sab = sab;
    this.u32 = new Uint32Array(sab);
    this.f32 = new Float32Array(sab);
  }

  isValid(): boolean {
    return this.u32[INP_HDR.MAGIC] === INPUT_MAGIC;
  }

  getSequence(): number { return Atomics.load(this.u32, INP_HDR.SEQUENCE); }
  getPlayerCount(): number { return this.u32[INP_HDR.PLAYER_COUNT]; }

  isKeyDown(playerIdx: number, keyCode: number): boolean {
    const base = 16 + playerIdx * 32;
    const wordIdx = Math.floor(keyCode / 32);
    const bitIdx = keyCode % 32;
    return (this.u32[base + INP.KEYS + wordIdx] & (1 << bitIdx)) !== 0;
  }

  getMousePos(playerIdx: number): { x: number; y: number } {
    const base = 16 + playerIdx * 32;
    return { x: this.f32[base + INP.MOUSE_X], y: this.f32[base + INP.MOUSE_Y] };
  }

  isMouseDown(playerIdx: number, button: number): boolean {
    const base = 16 + playerIdx * 32;
    return (this.u32[base + INP.MOUSE_BTN] & (1 << button)) !== 0;
  }

  getWheel(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.f32[base + INP.WHEEL];
  }

  consumeWheel(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    const w = this.f32[base + INP.WHEEL];
    this.f32[base + INP.WHEEL] = 0;
    return w;
  }

  getMouseDelta(playerIdx: number): { dx: number; dy: number } {
    const base = 16 + playerIdx * 32;
    return { dx: this.f32[base + INP.MOUSE_DX], dy: this.f32[base + INP.MOUSE_DY] };
  }

  consumeMouseDelta(playerIdx: number): { dx: number; dy: number } {
    const base = 16 + playerIdx * 32;
    const dx = this.f32[base + INP.MOUSE_DX];
    const dy = this.f32[base + INP.MOUSE_DY];
    this.f32[base + INP.MOUSE_DX] = 0;
    this.f32[base + INP.MOUSE_DY] = 0;
    return { dx, dy };
  }

  getGamepadAxis(playerIdx: number, axis: number): number {
    const base = 16 + playerIdx * 32;
    return this.f32[base + INP.GP_AXES + axis];
  }

  isGamepadButtonDown(playerIdx: number, button: number): boolean {
    const base = 16 + playerIdx * 32;
    return (this.u32[base + INP.GP_BTN] & (1 << button)) !== 0;
  }

  getFlags(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.u32[base + INP.FLAGS];
  }

  getCameraZoom(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.f32[base + INP.CAMERA_ZOOM];
  }

  getLookHeading(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.f32[base + INP.LOOK_HEADING];
  }

  getLookPitch(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.f32[base + INP.LOOK_PITCH];
  }

  getBuilderCellType(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.u32[base + INP.BUILDER_CELL_TYPE];
  }

  getBuilderRotation(playerIdx: number): number {
    const base = 16 + playerIdx * 32;
    return this.u32[base + INP.BUILDER_ROTATION];
  }
}
