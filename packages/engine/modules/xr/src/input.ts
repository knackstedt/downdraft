import { type InputState, type XRControllerState } from "@downdraft/engine";
import type { XRPoseData } from "./types";

const KEY_ESCAPE = 27;
const KEY_A = 65;
const KEY_B = 66;
const KEY_X = 88;
const KEY_Y = 89;

interface XRInputSourceLike {
  handedness: "left" | "right" | "none";
  targetRayMode: "tracked-pointer" | "gaze" | "screen";
  gamepad: Gamepad | null;
  profiles: string[];
}

interface ControllerPoseCache {
  aimPose: XRPoseData | null;
  gripPose: XRPoseData | null;
  handedness: "left" | "right" | "none";
}

export class XRInputMapper {
  private controllers: ControllerPoseCache[] = [];
  private prevButtonStates: boolean[][] = [];

  update(frame: XRFrame, referenceSpace: XRReferenceSpace, inputState: InputState): void {
    const session = frame.session;
    const sources = session.inputSources;

    const controllers: XRControllerState[] = [];
    this.controllers = [];

    let gamepadIdx = 0;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i] as unknown as XRInputSourceLike;

      if (source.targetRayMode !== "tracked-pointer") continue;

      const handedness = source.handedness;
      const gamepad = source.gamepad;

      // Get aim and grip poses
      const aimPose = this.getPose(frame, source as unknown as XRInputSource, referenceSpace, "target-ray");
      const gripPose = this.getPose(frame, source as unknown as XRInputSource, referenceSpace, "grip");

      this.controllers.push({
        aimPose,
        gripPose,
        handedness,
      });

      // Build XRControllerState
      if (aimPose || gripPose) {
        const ctrl: XRControllerState = {
          aimPosition: aimPose?.position ?? [0, 0, 0],
          aimQuaternion: aimPose?.quaternion ?? [0, 0, 0, 1],
          gripPosition: gripPose?.position ?? [0, 0, 0],
          gripQuaternion: gripPose?.quaternion ?? [0, 0, 0, 1],
          handedness,
        };
        controllers.push(ctrl);
      }

      // Map gamepad buttons to InputState
      if (gamepad) {
        this.mapGamepadToInputState(gamepad, gamepadIdx, inputState, i);
        gamepadIdx++;
      }
    }

    inputState.xrControllers = controllers;
  }

  private mapGamepadToInputState(
    gamepad: Gamepad,
    _gamepadIdx: number,
    inputState: InputState,
    sourceIdx: number,
  ): void {
    const buttons = gamepad.buttons;
    const axes = gamepad.axes;

    // Ensure prevButtonStates is large enough
    while (this.prevButtonStates.length <= sourceIdx) {
      this.prevButtonStates.push([]);
    }
    const prevStates = this.prevButtonStates[sourceIdx];
    while (prevStates.length < buttons.length) {
      prevStates.push(false);
    }

    for (let b = 0; b < buttons.length; b++) {
      const pressed = buttons[b].pressed;
      const wasPressed = prevStates[b];

      if (pressed && !wasPressed) {
        // Button just pressed — map to key
        const keyCode = this.buttonToKeyCode(b);
        if (keyCode !== null) {
          inputState.keyDown(keyCode);
        }
        // Also map trigger (0) and squeeze (1) to mouse buttons
        if (b === 0) inputState.mouseDown(0);
        if (b === 1) inputState.mouseDown(2);
      } else if (!pressed && wasPressed) {
        // Button just released
        const keyCode = this.buttonToKeyCode(b);
        if (keyCode !== null) {
          inputState.keyUp(keyCode);
        }
        if (b === 0) inputState.mouseUp(0);
        if (b === 1) inputState.mouseUp(2);
      }

      prevStates[b] = pressed;
    }

    // Map axes (thumbstick) to gamepadAxes
    // Standard XR controller: axes[0] = x, axes[1] = y, axes[2] = x2, axes[3] = y2
    if (axes.length >= 2) {
      inputState.gamepadAxes[0] = axes[0];
      inputState.gamepadAxes[1] = axes[1];
    }
    if (axes.length >= 4) {
      inputState.gamepadAxes[2] = axes[2];
      inputState.gamepadAxes[3] = axes[3];
    }
  }

  private buttonToKeyCode(buttonIndex: number): number | null {
    // Standard XR gamepad button mapping:
    // 0 = trigger, 1 = squeeze, 2 = thumbstick press, 3 = A/X, 4 = B/Y
    switch (buttonIndex) {
      case 0: return null; // trigger → mapped to mouse button 0
      case 1: return null; // squeeze → mapped to mouse button 2
      case 2: return null; // thumbstick press — no standard key
      case 3: return KEY_A; // A / X
      case 4: return KEY_B; // B / Y
      default: return null;
    }
  }

  private getPose(
    frame: XRFrame,
    source: XRInputSource,
    referenceSpace: XRReferenceSpace,
    spaceType: "target-ray" | "grip",
  ): XRPoseData | null {
    const space = spaceType === "target-ray" ? source.targetRaySpace : source.gripSpace;
    if (!space) return null;

    const pose = frame.getPose(space, referenceSpace);
    if (!pose) return null;

    const matrix = pose.transform.matrix as Float32Array;
    const position: [number, number, number] = [matrix[12], matrix[13], matrix[14]];
    const quaternion = this.matrixToQuaternion(matrix);

    return { position, quaternion, matrix: new Float32Array(matrix) };
  }

  private matrixToQuaternion(m: Float32Array): [number, number, number, number] {
    const trace = m[0] + m[5] + m[10];
    let qw: number, qx: number, qy: number, qz: number;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      qw = 0.25 / s;
      qx = (m[6] - m[9]) * s;
      qy = (m[8] - m[2]) * s;
      qz = (m[1] - m[4]) * s;
    } else if (m[0] > m[5] && m[0] > m[10]) {
      const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]);
      qw = (m[6] - m[9]) / s;
      qx = 0.25 * s;
      qy = (m[4] + m[1]) / s;
      qz = (m[8] + m[2]) / s;
    } else if (m[5] > m[10]) {
      const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]);
      qw = (m[8] - m[2]) / s;
      qx = (m[4] + m[1]) / s;
      qy = 0.25 * s;
      qz = (m[9] + m[6]) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]);
      qw = (m[1] - m[4]) / s;
      qx = (m[8] + m[2]) / s;
      qy = (m[9] + m[6]) / s;
      qz = 0.25 * s;
    }

    return [qx, qy, qz, qw];
  }

  getAimPose(controllerIdx: number): XRPoseData | null {
    return this.controllers[controllerIdx]?.aimPose ?? null;
  }

  getGripPose(controllerIdx: number): XRPoseData | null {
    return this.controllers[controllerIdx]?.gripPose ?? null;
  }

  getControllerCount(): number {
    return this.controllers.length;
  }
}
