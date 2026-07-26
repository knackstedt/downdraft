// ─── Input State (enhanced with mouse-look, gamepad, camera) ──

export interface InputState {
  keys: Set<string>;
  pressed: Set<string>;
  keyBits: Uint8Array;        // 256-bit key bitmask (32 bytes)
  mouseDX: number;            // mouse delta X for look
  mouseDY: number;            // mouse delta Y for look
  mouseBtn: number;           // mouse button bitmask
  wheel: number;              // scroll wheel delta
  cameraZoom: number;         // third-person camera distance
  lookHeading: number;        // renderer-side heading (radians)
  lookPitch: number;          // renderer-side pitch (radians)
  gamepadAxes: Float32Array;  // 8 axes: lx, ly, rx, ry, lt, rt, dpadX, dpadY
  gamepadBtn: number;         // gamepad button bitmask
  hotbarSlot: number;         // selected hotbar slot (0-9)
  builderCellType: number;    // selected builder cell type
  builderRotation: number;    // builder rotation steps (0-3)
}

export function createInputState(): InputState {
  return {
    keys: new Set<string>(),
    pressed: new Set<string>(),
    keyBits: new Uint8Array(32),
    mouseDX: 0, mouseDY: 0, mouseBtn: 0, wheel: 0,
    cameraZoom: 15,
    lookHeading: 0, lookPitch: 0.3,
    gamepadAxes: new Float32Array(8),
    gamepadBtn: 0,
    hotbarSlot: 0,
    builderCellType: 0, builderRotation: 0,
  };
}

export function isKeyDown(input: InputState, keyCode: number): boolean {
  const wordIdx = Math.floor(keyCode / 8);
  const bitIdx = keyCode % 8;
  return (input.keyBits[wordIdx] & (1 << bitIdx)) !== 0;
}

export function setKey(input: InputState, keyCode: number, pressed: boolean) {
  const wordIdx = Math.floor(keyCode / 8);
  const bitIdx = keyCode % 8;
  if (pressed) {
    input.keyBits[wordIdx] |= (1 << bitIdx);
  } else {
    input.keyBits[wordIdx] &= ~(1 << bitIdx);
  }
}

export function consumeWheel(input: InputState): number {
  const w = input.wheel;
  input.wheel = 0;
  return w;
}

export function consumeMouseDelta(input: InputState): { dx: number; dy: number } {
  const dx = input.mouseDX;
  const dy = input.mouseDY;
  input.mouseDX = 0;
  input.mouseDY = 0;
  return { dx, dy };
}
