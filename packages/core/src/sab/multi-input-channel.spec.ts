import { MultiInputSABBridge, MultiInputSABWriter } from "../input/multi-sab-bridge.ts";
import { MultiInputState } from "../input/multi-state.ts";
import { createMultiInputChannel, MultiInputChannel } from "./multi-input-channel.ts";

describe("MultiInputChannel", () => {
  it("should allocate a valid SAB", () => {
    const ch = createMultiInputChannel({ maxPlayers: 4 });
    const sab = ch.allocate();
    expect(sab.byteLength).toBeGreaterThan(0);

    const reader = ch.reader(sab);
    expect(reader.isValid()).toBe(true);
  });

  it("should support configurable maxPlayers", () => {
    const ch = createMultiInputChannel({ maxPlayers: 2 });
    expect(ch.def.sections?.[0]?.maxSlots).toBe(2);
  });

  it("should write and read per-player input slots with isolation", () => {
    const ch = createMultiInputChannel({ maxPlayers: 4 });
    const sab = ch.allocate();
    const writer = new MultiInputSABWriter(sab, ch);
    const state = new MultiInputState(4);
    const bridge = new MultiInputSABBridge(sab, state, ch);

    writer.writePlayerInput(0, [65], 100, 200, 1, 2, [1, 0, 0], 5, [1, 0, 0, 0], [0.5, 0.1, 0, 0]);
    writer.writePlayerInput(1, [87], 300, 400, 3, 4, [0, 1, 0], 0, [0, 1, 0, 0], [0.2, 0.3, 0, 0]);

    bridge.poll();

    const p0 = state.getPlayerState(0);
    const p1 = state.getPlayerState(1);
    const p2 = state.getPlayerState(2);

    expect(p0.isKeyDown(65)).toBe(true);
    expect(p0.isMouseDown(0)).toBe(true);
    expect(p0.mouseX).toBe(100);
    expect(p0.mouseY).toBe(200);
    expect(p0.gamepadAxes[0]).toBeCloseTo(0.5);

    expect(p1.isKeyDown(87)).toBe(true);
    expect(p1.isMouseDown(1)).toBe(true);
    expect(p1.mouseX).toBe(300);
    expect(p1.gamepadAxes[1]).toBeCloseTo(0.3);

    expect(p2.isKeyDown(65)).toBe(false);
    expect(p2.isKeyDown(87)).toBe(false);
    expect(p2.mouseX).toBe(0);
  });

  it("should detect key press and release transitions", () => {
    const ch = createMultiInputChannel({ maxPlayers: 2 });
    const sab = ch.allocate();
    const writer = new MultiInputSABWriter(sab, ch);
    const state = new MultiInputState(2);
    const bridge = new MultiInputSABBridge(sab, state, ch);

    writer.writePlayerInput(0, [10], 0, 0, 0, 0, [0, 0, 0], 0, [], []);
    bridge.poll();

    expect(state.getPlayerState(0).wasKeyPressed(10)).toBe(true);
    expect(state.getPlayerState(0).isKeyDown(10)).toBe(true);

    state.endFrame();

    writer.writePlayerInput(0, [], 0, 0, 0, 0, [0, 0, 0], 0, [], []);
    bridge.poll();

    expect(state.getPlayerState(0).wasKeyReleased(10)).toBe(true);
    expect(state.getPlayerState(0).isKeyDown(10)).toBe(false);
  });

  it("should clear a player slot", () => {
    const ch = createMultiInputChannel({ maxPlayers: 2 });
    const sab = ch.allocate();
    const writer = new MultiInputSABWriter(sab, ch);
    const state = new MultiInputState(2);
    const bridge = new MultiInputSABBridge(sab, state, ch);

    writer.writePlayerInput(0, [65], 50, 60, 0, 0, [1, 0, 0], 0, [], []);
    bridge.poll();
    expect(state.getPlayerState(0).isKeyDown(65)).toBe(true);

    writer.clearPlayer(0);
    bridge.poll();

    expect(state.getPlayerState(0).isKeyDown(65)).toBe(false);
  });

  it("should handle gamepad button state", () => {
    const ch = createMultiInputChannel({ maxPlayers: 2 });
    const sab = ch.allocate();
    const writer = new MultiInputSABWriter(sab, ch);
    const state = new MultiInputState(2);
    const bridge = new MultiInputSABBridge(sab, state, ch);

    writer.writePlayerInput(0, [], 0, 0, 0, 0, [0, 0, 0], 0, [1, 1, 0, 0], [0, 0, 0, 0]);
    bridge.poll();

    expect(state.getPlayerState(0).gamepadButtons.has(0)).toBe(true);
    expect(state.getPlayerState(0).gamepadButtons.has(1)).toBe(true);
    expect(state.getPlayerState(0).gamepadButtons.has(2)).toBe(false);
  });

  it("should use default MultiInputChannel constant", () => {
    expect(MultiInputChannel.def.name).toBe("multi-input");
    expect(MultiInputChannel.def.sections?.[0]?.maxSlots).toBe(8);
  });
});
