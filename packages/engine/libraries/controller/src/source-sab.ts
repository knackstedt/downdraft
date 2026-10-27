// ============================================================================
// SabControllerSource — core ControllerSource implementation over the
// 'controller-devices' channel. Install via LocalPlayerManager.setControllerSource()
// on the native runtime.
// ============================================================================

import type { ControllerSnapshot, ControllerSource } from "@downdraft/engine/input/local-player-manager";
import {
    CONTROLLER_MAX_SLOTS,
    ControllerDevicesChannel,
    ControllerDevicesReader,
} from "@downdraft/engine/sab/controller-devices";

export class SabControllerSource implements ControllerSource {
  private reader: ControllerDevicesReader;
  private connectCbs: ((index: number) => void)[] = [];
  private disconnectCbs: ((index: number) => void)[] = [];
  private knownMask = 0;

  constructor(sab: SharedArrayBuffer) {
    this.reader = new ControllerDevicesReader(sab);
  }

  listConnected(): number[] {
    const mask = this.reader.getConnectedMask();
    this.diffAndEmit(mask);
    const out: number[] = [];
    for (let i = 0; i < CONTROLLER_MAX_SLOTS; i++) {
      if (mask & (1 << i)) out.push(i);
    }
    return out;
  }

  read(index: number): ControllerSnapshot | null {
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
    for (let i = 0; i < CONTROLLER_MAX_SLOTS; i++) {
      if (!(changed & (1 << i))) continue;
      if (mask & (1 << i)) {
        for (const cb of this.connectCbs.values()) cb(i);
      } else {
        for (const cb of this.disconnectCbs.values()) cb(i);
      }
    }
    this.knownMask = mask;
  }
}

export const CONTROLLER_DEVICES_SAB_NAME = "controller-devices";

/** Byte size of a 'controller-devices' channel allocation. */
export function controllerDevicesSabSize(): number {
  return ControllerDevicesChannel.allocate().byteLength;
}
