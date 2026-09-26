import { MultiInputSABWriter } from "@downdraft/engine/input/multi-sab-bridge";
import type { PlatformAdapter } from "./platform-adapter";

export const REMOTE_INPUT_MSG_TYPE = 0x10;

export interface RemoteInputPacket {
  playerSlot: number;
  keys: number[];
  mouseX: number;
  mouseY: number;
  mouseDeltaX: number;
  mouseDeltaY: number;
  mouseButtons: number[];
  wheelDelta: number;
  gamepadButtons: number[];
  gamepadAxes: number[];
}

export class RemoteInputBridge {
  private writer: MultiInputSABWriter;
  private platform: PlatformAdapter;
  private slotMap: Map<string, number> = new Map();
  private nextSlot: number = 1;
  private maxSlots: number;

  constructor(writer: MultiInputSABWriter, platform: PlatformAdapter, maxSlots: number = 8) {
    this.writer = writer;
    this.platform = platform;
    this.maxSlots = maxSlots;

    this.platform.onPeerMessage((peerId, data) => {
      this.handleMessage(peerId, data);
    });
  }

  assignSlot(peerId: string, slot: number): void {
    this.slotMap.set(peerId, slot);
  }

  assignNextSlot(peerId: string): number {
    const slot = this.nextSlot++;
    if (slot >= this.maxSlots) return -1;
    this.slotMap.set(peerId, slot);
    return slot;
  }

  getSlot(peerId: string): number | undefined {
    return this.slotMap.get(peerId);
  }

  removePeer(peerId: string): void {
    const slot = this.slotMap.get(peerId);
    if (slot !== undefined) {
      this.writer.clearPlayer(slot);
    }
    this.slotMap.delete(peerId);
  }

  sendLocalInput(
    peerIds: string[],
    packet: RemoteInputPacket,
  ): void {
    const data = this.serializePacket(packet);
    peerIds.forEach((peerId) => {
      this.platform.sendToPeer(peerId, data, false);
    });
  }

  private handleMessage(peerId: string, data: Uint8Array): void {
    if (data.length < 1) return;
    const msgType = data[0];
    if (msgType !== REMOTE_INPUT_MSG_TYPE) return;

    const packet = this.deserializePacket(data);
    if (!packet) return;

    let slot = this.slotMap.get(peerId);
    if (slot === undefined) {
      slot = this.assignNextSlot(peerId);
      if (slot < 0) return;
    }

    this.writer.writePlayerInput(
      slot,
      packet.keys,
      packet.mouseX,
      packet.mouseY,
      packet.mouseDeltaX,
      packet.mouseDeltaY,
      packet.mouseButtons,
      packet.wheelDelta,
      packet.gamepadButtons,
      packet.gamepadAxes,
    );
  }

  private serializePacket(packet: RemoteInputPacket): Uint8Array {
    const keyCount = packet.keys.length;
    const mbCount = packet.mouseButtons.length;
    const gpBtnCount = packet.gamepadButtons.length;
    const gpAxisCount = packet.gamepadAxes.length;

    const headerSize = 1 + 1 + 2 + 4 * 6 + 1 + 1 + 1 + 1;
    const keysSize = keyCount * 4;
    const mbSize = mbCount * 4;
    const gpBtnSize = gpBtnCount * 4;
    const gpAxisSize = gpAxisCount * 4;
    const total = headerSize + keysSize + mbSize + gpBtnSize + gpAxisSize;

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let offset = 0;

    buf[offset++] = REMOTE_INPUT_MSG_TYPE;
    buf[offset++] = packet.playerSlot;
    dv.setUint16(offset, keyCount); offset += 2;
    dv.setFloat32(offset, packet.mouseX); offset += 4;
    dv.setFloat32(offset, packet.mouseY); offset += 4;
    dv.setFloat32(offset, packet.mouseDeltaX); offset += 4;
    dv.setFloat32(offset, packet.mouseDeltaY); offset += 4;
    dv.setFloat32(offset, packet.wheelDelta); offset += 4;
    buf[offset++] = mbCount;
    buf[offset++] = gpBtnCount;
    buf[offset++] = gpAxisCount;

    packet.keys.forEach((key) => {
      dv.setUint32(offset, key); offset += 4;
    });
    packet.mouseButtons.forEach((mb) => {
      dv.setUint32(offset, mb); offset += 4;
    });
    packet.gamepadButtons.forEach((btn) => {
      dv.setUint32(offset, btn); offset += 4;
    });
    packet.gamepadAxes.forEach((axis) => {
      dv.setFloat32(offset, axis); offset += 4;
    });

    return buf;
  }

  private deserializePacket(data: Uint8Array): RemoteInputPacket | null {
    if (data.length < 28) return null;
    const dv = new DataView(data.buffer, data.byteOffset);
    let offset = 1;

    const playerSlot = data[offset++];
    const keyCount = dv.getUint16(offset); offset += 2;
    const mouseX = dv.getFloat32(offset); offset += 4;
    const mouseY = dv.getFloat32(offset); offset += 4;
    const mouseDeltaX = dv.getFloat32(offset); offset += 4;
    const mouseDeltaY = dv.getFloat32(offset); offset += 4;
    const wheelDelta = dv.getFloat32(offset); offset += 4;
    const mbCount = data[offset++];
    const gpBtnCount = data[offset++];
    const gpAxisCount = data[offset++];

    const keys: number[] = [];
    for (let i = 0; i < keyCount; i++) {
      keys.push(dv.getUint32(offset)); offset += 4;
    }
    const mouseButtons: number[] = [];
    for (let i = 0; i < mbCount; i++) {
      mouseButtons.push(dv.getUint32(offset)); offset += 4;
    }
    const gamepadButtons: number[] = [];
    for (let i = 0; i < gpBtnCount; i++) {
      gamepadButtons.push(dv.getUint32(offset)); offset += 4;
    }
    const gamepadAxes: number[] = [];
    for (let i = 0; i < gpAxisCount; i++) {
      gamepadAxes.push(dv.getFloat32(offset)); offset += 4;
    }

    return {
      playerSlot,
      keys,
      mouseX,
      mouseY,
      mouseDeltaX,
      mouseDeltaY,
      mouseButtons,
      wheelDelta,
      gamepadButtons,
      gamepadAxes,
    };
  }
}
