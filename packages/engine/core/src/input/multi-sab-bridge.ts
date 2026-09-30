import { MultiInputChannel, type MultiInputChannelInstance, createMultiInputChannel } from "../sab/multi-input-channel";
import type { FieldLayout, SlotSectionLayout } from "../sab/types";
import { MultiInputState } from "./multi-state";
import { InputState } from "./state";

interface FieldIndices {
  keysIdx: number;
  keysCount: number;
  mouseXIdx: number;
  mouseYIdx: number;
  mouseDeltaXIdx: number;
  mouseDeltaYIdx: number;
  mouseButtonsIdx: number;
  wheelDeltaIdx: number;
  gamepadButtonsIdx: number;
  gamepadAxesIdx: number;
  gamepadSlotIdx: number;
  flagsIdx: number;
}

function extractFieldIndices(sectionLayout: SlotSectionLayout): FieldIndices {
  const f = (name: string): FieldLayout => sectionLayout.fields[name];
  return {
    keysIdx: f("keys").index,
    keysCount: f("keys").count,
    mouseXIdx: f("mouseX").index,
    mouseYIdx: f("mouseY").index,
    mouseDeltaXIdx: f("mouseDeltaX").index,
    mouseDeltaYIdx: f("mouseDeltaY").index,
    mouseButtonsIdx: f("mouseButtons").index,
    wheelDeltaIdx: f("wheelDelta").index,
    gamepadButtonsIdx: f("gamepadButtons").index,
    gamepadAxesIdx: f("gamepadAxes").index,
    gamepadSlotIdx: f("gamepadSlot").index,
    flagsIdx: f("flags").index,
  };
}

export class MultiInputSABBridge {
  private reader: ReturnType<MultiInputChannelInstance["reader"]>;
  private state: MultiInputState;
  private maxPlayers: number;
  private prevKeys: Set<number>[];
  private indices: FieldIndices;

  constructor(sab: SharedArrayBuffer, state: MultiInputState, channel?: MultiInputChannelInstance) {
    const ch = channel ?? MultiInputChannel;
    this.reader = ch.reader(sab);
    this.state = state;
    this.maxPlayers = state.getMaxPlayers();
    this.prevKeys = [];
    for (let i = 0; i < this.maxPlayers; i++) {
      this.prevKeys.push(new Set());
    }
    const sectionLayout = ch.layout.sections?.[0];
    if (!sectionLayout) throw new Error("MultiInputChannel has no sections");
    this.indices = extractFieldIndices(sectionLayout);
  }

  poll(): void {
    const sections = this.reader.sections;
    if (!sections) return;
    const players = sections["players"];
    if (!players) return;

    for (let p = 0; p < this.maxPlayers; p++) {
      const slot = players.slot(p);
      const playerState = this.state.getPlayerState(p);

      this.pollKeys(slot, playerState, p);
      this.pollMouse(slot, playerState);
      this.pollGamepad(slot, playerState);
    }
  }

  private pollKeys(slot: { i32: Int32Array }, state: InputState, playerIdx: number): void {
    const { keysIdx, keysCount } = this.indices;
    const keysView = slot.i32;
    const incoming = new Set<number>();
    for (let i = 0; i < keysCount; i++) {
      const val = Atomics.load(keysView, keysIdx + i);
      if (val !== 0) {
        for (let bit = 0; bit < 32; bit++) {
          if (val & (1 << bit)) {
            incoming.add(i * 32 + bit);
          }
        }
      }
    }

    const prev = this.prevKeys[playerIdx];
    for (const code of incoming.values()) {
      if (!prev.has(code)) {
        state.keyDown(code);
      }
    }
    for (const code of prev.values()) {
      if (!incoming.has(code)) {
        state.keyUp(code);
      }
    }
    prev.clear();
    for (const code of incoming.values()) prev.add(code);
  }

  private pollMouse(slot: { f32: Float32Array; i32: Int32Array }, state: InputState): void {
    const f32 = slot.f32;
    const i32 = slot.i32;
    const idx = this.indices;

    const mouseX = f32[idx.mouseXIdx];
    const mouseY = f32[idx.mouseYIdx];
    const mouseDeltaX = f32[idx.mouseDeltaXIdx];
    const mouseDeltaY = f32[idx.mouseDeltaYIdx];
    state.mouseMove(mouseX, mouseY, mouseDeltaX, mouseDeltaY);

    const wheelDelta = f32[idx.wheelDeltaIdx];
    if (wheelDelta !== 0) {
      state.wheel(wheelDelta);
    }

    for (let i = 0; i < 3; i++) {
      const pressed = Atomics.load(i32, idx.mouseButtonsIdx + i) !== 0;
      if (pressed && !state.mouseButtons.has(i)) {
        state.mouseDown(i);
      } else if (!pressed && state.mouseButtons.has(i)) {
        state.mouseUp(i);
      }
    }
  }

