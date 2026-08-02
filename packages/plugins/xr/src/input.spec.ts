import { InputState } from "@downdraft/core";
import { XRInputMapper } from "./input.ts";

describe("XRInputMapper", () => {
  it("should start with zero controllers", () => {
    const mapper = new XRInputMapper();
    expect(mapper.getControllerCount()).toBe(0);
  });

  it("should return null poses when no controllers", () => {
    const mapper = new XRInputMapper();
    expect(mapper.getAimPose(0)).toBeNull();
    expect(mapper.getGripPose(0)).toBeNull();
  });

  it("should handle update with empty input sources", () => {
    const mapper = new XRInputMapper();
    const state = new InputState();
    const mockFrame = {
      session: {
        inputSources: [],
      },
    } as unknown as XRFrame;
    const mockRefSpace = {} as XRReferenceSpace;

    mapper.update(mockFrame, mockRefSpace, state);
    expect(state.xrControllers).toEqual([]);
    expect(mapper.getControllerCount()).toBe(0);
  });

  it("should map gamepad buttons to InputState keys", () => {
    const mapper = new XRInputMapper();
    const state = new InputState();

    // Create a mock XRInputSource with a gamepad
    const mockGamepad = {
      buttons: [
        { pressed: true, touched: false, value: 1 }, // trigger (button 0)
        { pressed: false, touched: false, value: 0 }, // squeeze (button 1)
        { pressed: false, touched: false, value: 0 }, // thumbstick (button 2)
        { pressed: true, touched: false, value: 1 }, // A/X (button 3)
        { pressed: false, touched: false, value: 0 }, // B/Y (button 4)
      ],
      axes: [0.5, -0.3, 0, 0],
    } as unknown as Gamepad;

    const mockSource = {
      handedness: "right",
      targetRayMode: "tracked-pointer",
      gamepad: mockGamepad,
      profiles: [],
      targetRaySpace: null,
      gripSpace: null,
    } as unknown as XRInputSource;

    const mockFrame = {
      session: {
        inputSources: [mockSource],
      },
      getPose: () => null, // no poses available
    } as unknown as XRFrame;

    const mockRefSpace = {} as XRReferenceSpace;

    mapper.update(mockFrame, mockRefSpace, state);

    // Trigger (button 0) should map to mouse button 0
    expect(state.isMouseDown(0)).toBe(true);

    // A/X (button 3) should map to key code 65 (A)
    expect(state.isKeyDown(65)).toBe(true);

    // B/Y (button 4) should NOT be pressed
    expect(state.isKeyDown(66)).toBe(false);

    // Axes should be mapped
    expect(state.gamepadAxes[0]).toBe(0.5);
    expect(state.gamepadAxes[1]).toBe(-0.3);
  });

  it("should detect button release transitions", () => {
    const mapper = new XRInputMapper();
    const state = new InputState();

    const makeGamepad = (triggerPressed: boolean) => ({
      buttons: [
        { pressed: triggerPressed, touched: false, value: triggerPressed ? 1 : 0 },
        { pressed: false, touched: false, value: 0 },
        { pressed: false, touched: false, value: 0 },
        { pressed: false, touched: false, value: 0 },
        { pressed: false, touched: false, value: 0 },
      ],
      axes: [0, 0, 0, 0],
    } as unknown as Gamepad);

    const makeFrame = (gamepad: Gamepad) => ({
      session: {
        inputSources: [{
          handedness: "left",
          targetRayMode: "tracked-pointer",
          gamepad,
          profiles: [],
          targetRaySpace: null,
          gripSpace: null,
        } as unknown as XRInputSource],
      },
      getPose: () => null,
    } as unknown as XRFrame);

    const mockRefSpace = {} as XRReferenceSpace;

    // Press trigger
    mapper.update(makeFrame(makeGamepad(true)), mockRefSpace, state);
    expect(state.isMouseDown(0)).toBe(true);

    state.endFrame();

    // Release trigger
    mapper.update(makeFrame(makeGamepad(false)), mockRefSpace, state);
    expect(state.isMouseDown(0)).toBe(false);
    expect(state.wasMouseReleased(0)).toBe(true);
  });

  it("should skip non-tracked-pointer sources", () => {
    const mapper = new XRInputMapper();
    const state = new InputState();

    const mockFrame = {
      session: {
        inputSources: [{
          handedness: "none",
          targetRayMode: "gaze",
          gamepad: null,
          profiles: [],
        } as unknown as XRInputSource],
      },
      getPose: () => null,
    } as unknown as XRFrame;

    const mockRefSpace = {} as XRReferenceSpace;

    mapper.update(mockFrame, mockRefSpace, state);
    expect(mapper.getControllerCount()).toBe(0);
    expect(state.xrControllers).toEqual([]);
  });
});
