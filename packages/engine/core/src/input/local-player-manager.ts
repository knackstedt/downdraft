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

/** Normalized per-poll gamepad snapshot (standard-layout ordering). */
export interface GamepadSnapshot {
  /** W3C-standard button bitmask, bits 0..31 (see GP_BTN_* in sab/gamepad-devices). */
  buttonsLo: number;
  /** Button bits 32+ (touchpad/paddles/misc). */
  buttonsHi: number;
  /** lx ly rx ry lt rt dpadX dpadY — triggers 0..1, sticks/dpad -1..1. */
  axes: number[];
}

/**
 * Pluggable gamepad producer. Implementations:
 *   - `BrowserGamepadSource` (this file) — navigator.getGamepads()
 *   - `SabGamepadSource` (libraries/gamepad) — the native 'gamepad-devices'
 *     channel written by the downdraft_gamepad cdylib.
 */
export interface GamepadSource {
  /** Indices of currently-connected pads. */
  listConnected(): number[];
  /** Snapshot for a device index, or null when disconnected. */
  read(index: number): GamepadSnapshot | null;
  onConnect(cb: (index: number) => void): void;
  onDisconnect(cb: (index: number) => void): void;
  dispose?(): void;
}

const AXIS_COUNT = 8;

/** W3C-standard bit index for a Gamepad API button position. */
const W3C_BUTTON_BITS = [
  0, 1, 2, 3, // south east west north
  4, 5, // shoulders
  6, 7, // trigger buttons
  8, 9, // select start
  10, // home ("standard" index 16 is home; see mapping below)
  11, 12, // stick clicks
  13, 14, 15, 16, // dpad
] as const;

/**
 * Browser Gamepad API source. Maps `gp.buttons`/`gp.axes` onto the shared
 * [lo,hi]-bitmask + 8-axis convention: sticks -1..1 on axes 0..3, trigger
 * *button values* on axes 4..5, dpad derived on axes 6..7.
 */
export class BrowserGamepadSource implements GamepadSource {
  private connectCbs: ((index: number) => void)[] = [];
  private disconnectCbs: ((index: number) => void)[] = [];
  private onConnected = (e: GamepadEvent) => {
    for (const cb of this.connectCbs) cb(e.gamepad.index);
  };
  private onDisconnected = (e: GamepadEvent) => {
    for (const cb of this.disconnectCbs) cb(e.gamepad.index);
  };
  private listening = false;

  private api(): typeof navigator | null {
    return typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
      ? navigator
      : null;
  }

  listConnected(): number[] {
    const nav = this.api();
    if (!nav) return [];
    const out: number[] = [];
    for (const gp of nav.getGamepads()) {
      if (gp) out.push(gp.index);
    }
    return out;
  }

  read(index: number): GamepadSnapshot | null {
    const nav = this.api();
    if (!nav) return null;
    const gp = nav.getGamepads()[index];
    if (!gp) return null;

    let lo = 0;
    for (let i = 0; i < gp.buttons.length && i < 32; i++) {
      if (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) {
        // W3C standard order already matches the bitmask order for the
        // first 17 entries; index 16+ (home/capture) fold into bits 10/19.
        const bit = i === 16 ? 10 : i === 17 ? 19 : W3C_BUTTON_BITS[i] ?? i;
        lo |= 1 << bit;
      }
    }

    const axes = new Array<number>(AXIS_COUNT).fill(0);
    for (let i = 0; i < Math.min(4, gp.axes.length); i++) {
      axes[i] = gp.axes[i];
    }
    // Trigger analog values live on buttons 6/7 in the standard mapping.
    axes[4] = gp.buttons[6]?.value ?? 0;
    axes[5] = gp.buttons[7]?.value ?? 0;
    // Dpad axes — browsers usually expose dpad only as buttons 12..15.
    axes[6] = (gp.buttons[15]?.pressed ? 1 : 0) - (gp.buttons[14]?.pressed ? 1 : 0);
    axes[7] = (gp.buttons[13]?.pressed ? 1 : 0) - (gp.buttons[12]?.pressed ? 1 : 0);

    return { buttonsLo: lo >>> 0, buttonsHi: 0, axes };
  }

  onConnect(cb: (index: number) => void): void {
    this.connectCbs.push(cb);
    this.ensureListening();
  }

  onDisconnect(cb: (index: number) => void): void {
    this.disconnectCbs.push(cb);
    this.ensureListening();
  }

  private ensureListening(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("gamepadconnected", this.onConnected);
    window.addEventListener("gamepaddisconnected", this.onDisconnected);
  }

  dispose(): void {
    if (typeof window === "undefined" || !this.listening) return;
    window.removeEventListener("gamepadconnected", this.onConnected);
    window.removeEventListener("gamepaddisconnected", this.onDisconnected);
    this.listening = false;
  }
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
  private gamepadSource: GamepadSource | null = null;
  private listening = false;

  constructor(maxPlayers: number = 8) {
    this.maxPlayers = maxPlayers;
  }

  setWriter(writer: MultiInputSABWriter): void {
    this.writer = writer;
  }

  /**
   * Install a gamepad producer. Defaults to `BrowserGamepadSource` when
   * `startListening()`/`autoAssign()` run without one. Pass the native
   * `SabGamepadSource` (libraries/gamepad) on the native runtime.
   */
  setGamepadSource(source: GamepadSource): void {
    this.gamepadSource?.dispose?.();
    this.gamepadSource = source;
    if (this.listening) {
      source.onConnect((i) => this.emitConnect({ type: "gamepad", gamepadIndex: i }));
      source.onDisconnect((i) => this.emitDisconnect({ type: "gamepad", gamepadIndex: i }));
    }
  }

  getGamepadSource(): GamepadSource {
    if (!this.gamepadSource) {
      this.gamepadSource = new BrowserGamepadSource();
    }
    return this.gamepadSource;
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
    for (const index of this.getGamepadSource().listConnected()) {
      if (playerIdx >= this.maxPlayers) break;
      this.assignDevice(playerIdx, { type: "gamepad", gamepadIndex: index });
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
    for (const cb of this.connectCallbacks) cb(device);
  }

  private emitDisconnect(device: InputDevice): void {
    for (const cb of this.disconnectCallbacks) cb(device);
  }

  startListening(): void {
    if (this.listening) return;
    this.listening = true;
    const src = this.getGamepadSource();
    src.onConnect((i) => this.emitConnect({ type: "gamepad", gamepadIndex: i }));
    src.onDisconnect((i) => this.emitDisconnect({ type: "gamepad", gamepadIndex: i }));
  }

  stopListening(): void {
    // Sources own their listeners; LocalPlayerManager only flips its flag so
    // a later setGamepadSource() re-wires. Sources are cheap to re-create.
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
      } else if (device.type === "gamepad") {
        const src = this.getGamepadSource();
        const snap = device.gamepadIndex !== undefined ? src.read(device.gamepadIndex) : null;
        if (!snap) continue;

        this.writer.writePlayerInput(
          p,
          [],
          0, 0, 0, 0,
          [0, 0, 0],
          0,
          [snap.buttonsLo, snap.buttonsHi],
          snap.axes,
          device.gamepadIndex,
        );
      }
    }

    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    this.wheelDelta = 0;
  }
}
