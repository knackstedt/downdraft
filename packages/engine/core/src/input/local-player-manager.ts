import { MultiInputSABWriter } from "./multi-sab-bridge";

export interface InputDevice {
  type: "keyboard-mouse" | "controller";
  controllerIndex?: number;
}

export interface DeviceConnectCallback {
  (device: InputDevice): void;
}

export interface DeviceDisconnectCallback {
  (device: InputDevice): void;
}

/** Normalized per-poll controller snapshot (standard-layout ordering). */
export interface ControllerSnapshot {
  /** W3C-standard button bitmask, bits 0..31 (see GP_BTN_* in sab/controller-devices). */
  buttonsLo: number;
  /** Button bits 32+ (touchpad/paddles/misc). */
  buttonsHi: number;
  /** lx ly rx ry lt rt dpadX dpadY — triggers 0..1, sticks/dpad -1..1. */
  axes: number[];
}

/**
 * Pluggable controller producer. On the native runtime the implementation is
 * `SabControllerSource` (libraries/controller) — the 'controller-devices' SAB channel
 * written by the downdraft_controller cdylib.
 */
export interface ControllerSource {
  /** Indices of currently-connected pads. */
  listConnected(): number[];
  /** Snapshot for a device index, or null when disconnected. */
  read(index: number): ControllerSnapshot | null;
  onConnect(cb: (index: number) => void): void;
  onDisconnect(cb: (index: number) => void): void;
  dispose?(): void;
}

/** Inert default — reports no devices until a real source is installed
 *  via setControllerSource(). */
const NULL_CONTROLLER_SOURCE: ControllerSource = {
  listConnected: () => [],
  read: () => null,
  onConnect: () => {},
  onDisconnect: () => {},
};

export class LocalPlayerManager {
  private maxPlayers: number;
  private activePlayerCount: number = 1;
  private deviceMap: Map<number, InputDevice> = new Map();
  private writer: MultiInputSABWriter | null = null;
  private keyState: Set<number> = new Set();
  private mouseX: number = 0;
  private mouseY: number = 0;
  private mouseDeltaX: number = 0;
  private mouseDeltaY: number = 0;
  private mouseButtons: number[] = [0, 0, 0];
  private wheelDelta: number = 0;
  private connectCallbacks: DeviceConnectCallback[] = [];
  private disconnectCallbacks: DeviceDisconnectCallback[] = [];
  private controllerSource: ControllerSource | null = null;
  private listening = false;

  constructor(maxPlayers: number = 8) {
    this.maxPlayers = maxPlayers;
  }

  setWriter(writer: MultiInputSABWriter): void {
    this.writer = writer;
  }

  /**
   * Install a controller producer (e.g. `SabControllerSource` from
   * libraries/controller). Until one is installed, an inert source reporting
   * no devices is used.
   */
  setControllerSource(source: ControllerSource): void {
    this.controllerSource?.dispose?.();
    this.controllerSource = source;
    if (this.listening) {
      source.onConnect((i) => this.emitConnect({ type: "controller", controllerIndex: i }));
      source.onDisconnect((i) => this.emitDisconnect({ type: "controller", controllerIndex: i }));
    }
  }

  getControllerSource(): ControllerSource {
    if (!this.controllerSource) {
      this.controllerSource = NULL_CONTROLLER_SOURCE;
    }
    return this.controllerSource;
  }

  getActivePlayerCount(): number {
    return this.activePlayerCount;
  }

  setActivePlayerCount(n: number): void {
    this.activePlayerCount = Math.max(1, Math.min(n, this.maxPlayers));
  }

  getMaxPlayers(): number {
    return this.maxPlayers;
  }

  assignDevice(playerIdx: number, device: InputDevice): void {
    if (playerIdx < 0 || playerIdx >= this.maxPlayers) return;
    this.deviceMap.set(playerIdx, device);
  }

  autoAssign(): void {
    this.deviceMap.clear();
    this.assignDevice(0, { type: "keyboard-mouse" });

    let playerIdx = 1;
    for (const index of this.getControllerSource().listConnected()) {
      if (playerIdx >= this.maxPlayers) break;
      this.assignDevice(playerIdx, { type: "controller", controllerIndex: index });
      playerIdx++;
    }
    this.activePlayerCount = Math.max(1, playerIdx);
  }

  getDevice(playerIdx: number): InputDevice | undefined {
    return this.deviceMap.get(playerIdx);
  }

  getDeviceMap(): Map<number, InputDevice> {
    return this.deviceMap;
  }

  onDeviceConnect(cb: DeviceConnectCallback): void {
    this.connectCallbacks.push(cb);
  }

  onDeviceDisconnect(cb: DeviceDisconnectCallback): void {
    this.disconnectCallbacks.push(cb);
  }

  private emitConnect(device: InputDevice): void {
    for (const cb of this.connectCallbacks.values()) cb(device);
  }

  private emitDisconnect(device: InputDevice): void {
    for (const cb of this.disconnectCallbacks.values()) cb(device);
  }

  startListening(): void {
    if (this.listening) return;
    this.listening = true;
    const src = this.getControllerSource();
    src.onConnect((i) => this.emitConnect({ type: "controller", controllerIndex: i }));
    src.onDisconnect((i) => this.emitDisconnect({ type: "controller", controllerIndex: i }));
  }

  stopListening(): void {
    // Sources own their listeners; LocalPlayerManager only flips its flag so
    // a later setControllerSource() re-wires. Sources are cheap to re-create.
    this.listening = false;
  }

  setKeyboardState(keys: Set<number>): void {
    this.keyState = keys;
  }

  setMouseState(x: number, y: number, deltaX: number, deltaY: number, buttons: number[], wheel: number): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseDeltaX = deltaX;
    this.mouseDeltaY = deltaY;
    this.mouseButtons = buttons;
    this.wheelDelta = wheel;
  }

  poll(): void {
    if (!this.writer) return;

    for (let p = 0; p < this.activePlayerCount; p++) {
      const device = this.deviceMap.get(p);
      if (!device) continue;

      if (device.type === "keyboard-mouse") {
        const keys: number[] = [];
        for (const k of this.keyState.values()) keys.push(k);
        this.writer.writePlayerInput(
          p,
          keys,
          this.mouseX, this.mouseY,
          this.mouseDeltaX, this.mouseDeltaY,
          this.mouseButtons,
          this.wheelDelta,
          [], [],
        );
      } else if (device.type === "controller") {
        const src = this.getControllerSource();
        const snap = device.controllerIndex !== undefined ? src.read(device.controllerIndex) : null;
        if (!snap) continue;

        this.writer.writePlayerInput(
          p,
          [],
          0, 0, 0, 0,
          [0, 0, 0],
          0,
          [snap.buttonsLo, snap.buttonsHi],
          snap.axes,
          device.controllerIndex,
        );
      }
    }

    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }
}
