// ============================================================================
// SabGamepadSource — core GamepadSource implementation over the
// 'gamepad-devices' channel. Install via LocalPlayerManager.setGamepadSource()
// on the native runtime.
// ============================================================================

import type { GamepadSnapshot, GamepadSource } from "@downdraft/engine/input/local-player-manager";
import {
    GAMEPAD_MAX_SLOTS,
    GamepadDevicesChannel,
    GamepadDevicesReader,
} from "@downdraft/engine/sab/gamepad-devices";

export class SabGamepadSource implements GamepadSource {
  private reader: GamepadDevicesReader;
  private connectCbs: ((index: number) => void)[] = [];
  private disconnectCbs: ((index: number) => void)[] = [];
  private knownMask = 0;

  constructor(sab: SharedArrayBuffer) {
    this.reader = new GamepadDevicesReader(sab);
  }

  listConnected(): number[] {
    const mask = this.reader.getConnectedMask();
    this.diffAndEmit(mask);
    const out: number[] = [];
    for (let i = 0; i < GAMEPAD_MAX_SLOTS; i++) {
      if (mask & (1 << i)) out.push(i);
    }
    return out;
  }

  read(index: number): GamepadSnapshot | null {
    const s = this.reader.readSlot(index);
    if (!s) return null;
    return { buttonsLo: s.buttonsLo >>> 0, buttonsHi: s.buttonsHi >>> 0, axes: Array.from(s.axes) };
  }

  onConnect(cb: (index: number) => void): void {
    this.connectCbs.push(cb);
  }

  onDisconnect(cb: (index: number) => void): void {
    this.disconnectCbs.push(cb);
  }

  /** Poll-driven connect/disconnect: the native writer updates the mask at
   *  250Hz, so events arrive on the next read/listConnected call. */
  private diffAndEmit(mask: number): void {
    const changed = mask ^ this.knownMask;
    if (changed === 0) return;
    for (let i = 0; i < GAMEPAD_MAX_SLOTS; i++) {
      if (!(changed & (1 << i))) continue;
      if (mask & (1 << i)) {
        for (const cb of this.connectCbs) cb(i);
      } else {
        for (const cb of this.disconnectCbs) cb(i);
      }
    }
    this.knownMask = mask;
  }
}

export const GAMEPAD_DEVICES_SAB_NAME = "gamepad-devices";

/** Byte size of a 'gamepad-devices' channel allocation. */
export function gamepadDevicesSabSize(): number {
  return GamepadDevicesChannel.allocate().byteLength;
}
