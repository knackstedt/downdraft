// ============================================================================
// Camera System — view matrix calculation for 1st/3rd person and freecam
// ============================================================================

import { CameraMode } from "@shared/types";
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT } from "@shared/constants";

// Default mouse look sensitivity (multiplied by user sensitivity setting)
const FREECAM_MOUSE_SENSITIVITY = 0.001;
const FIRST_PERSON_MOUSE_SENSITIVITY = 0.001;
const THIRD_PERSON_MOUSE_SENSITIVITY = 0.005;

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  near: number;
  far: number;
  aspect: number;
}

// Key codes (match e.keyCode)
const KEY_W = 87, KEY_A = 65, KEY_S = 83, KEY_D = 68;
const KEY_SPACE = 32, KEY_SHIFT = 16;

export class CameraSystem {
  private thirdPersonDistance = 12;
  private thirdPersonHeight = PLAYER_HEIGHT * 0.8; // slightly above eye level
  private smoothPos: [number, number, number] | null = null;
  private smoothTarget: [number, number, number] | null = null;
  private lastMode: CameraMode = CameraMode.FirstPerson;
  private prevPlayerPos: [number, number, number] | null = null;

  // Freecam state (renderer-side for smooth full-framerate updates)
  private freecamPos: [number, number, number] = [0, 10, 0];
  private freecamAngles: { pitch: number; yaw: number } = { pitch: 0, yaw: 0 };
  private freecamInitialized = false;

  // Renderer-side mouse look for 1st/3rd person (smooth full-framerate updates)
  private lookHeading = 0;
  private lookPitch = 0;
  private lookSyncedTick = -1;

  // User-adjustable sensitivity multipliers (1.0 = default)
  private firstPersonSensitivity = 1.0;
  private thirdPersonSensitivity = 1.0;
  private freecamSensitivity = 1.0;

