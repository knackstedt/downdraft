// ============================================================================
// feed-input — bridge from the 'controller-devices' device table into the
// per-player 'app-input' channel (InputBufferWriter). Renderer-side helper:
// apps call this once per player per frame inside their input pass.
// ============================================================================

import { INP_FLAG, type InputBufferWriter } from "@downdraft/engine/sab/app-input";
import {
    ControllerDevicesReader,
    type ControllerDeviceSlot,
} from "@downdraft/engine/sab/controller-devices";

const AXIS_COUNT = 8;
const BTN_COUNT = 32;

/**
 * Synthesize a keyboard key-press from a pad control. Lets apps keep their
 * existing key-driven sims/UI while gaining controller support — the pad
 * writes real key bits into the same `keys` bitmask.
 */
export interface PadKeyBinding {
  /** KEY.* code to set in the input channel when the pad control is active. */
  key: number;
  /** GP_BTN bit index that activates the key. */
  button?: number;
  /** GP_AXIS index that activates the key (one half of the axis). */
  axis?: number;
  /** Which direction of the axis activates: -1 = negative, +1 = positive. */
  axisDir?: -1 | 1;
  /** Axis magnitude required to activate (default 0.5). */
  threshold?: number;
}

/**
 * Write one device-table slot into a player's app-input fields:
 *   axes 0..7   → gpAxes (lx ly rx ry lt rt dpadX dpadY)
 *   buttonsLo   → gpBtn bitmask (W3C standard order)
 *   bindings    → optional synthesized key bits (applied on top of DOM keys)
 *   sets/clears the INP_FLAG.HAS_CONTROLLER flag accordingly.
 */
export function writePadToInput(
  writer: InputBufferWriter,
  reader: ControllerDevicesReader,
  playerIdx: number,
  deviceSlot: number,
  bindings?: readonly PadKeyBinding[],
  out?: Partial<ControllerDeviceSlot>,
): void {
  const d = reader.readSlot(deviceSlot, out);
  if (!d) {
    for (let i = 0; i < AXIS_COUNT; i++) writer.setControllerAxis(playerIdx, i, 0);
    for (let b = 0; b < BTN_COUNT; b++) writer.setControllerButton(playerIdx, b, false);
    return;
  }
  for (let i = 0; i < AXIS_COUNT; i++) writer.setControllerAxis(playerIdx, i, d.axes[i]);
  for (let b = 0; b < BTN_COUNT; b++) {
    writer.setControllerButton(playerIdx, b, (d.buttonsLo & (1 << b)) !== 0);
  }
  if (bindings) {
    for (const bind of bindings.values()) {
      let active = false;
      if (bind.button !== undefined) {
        active = (d.buttonsLo & (1 << bind.button)) !== 0;
      }
      if (!active && bind.axis !== undefined) {
        const v = d.axes[bind.axis];
        const dir = bind.axisDir ?? 1;
        const t = bind.threshold ?? 0.5;
        active = dir > 0 ? v >= t : v <= -t;
      }
      if (active) writer.setKey(playerIdx, bind.key, true);
    }
  }
}

/** Get the reader for the host-provided controller channel, or null when the
 *  native backend isn't loaded. Memoized — construct once. */
export function getHostControllerReader(): ControllerDevicesReader | null {
  const sab = (globalThis as { __ddController?: { sab?: SharedArrayBuffer } }).__ddController?.sab;
  return sab ? new ControllerDevicesReader(sab) : null;
}

export { INP_FLAG };
