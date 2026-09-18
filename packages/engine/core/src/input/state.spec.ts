import { CoreInputChannel } from "../sab/core-input-channel";
import { InputSABChannel } from "../sab/input";
import { InputContextRouter } from "./context";
import { InputSABBridge } from "./sab-bridge";
import { InputContext, InputState } from "./state";

describe("InputState", () => {
  it("should track key down and up events", () => {
    const state = new InputState();
    state.keyDown(65); // 'A'
    expect(state.isKeyDown(65)).toBe(true);
    expect(state.wasKeyPressed(65)).toBe(true);

    state.endFrame();
    expect(state.wasKeyPressed(65)).toBe(false);
    expect(state.isKeyDown(65)).toBe(true);

    state.keyUp(65);
    expect(state.isKeyDown(65)).toBe(false);
    expect(state.wasKeyReleased(65)).toBe(true);
  });

  it("should track mouse movement and buttons", () => {
    const state = new InputState();
    state.mouseMove(100, 200, 5, 10);
    expect(state.mouseX).toBe(100);
    expect(state.mouseY).toBe(200);
    expect(state.mouseDeltaX).toBe(5);
    expect(state.mouseDeltaY).toBe(10);

    state.mouseDown(0);
    expect(state.isMouseDown(0)).toBe(true);
    expect(state.wasMousePressed(0)).toBe(true);

    state.endFrame();
    state.mouseUp(0);
    expect(state.isMouseDown(0)).toBe(false);
    expect(state.wasMouseReleased(0)).toBe(true);
  });

  it("should accumulate wheel delta", () => {
    const state = new InputState();
    state.wheel(1.5);
    state.wheel(2.5);
    expect(state.wheelDelta).toBe(4);

    state.endFrame();
    expect(state.wheelDelta).toBe(0);
  });

  it("should track XR controller state", () => {
    const state = new InputState();
    expect(state.xrControllers).toEqual([]);

    const controller: XRControllerState = {
      aimPosition: [1, 2, 3],
      aimQuaternion: [0, 0, 0, 1],
      gripPosition: [4, 5, 6],
      gripQuaternion: [0, 0.707, 0, 0.707],
      handedness: "left",
    };
    state.xrControllers = [controller];
    expect(state.xrControllers.length).toBe(1);
    expect(state.xrControllers[0].handedness).toBe("left");
    expect(state.xrControllers[0].aimPosition).toEqual([1, 2, 3]);
  });
});

describe("InputContextRouter", () => {
  it("should route actions based on active context", () => {
    const state = new InputState();
    const router = new InputContextRouter(state);

    const gameMappings = new Map([["jump", [32]]]); // space
    const editorMappings = new Map([["delete", [46]]]); // delete

    router.registerContext(InputContext.Game, gameMappings);
    router.registerContext(InputContext.Editor, editorMappings);

    state.keyDown(32); // space
    state.keyDown(46); // delete

    router.setContext(InputContext.Game);
    expect(router.isActionDown("jump")).toBe(true);
    expect(router.isActionDown("delete")).toBe(false);

    router.setContext(InputContext.Editor);
    expect(router.isActionDown("jump")).toBe(false);
    expect(router.isActionDown("delete")).toBe(true);
  });
});

describe("InputSABBridge", () => {
  it("should apply keyboard keys from SAB data", () => {
    const sab = CoreInputChannel.allocate();
    const state = new InputState();
    const bridge = new InputSABBridge(sab, state);

    // Write keys [65, 66, 0, 0, 0, 0, 0, 0] (A and B pressed)
    const channel = new InputSABChannel(sab);
    channel.write([65, 66], 0, 0, 0, 0, [0, 0, 0], 0, [], []);

    bridge.poll();

    expect(state.isKeyDown(65)).toBe(true);
    expect(state.isKeyDown(66)).toBe(true);
    expect(state.isKeyDown(67)).toBe(false);
  });

  it("should release keys no longer in SAB data", () => {
    const sab = CoreInputChannel.allocate();
    const state = new InputState();
    const bridge = new InputSABBridge(sab, state);

    const channel = new InputSABChannel(sab);

    // Press A and B
    channel.write([65, 66], 0, 0, 0, 0, [0, 0, 0], 0, [], []);
    bridge.poll();
    expect(state.isKeyDown(65)).toBe(true);
    expect(state.isKeyDown(66)).toBe(true);

    // Release B (only A remains)
    channel.write([65], 0, 0, 0, 0, [0, 0, 0], 0, [], []);
    bridge.poll();
    expect(state.isKeyDown(65)).toBe(true);
    expect(state.isKeyDown(66)).toBe(false);
  });
});