  // Pooled objects to avoid per-frame allocations in calculateCamera
  private pooledReturnState: CameraState = {
    position: [0, 0, 0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 60,
    near: 0.1,
    far: 4096,
    aspect: 1,
  };
  private pooledPos: [number, number, number] = [0, 0, 0];
  private pooledTarget: [number, number, number] = [0, 0, 0];
  private pooledDesiredOffset: [number, number, number] = [0, 0, 0];
  private pooledCurrentOffset: [number, number, number] = [0, 0, 0];

  calculateCamera(
    playerPos: { x: number; y: number; z: number },
    heading: number,
    pitch: number,
    mode: CameraMode,
    viewportIdx: number,
    dt: number,
    aspect: number,
  ): CameraState {
    const pos = this.pooledPos;
    const target = this.pooledTarget;

    // Reset smoothing when mode changes
    const modeChanged = mode !== this.lastMode;
    this.lastMode = mode;

    switch (mode) {
      case CameraMode.FirstPerson: {
        // Camera at eye level, looking in renderer-side heading/pitch direction
        const eyeY = playerPos.y + PLAYER_EYE_HEIGHT;
        pos[0] = playerPos.x; pos[1] = eyeY; pos[2] = playerPos.z;
        const lookDist = 100;
        const cp = Math.cos(this.lookPitch);
        const sp = Math.sin(this.lookPitch);
        target[0] = playerPos.x + Math.sin(this.lookHeading) * cp * lookDist;
        target[1] = eyeY + sp * lookDist;
        target[2] = playerPos.z - Math.cos(this.lookHeading) * cp * lookDist;
        break;
      }

      case CameraMode.ThirdPerson: {
        // Camera orbits behind player based on renderer-side heading.
        const dist = this.thirdPersonDistance;
        const clampedPitch = Math.max(-0.8, Math.min(0.6, this.lookPitch));
        const cp = Math.cos(clampedPitch);
        const sp = Math.sin(clampedPitch);

        pos[0] = playerPos.x - Math.sin(this.lookHeading) * cp * dist;
        pos[1] = playerPos.y + this.thirdPersonHeight - sp * dist;
        pos[2] = playerPos.z + Math.cos(this.lookHeading) * cp * dist;

        const torsoOffset = PLAYER_HEIGHT * 0.5;
        target[0] = playerPos.x;
        target[1] = playerPos.y + torsoOffset;
        target[2] = playerPos.z;
        break;
      }

      case CameraMode.FreeCam: {
        // Free-flying camera: use renderer-side freecam state
        pos[0] = this.freecamPos[0];
        pos[1] = this.freecamPos[1];
        pos[2] = this.freecamPos[2];
        const cp = Math.cos(this.freecamAngles.pitch);
        const sp = Math.sin(this.freecamAngles.pitch);
        const lookDist = 100;
        target[0] = this.freecamPos[0] + Math.sin(this.freecamAngles.yaw) * cp * lookDist;
        target[1] = this.freecamPos[1] + sp * lookDist;
        target[2] = this.freecamPos[2] - Math.cos(this.freecamAngles.yaw) * cp * lookDist;
        break;
      }

      default: {
        pos[0] = playerPos.x;
        pos[1] = playerPos.y + 3;
        pos[2] = playerPos.z + 8;
        target[0] = playerPos.x;
        target[1] = playerPos.y;
        target[2] = playerPos.z;
        break;
      }
    }

    // Smoothing: snap on mode change or for first-person/freecam.
    // For third-person, smooth the camera-to-player OFFSET rather than the
    // absolute world position. This prevents jitter: the camera moves instantly
    // with the player (no positional lag) while only the orbital angle/distance
    // is smoothed.
    if (mode === CameraMode.FirstPerson || mode === CameraMode.FreeCam || modeChanged) {
      if (!this.smoothPos) this.smoothPos = [0, 0, 0];
      if (!this.smoothTarget) this.smoothTarget = [0, 0, 0];
      this.smoothPos[0] = pos[0]; this.smoothPos[1] = pos[1]; this.smoothPos[2] = pos[2];
      this.smoothTarget[0] = target[0]; this.smoothTarget[1] = target[1]; this.smoothTarget[2] = target[2];
      if (!this.prevPlayerPos) this.prevPlayerPos = [0, 0, 0];
      this.prevPlayerPos[0] = playerPos.x;
      this.prevPlayerPos[1] = playerPos.y;
      this.prevPlayerPos[2] = playerPos.z;
    } else {
      if (!this.smoothPos) this.smoothPos = [pos[0], pos[1], pos[2]];
      if (!this.smoothTarget) this.smoothTarget = [target[0], target[1], target[2]];

      const lerp = 1 - Math.pow(0.001, dt);

      if (mode === CameraMode.ThirdPerson) {
        // Translate smoothPos by the player's movement delta so the offset
        // stays consistent when the player moves with the boat. Without this,
        // the offset shifts each frame the player moves, causing the lerp to
        // fight the movement and rubber-band.
        if (this.prevPlayerPos) {
          this.smoothPos[0] += playerPos.x - this.prevPlayerPos[0];
          this.smoothPos[1] += playerPos.y - this.prevPlayerPos[1];
          this.smoothPos[2] += playerPos.z - this.prevPlayerPos[2];
        }
        if (!this.prevPlayerPos) this.prevPlayerPos = [0, 0, 0];
        this.prevPlayerPos[0] = playerPos.x;
        this.prevPlayerPos[1] = playerPos.y;
        this.prevPlayerPos[2] = playerPos.z;

        // Smooth the offset from player position, then re-apply to current player pos
        const desiredOffset = this.pooledDesiredOffset;
        desiredOffset[0] = pos[0] - playerPos.x;
        desiredOffset[1] = pos[1] - playerPos.y;
        desiredOffset[2] = pos[2] - playerPos.z;
        const currentOffset = this.pooledCurrentOffset;
        currentOffset[0] = this.smoothPos[0] - playerPos.x;
        currentOffset[1] = this.smoothPos[1] - playerPos.y;
        currentOffset[2] = this.smoothPos[2] - playerPos.z;
        currentOffset[0] += (desiredOffset[0] - currentOffset[0]) * lerp;
        currentOffset[1] += (desiredOffset[1] - currentOffset[1]) * lerp;
        currentOffset[2] += (desiredOffset[2] - currentOffset[2]) * lerp;
        this.smoothPos[0] = playerPos.x + currentOffset[0];
        this.smoothPos[1] = playerPos.y + currentOffset[1];
        this.smoothPos[2] = playerPos.z + currentOffset[2];

        // Target offset is constant (torsoOffset), so just snap it
        this.smoothTarget[0] = target[0];
        this.smoothTarget[1] = target[1];
        this.smoothTarget[2] = target[2];
      } else {
        this.smoothPos[0] += (pos[0] - this.smoothPos[0]) * lerp;
        this.smoothPos[1] += (pos[1] - this.smoothPos[1]) * lerp;
        this.smoothPos[2] += (pos[2] - this.smoothPos[2]) * lerp;
        this.smoothTarget[0] += (target[0] - this.smoothTarget[0]) * lerp;
        this.smoothTarget[1] += (target[1] - this.smoothTarget[1]) * lerp;
        this.smoothTarget[2] += (target[2] - this.smoothTarget[2]) * lerp;
      }
    }

    const ret = this.pooledReturnState;
    ret.position[0] = this.smoothPos[0];
    ret.position[1] = this.smoothPos[1];
    ret.position[2] = this.smoothPos[2];
    ret.target[0] = this.smoothTarget[0];
    ret.target[1] = this.smoothTarget[1];
    ret.target[2] = this.smoothTarget[2];
    ret.aspect = aspect;
    return ret;
  }

  getThirdPersonDistance(): number {
    return this.thirdPersonDistance;
  }

  setThirdPersonDistance(d: number): void {
    this.thirdPersonDistance = Math.max(2, Math.min(20, d));
  }

  setThirdPersonHeight(h: number): void {
    this.thirdPersonHeight = Math.max(1, Math.min(10, h));
  }

  // Update freecam from renderer input — runs at full frame rate for smooth movement
  updateFreecam(
    keysDown: Set<number>,
    mouseDelta: { dx: number; dy: number },
    dt: number,
    playerPos: { x: number; y: number; z: number },
    playerHeading: number,
    playerPitch: number,
  ): void {
    // Initialize freecam at player position on first use
    if (!this.freecamInitialized) {
      this.freecamPos = [playerPos.x, playerPos.y + 5, playerPos.z];
      this.freecamAngles = { pitch: playerPitch, yaw: playerHeading };
      this.freecamInitialized = true;
    }

    const speed = 20 * dt;
    const cos = Math.cos(this.freecamAngles.yaw);
    const sin = Math.sin(this.freecamAngles.yaw);

    if (keysDown.has(KEY_W)) {
      this.freecamPos[0] += sin * speed;
      this.freecamPos[2] -= cos * speed;
    }
    if (keysDown.has(KEY_S)) {
      this.freecamPos[0] -= sin * speed;
      this.freecamPos[2] += cos * speed;
    }
    if (keysDown.has(KEY_A)) {
      this.freecamPos[0] -= cos * speed;
      this.freecamPos[2] -= sin * speed;
    }
    if (keysDown.has(KEY_D)) {
      this.freecamPos[0] += cos * speed;
      this.freecamPos[2] += sin * speed;
    }
    if (keysDown.has(KEY_SPACE)) {
      this.freecamPos[1] += speed;
    }
    if (keysDown.has(KEY_SHIFT)) {
      this.freecamPos[1] -= speed;
    }

    // Mouse look
    const fSens = FREECAM_MOUSE_SENSITIVITY * this.freecamSensitivity;
    if (mouseDelta.dx !== 0) this.freecamAngles.yaw += mouseDelta.dx * fSens;
    if (mouseDelta.dy !== 0) {
      this.freecamAngles.pitch -= mouseDelta.dy * fSens;
      this.freecamAngles.pitch = Math.max(-1.4, Math.min(1.4, this.freecamAngles.pitch));
    }
  }

  // Renderer-side mouse look for 1st/3rd person (smooth full-framerate updates)
  // Maintains its own heading/pitch, initialized from SAB once. Both the renderer
  // and sim process the same mouse delta independently, staying approximately in sync.
  updateLook(
    mouseDelta: { dx: number; dy: number },
    simTick: number,
    sabHeading: number,
    sabPitch: number,
    mode: CameraMode,
  ): void {
    // Initialize from SAB on first call or when tick hasn't been set
    if (this.lookSyncedTick < 0) {
      this.lookHeading = sabHeading;
      this.lookPitch = sabPitch;
    }
    this.lookSyncedTick = simTick;

    const baseSens = mode === CameraMode.ThirdPerson
      ? THIRD_PERSON_MOUSE_SENSITIVITY
      : FIRST_PERSON_MOUSE_SENSITIVITY;
    const sens = baseSens * (mode === CameraMode.ThirdPerson
      ? this.thirdPersonSensitivity
      : this.firstPersonSensitivity);

    if (mouseDelta.dx !== 0) this.lookHeading += mouseDelta.dx * sens;
    if (mouseDelta.dy !== 0) {
      if (mode === CameraMode.ThirdPerson) {
        this.lookPitch -= mouseDelta.dy * sens;
        this.lookPitch = Math.max(-0.8, Math.min(0.6, this.lookPitch));
      } else {
        this.lookPitch -= mouseDelta.dy * sens;
        this.lookPitch = Math.max(-1.4, Math.min(1.4, this.lookPitch));
      }
    }
  }

  // Reset look state (called on mode entry to snap to SAB values)
  resetLook(heading: number, pitch: number): void {
    this.lookHeading = heading;
    this.lookPitch = pitch;
    this.lookSyncedTick = -1;
  }

  getLookHeading(): number { return this.lookHeading; }
  getLookPitch(): number { return this.lookPitch; }

  // Reset freecam (called when entering freecam mode to snap to player)
  resetFreecam(playerPos: { x: number; y: number; z: number }, heading: number, pitch: number): void {
    this.freecamPos = [playerPos.x, playerPos.y + 5, playerPos.z];
    this.freecamAngles = { pitch, yaw: heading };
    this.freecamInitialized = true;
  }

  // Clear freecam state (called when leaving freecam mode)
  clearFreecam(): void {
    this.freecamInitialized = false;
  }

  setFirstPersonSensitivity(v: number): void { this.firstPersonSensitivity = v; }
  setThirdPersonSensitivity(v: number): void { this.thirdPersonSensitivity = v; }
  setFreecamSensitivity(v: number): void { this.freecamSensitivity = v; }
}
