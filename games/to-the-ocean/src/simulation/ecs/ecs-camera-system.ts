// ============================================================================
// ECS Camera Controller — migrated from array-based CameraController
//
// Query: players (PlayerState) for camera mode + zoom handling
// InputBufferReader passed via closure (external SharedArrayBuffer state)
// Freecam positions/angles remain in Maps (not per-entity ECS data)
// ============================================================================

import { Stage, system, type Query, type SystemContext } from "@downdraft/core";
import { SimPlayerState } from "./components";
import { CameraMode } from "@shared/types";
import { InputBufferReader } from "../../shared/input-buffer";

const cameraPositions = new Map<number, { x: number; y: number; z: number }>();
const cameraAngles = new Map<number, { pitch: number; yaw: number }>();
const prevModes = new Map<number, CameraMode>();

export function createEcsCameraSystem(
  playersQuery: Query,
  getInput: () => InputBufferReader,
) {
  return system(
    "ecs-camera-system",
    Stage.Update,
    (ctx: SystemContext) => {
      const input = getInput();
      let playerIdx = 0;

      playersQuery.iterate(ctx.tick, (_entity, comps) => {
        const ps = comps[0] as ReturnType<typeof SimPlayerState.create>;
        const i = playerIdx++;

        if (!ps.active) return;

        const prevMode = prevModes.get(ps.playerId) ?? ps.cameraMode;
        const modeChanged = prevMode !== ps.cameraMode;
        prevModes.set(ps.playerId, ps.cameraMode);

        // Reinitialize freecam when entering FreeCam mode
        if (modeChanged && ps.cameraMode === CameraMode.FreeCam) {
          cameraPositions.set(ps.playerId, {
            x: ps.x,
            y: ps.y + 5,
            z: ps.z,
          });
          cameraAngles.set(ps.playerId, {
            pitch: ps.pitch,
            yaw: ps.heading,
          });
        }

        // Clean up freecam data when leaving FreeCam
        if (modeChanged && prevMode === CameraMode.FreeCam && ps.cameraMode !== CameraMode.FreeCam) {
          cameraPositions.delete(ps.playerId);
          cameraAngles.delete(ps.playerId);
        }

        // Handle camera zoom from input buffer (written by renderer)
        const zoom = input.getCameraZoom(i);
        if (zoom > 0 && ps.thirdPersonDistance !== zoom) {
          ps.thirdPersonDistance = Math.max(2, Math.min(20, zoom));
        }
      });
    },
    { queries: [playersQuery] },
  );
}

export function getFreecamPosition(playerId: number): { x: number; y: number; z: number } | null {
  return cameraPositions.get(playerId) ?? null;
}

export function getFreecamAngles(playerId: number): { pitch: number; yaw: number } | null {
  return cameraAngles.get(playerId) ?? null;
}

export function setFreecamData(playerId: number, pos: { x: number; y: number; z: number }, angles: { pitch: number; yaw: number }): void {
  cameraPositions.set(playerId, { ...pos });
  cameraAngles.set(playerId, { ...angles });
}

export function setCameraMode(playerId: number, mode: CameraMode, pos: { x: number; y: number; z: number }, heading: number): void {
  const prev = prevModes.get(playerId);
  if (prev === CameraMode.FreeCam && mode !== CameraMode.FreeCam) {
    cameraPositions.delete(playerId);
  }
  if (mode === CameraMode.FreeCam) {
    cameraPositions.set(playerId, { x: pos.x, y: pos.y + 5, z: pos.z });
    cameraAngles.set(playerId, { pitch: 0, yaw: heading });
  }
  prevModes.set(playerId, mode);
}
