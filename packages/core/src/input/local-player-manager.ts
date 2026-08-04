import { MultiInputSABWriter } from "./multi-sab-bridge";

export interface InputDevice {
  type: "keyboard-mouse" | "gamepad";
  gamepadIndex?: number;
}

export interface DeviceConnectCallback {
  (device: InputDevice): void;
}

export interface DeviceDisconnectCallback {
  (device: InputDevice): void;
}

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
  private gamepadConnectedHandler: ((e: GamepadEvent) => void) | null = null;
  private gamepadDisconnectedHandler: ((e: GamepadEvent) => void) | null = null;

  constructor(maxPlayers: number = 8) {
    this.maxPlayers = maxPlayers;
  }

  setWriter(writer: MultiInputSABWriter): void {
    this.writer = writer;
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

    const gamepads = typeof navigator !== "undefined" && navigator.getGamepads
      ? navigator.getGamepads()
      : [];

    let playerIdx = 1;
    for (let i = 0; i < gamepads.length && playerIdx < this.maxPlayers; i++) {
      const gp = gamepads[i];
      if (gp) {
        this.assignDevice(playerIdx, { type: "gamepad", gamepadIndex: i });
        playerIdx++;
      }
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

  startListening(): void {
    if (typeof window === "undefined") return;

    this.gamepadConnectedHandler = (e: GamepadEvent) => {
      const device: InputDevice = { type: "gamepad", gamepadIndex: e.gamepad.index };
      for (const cb of this.connectCallbacks) cb(device);
    };
    this.gamepadDisconnectedHandler = (e: GamepadEvent) => {
      const device: InputDevice = { type: "gamepad", gamepadIndex: e.gamepad.index };
      for (const cb of this.disconnectCallbacks) cb(device);
    };

    window.addEventListener("gamepadconnected", this.gamepadConnectedHandler);
    window.addEventListener("gamepaddisconnected", this.gamepadDisconnectedHandler);
  }

  stopListening(): void {
    if (typeof window === "undefined") return;
    if (this.gamepadConnectedHandler) {
      window.removeEventListener("gamepadconnected", this.gamepadConnectedHandler);
      this.gamepadConnectedHandler = null;
    }
    if (this.gamepadDisconnectedHandler) {
      window.removeEventListener("gamepaddisconnected", this.gamepadDisconnectedHandler);
      this.gamepadDisconnectedHandler = null;
    }
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
        for (const k of this.keyState) keys.push(k);
        this.writer.writePlayerInput(
          p,
          keys,
          this.mouseX, this.mouseY,
          this.mouseDeltaX, this.mouseDeltaY,
          this.mouseButtons,
          this.wheelDelta,
          [], [],
        );
      } else if (device.type === "gamepad") {
        const gamepads = typeof navigator !== "undefined" && navigator.getGamepads
          ? navigator.getGamepads()
          : [];
        const gp = device.gamepadIndex !== undefined ? gamepads[device.gamepadIndex] : null;
        if (!gp) continue;

        const gpButtons: number[] = [];
        for (let i = 0; i < gp.buttons.length && i < 4; i++) {
          gpButtons.push(gp.buttons[i].pressed ? 1 : 0);
        }
        const gpAxes: number[] = [];
        for (let i = 0; i < gp.axes.length && i < 4; i++) {
          gpAxes.push(gp.axes[i]);
        }
        this.writer.writePlayerInput(
          p,
          [],
          0, 0, 0, 0,
          [0, 0, 0],
          0,
          gpButtons,
          gpAxes,
        );
      }
    }

    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }
}