  private pollGamepad(slot: { i32: Int32Array; u32: Uint32Array; f32: Float32Array }, state: InputState): void {
    const u32 = slot.u32;
    const f32 = slot.f32;
    const idx = this.indices;

    // gamepadButtons is a u32 pair [lo, hi] — W3C standard button order.
    const lo = Atomics.load(u32, idx.gamepadButtonsIdx) >>> 0;
    const hi = Atomics.load(u32, idx.gamepadButtonsIdx + 1) >>> 0;
    const incomingGamepad = new Set<number>();
    for (let b = 0; b < 32; b++) {
      if (lo & (1 << b)) incomingGamepad.add(b);
      if (hi & (1 << b)) incomingGamepad.add(32 + b);
    }
    for (const btn of incomingGamepad.values()) {
      state.gamepadButtons.add(btn);
    }
    for (const btn of state.gamepadButtons.values()) {
      if (!incomingGamepad.has(btn)) {
        state.gamepadButtons.delete(btn);
      }
    }

    const axes = f32.subarray(idx.gamepadAxesIdx, idx.gamepadAxesIdx + 8);
    for (let i = 0; i < axes.length && i < state.gamepadAxes.length; i++) {
      state.gamepadAxes[i] = axes[i];
    }
  }
}

export class MultiInputSABWriter {
  private writer: ReturnType<MultiInputChannelInstance["writer"]>;
  private maxPlayers: number;
  private indices: FieldIndices;

  constructor(sab: SharedArrayBuffer, channel?: MultiInputChannelInstance) {
    const ch = channel ?? MultiInputChannel;
    this.writer = ch.writer(sab);
    this.maxPlayers = ch.def.sections?.[0]?.maxSlots ?? 8;
    const sectionLayout = ch.layout.sections?.[0];
    if (!sectionLayout) throw new Error("MultiInputChannel has no sections");
    this.indices = extractFieldIndices(sectionLayout);
  }

  /**
   * Write one player's input snapshot.
   *
   * `gamepadButtons` is the u32 bitmask pair `[lo, hi]` (W3C standard button
   * order, see GP_BTN_* in ../sab/gamepad-devices.ts) — NOT a per-button 0/1
   * array. `gamepadAxes` is the 8-axis state (lx ly rx ry lt rt dpadX dpadY).
   * `gamepadSlot` binds the player to a slot in the 'gamepad-devices'
   * channel (0xFF = unbound).
   */
  writePlayerInput(
    playerIdx: number,
    keys: number[],
    mouseX: number,
    mouseY: number,
    mouseDeltaX: number,
    mouseDeltaY: number,
    mouseButtons: number[],
    wheelDelta: number,
    gamepadButtons: number[],
    gamepadAxes: number[],
    gamepadSlot = 0xff,
  ): void {
    if (playerIdx < 0 || playerIdx >= this.maxPlayers) return;
    const sections = this.writer.sections;
    if (!sections) return;
    const players = sections["players"];
    if (!players) return;

    const slot = players.slot(playerIdx);
    const i32 = slot.i32;
    const f32 = slot.f32;
    const idx = this.indices;

    const fillEnd = idx.keysIdx + idx.keysCount;
    if (idx.keysIdx < 0 || fillEnd > i32.length) {
      throw new RangeError(`MultiInputSABWriter: keys range [${idx.keysIdx}, ${fillEnd}) exceeds i32 buffer length ${i32.length}`);
    }
    i32.fill(0, idx.keysIdx, fillEnd);
    for (let _i = 0, _it = keys, _n = _it.length; _i < _n; _i++) { const key = _it[_i];
      if (key < 0 || !Number.isInteger(key)) continue;
      const wordIdx = Math.floor(key / 32);
      const bitIdx = key % 32;
      if (wordIdx >= 0 && wordIdx < idx.keysCount) {
        i32[idx.keysIdx + wordIdx] |= (1 << bitIdx);
      }
    }

    f32[idx.mouseXIdx] = mouseX;
    f32[idx.mouseYIdx] = mouseY;
    f32[idx.mouseDeltaXIdx] = mouseDeltaX;
    f32[idx.mouseDeltaYIdx] = mouseDeltaY;

    for (let i = 0; i < 3; i++) {
      Atomics.store(i32, idx.mouseButtonsIdx + i, i < mouseButtons.length ? mouseButtons[i] : 0);
    }

    f32[idx.wheelDeltaIdx] = wheelDelta;

    Atomics.store(i32, idx.gamepadButtonsIdx, gamepadButtons[0] ?? 0);
    Atomics.store(i32, idx.gamepadButtonsIdx + 1, gamepadButtons[1] ?? 0);
    for (let i = 0; i < 8; i++) {
      f32[idx.gamepadAxesIdx + i] = i < gamepadAxes.length ? gamepadAxes[i] : 0;
    }
    slot.u32[idx.gamepadSlotIdx] = gamepadSlot;

    this.writer.bumpSequence();
  }

  clearPlayer(playerIdx: number): void {
    if (playerIdx < 0 || playerIdx >= this.maxPlayers) return;
    const sections = this.writer.sections;
    if (!sections) return;
    const players = sections["players"];
    if (!players) return;

    const slot = players.slot(playerIdx);
    slot.i32.fill(0);
    slot.f32.fill(0);
    this.writer.bumpSequence();
  }

  bumpSequence(): void {
    this.writer.bumpSequence();
  }
}

export function createMultiInputBridge(
  sab: SharedArrayBuffer,
  state: MultiInputState,
  channel?: MultiInputChannelInstance,
): MultiInputSABBridge {
  return new MultiInputSABBridge(sab, state, channel);
}

export function createMultiInputWriter(
  sab: SharedArrayBuffer,
  channel?: MultiInputChannelInstance,
): MultiInputSABWriter {
  return new MultiInputSABWriter(sab, channel);
}

export { createMultiInputChannel };
