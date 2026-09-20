import { LocalPlayerManager } from "./local-player-manager";
import type { InputDevice } from "./local-player-manager";

describe("LocalPlayerManager", () => {
  it("should initialize with default max players", () => {
    const mgr = new LocalPlayerManager(8);
    expect(mgr.getMaxPlayers()).toBe(8);
    expect(mgr.getActivePlayerCount()).toBe(1);
  });

  it("should assign devices to player slots", () => {
    const mgr = new LocalPlayerManager(4);
    const km: InputDevice = { type: "keyboard-mouse" };
    const gp: InputDevice = { type: "gamepad", gamepadIndex: 0 };

    mgr.assignDevice(0, km);
    mgr.assignDevice(1, gp);

    expect(mgr.getDevice(0)).toEqual(km);
    expect(mgr.getDevice(1)).toEqual(gp);
    expect(mgr.getDevice(2)).toBeUndefined();
  });

  it("should auto-assign keyboard to player 0", () => {
    const mgr = new LocalPlayerManager(4);
    mgr.autoAssign();

    expect(mgr.getDevice(0)).toEqual({ type: "keyboard-mouse" });
    expect(mgr.getActivePlayerCount()).toBeGreaterThanOrEqual(1);
  });

  it("should set active player count with clamping", () => {
    const mgr = new LocalPlayerManager(4);
    mgr.setActivePlayerCount(3);
    expect(mgr.getActivePlayerCount()).toBe(3);

    mgr.setActivePlayerCount(0);
    expect(mgr.getActivePlayerCount()).toBe(1);

    mgr.setActivePlayerCount(10);
    expect(mgr.getActivePlayerCount()).toBe(4);
  });

  it("should fire connect/disconnect callbacks", () => {
    const mgr = new LocalPlayerManager(4);
    let connected: InputDevice | null = null;
    let disconnected: InputDevice | null = null;

    mgr.onDeviceConnect((d) => { connected = d; });
    mgr.onDeviceDisconnect((d) => { disconnected = d; });

    const connectHandler = (mgr as unknown as { connectCallbacks: Array<(d: InputDevice) => void> }).connectCallbacks;
    const disconnectHandler = (mgr as unknown as { disconnectCallbacks: Array<(d: InputDevice) => void> }).disconnectCallbacks;

    connectHandler[0]({ type: "gamepad", gamepadIndex: 1 });
    expect(connected as InputDevice | null).toEqual({ type: "gamepad", gamepadIndex: 1 });

    disconnectHandler[0]({ type: "gamepad", gamepadIndex: 1 });
    expect(disconnected as InputDevice | null).toEqual({ type: "gamepad", gamepadIndex: 1 });
  });

  it("should return device map", () => {
    const mgr = new LocalPlayerManager(4);
    mgr.assignDevice(0, { type: "keyboard-mouse" });
    mgr.assignDevice(2, { type: "gamepad", gamepadIndex: 0 });

    const map = mgr.getDeviceMap();
    expect(map.size).toBe(2);
    expect(map.get(0)?.type).toBe("keyboard-mouse");
    expect(map.get(2)?.type).toBe("gamepad");
  });
});
