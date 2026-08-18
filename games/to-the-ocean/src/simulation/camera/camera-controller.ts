// ============================================================================
// Camera Controller — 1st/3rd person, freecam, portaled cameras
// ============================================================================

import { InputBufferReader, KEY } from "@downdraft/core";
import { SimPlayer, SimEntity } from "../simulation";
import { CameraMode, EntityType } from "../../shared/types";

export class CameraController {
  private cameraPositions = new Map<number, { x: number; y: number; z: number }>(); // freecam positions
  private cameraAngles = new Map<number, { pitch: number; yaw: number }>();
  private prevModes = new Map<number, CameraMode>();

  tick(
    dt: number,
    input: InputBufferReader,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      const prevMode = this.prevModes.get(p.playerId) ?? p.cameraMode;
      const modeChanged = prevMode !== p.cameraMode;
      this.prevModes.set(p.playerId, p.cameraMode);

      // Reinitialize freecam when entering FreeCam mode
      if (modeChanged && p.cameraMode === CameraMode.FreeCam) {
        this.cameraPositions.set(p.playerId, {
          x: p.position.x,
          y: p.position.y + 5,
          z: p.position.z,
        });
        this.cameraAngles.set(p.playerId, {
          pitch: p.pitch,
          yaw: p.heading,
        });
      }

      // Clean up freecam data when leaving FreeCam
      if (modeChanged && prevMode === CameraMode.FreeCam && p.cameraMode !== CameraMode.FreeCam) {
        this.cameraPositions.delete(p.playerId);
        this.cameraAngles.delete(p.playerId);
      }

      switch (p.cameraMode) {
        case CameraMode.FirstPerson:
          // Camera at player eye level
          // Renderer reads player position + heading from SAB
          break;

        case CameraMode.ThirdPerson:
          // GTA V style: behind and above player, smooth follow with collision
          // Renderer handles actual camera positioning based on player pos from SAB
          // Here we just ensure heading is correct
          break;

        case CameraMode.FreeCam:
          // Freecam is handled renderer-side for smooth full-framerate updates.
          // Sim-side only initializes position on mode change (handled above).
          break;
      }

      // Handle camera zoom from input buffer (written by renderer)
      const zoom = input.getCameraZoom(i);
      if (zoom > 0 && p.thirdPersonDistance !== zoom) {
        p.thirdPersonDistance = Math.max(2, Math.min(20, zoom));
      }
    }
  }

  private tickFreecam(playerId: number, inputIdx: number, dt: number, input: InputBufferReader, playerPos: { x: number; y: number; z: number }): void {
    let pos = this.cameraPositions.get(playerId);
    if (!pos) {
      pos = { x: playerPos.x, y: playerPos.y + 5, z: playerPos.z };
      this.cameraPositions.set(playerId, pos);
    }
    let angles = this.cameraAngles.get(playerId);
    if (!angles) {
      angles = { pitch: 0, yaw: 0 };
      this.cameraAngles.set(playerId, angles);
    }

    // Movement
    const speed = 20 * dt;
    const cos = Math.cos(angles.yaw);
    const sin = Math.sin(angles.yaw);
    if (input.isKeyDown(inputIdx, KEY.W)) {
      pos.x += sin * speed;
      pos.z -= cos * speed;
    }
    if (input.isKeyDown(inputIdx, KEY.S)) {
      pos.x -= sin * speed;
      pos.z += cos * speed;
    }
    if (input.isKeyDown(inputIdx, KEY.A)) {
      pos.x -= cos * speed;
      pos.z -= sin * speed;
    }
    if (input.isKeyDown(inputIdx, KEY.D)) {
      pos.x += cos * speed;
      pos.z += sin * speed;
    }
    if (input.isKeyDown(inputIdx, KEY.SPACE)) {
      pos.y += speed;
    }
    if (input.isKeyDown(inputIdx, KEY.SHIFT)) {
      pos.y -= speed;
    }

    // Mouse look
    const md = input.consumeMouseDelta(inputIdx);
    if (md.dx !== 0) angles.yaw += md.dx * 0.003;
    if (md.dy !== 0) {
      angles.pitch -= md.dy * 0.003;
      angles.pitch = Math.max(-1.4, Math.min(1.4, angles.pitch));
    }

    this.cameraPositions.set(playerId, pos);
    this.cameraAngles.set(playerId, angles);
  }

  getFreecamPosition(playerId: number): { x: number; y: number; z: number } | null {
    return this.cameraPositions.get(playerId) ?? null;
  }

  getFreecamAngles(playerId: number): { pitch: number; yaw: number } | null {
    return this.cameraAngles.get(playerId) ?? null;
  }

  setFreecamData(playerId: number, pos: { x: number; y: number; z: number }, angles: { pitch: number; yaw: number }): void {
    this.cameraPositions.set(playerId, { ...pos });
    this.cameraAngles.set(playerId, { ...angles });
  }

  // Set camera mode for a player
  setCameraMode(player: SimPlayer, mode: CameraMode): void {
    if (player.cameraMode === CameraMode.FreeCam && mode !== CameraMode.FreeCam) {
      // Transitioning out of freecam — snap back to player
      this.cameraPositions.delete(player.playerId);
    }
    if (mode === CameraMode.FreeCam) {
      // Initialize freecam at player position
      this.cameraPositions.set(player.playerId, { ...player.position, y: player.position.y + 5 });
      this.cameraAngles.set(player.playerId, { pitch: 0, yaw: player.heading });
    }
    player.cameraMode = mode;
  }

  // Get portaled camera target (e.g., reversing camera on helm display)
  getPortaledCamera(shipEntity: SimEntity, type: "rear" | "side" | "top"): {
    position: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
  } {
    const pos = shipEntity.position;
    const heading = Math.atan2(shipEntity.velocity.x, shipEntity.velocity.z);

    switch (type) {
      case "rear":
        return {
          position: { x: pos.x - Math.cos(heading) * 5, y: pos.y + 3, z: pos.z - Math.sin(heading) * 5 },
          direction: { x: -Math.cos(heading), y: 0, z: -Math.sin(heading) },
        };
      case "side":
        return {
          position: { x: pos.x + Math.sin(heading) * 3, y: pos.y + 2, z: pos.z - Math.cos(heading) * 3 },
          direction: { x: Math.sin(heading), y: 0, z: -Math.cos(heading) },
        };
      case "top":
        return {
          position: { x: pos.x, y: pos.y + 20, z: pos.z },
          direction: { x: 0, y: -1, z: 0 },
        };
    }
  }
}
