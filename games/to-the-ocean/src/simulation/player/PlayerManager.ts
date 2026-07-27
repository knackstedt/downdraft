// ============================================================================
// Player Manager — health, movement, swimming, oxygen tanks, death/respawn
// ============================================================================

import { InputBufferReader, KEY } from "../../shared/input-buffer";
import { SimPlayer, SimEntity } from "../Simulation";
import { CameraMode } from "../../shared/types";
import {
  PLAYER_SWIM_SPEED, PLAYER_WALK_SPEED, PLAYER_RUN_SPEED,
  PLAYER_MAX_HEALTH, HOTBAR_SLOTS, HOTBAR_TOOLS,
  PLAYER_FLOAT_FORCE, PLAYER_DIVE_FORCE, PLAYER_WATER_SINK_RATE,
  PLAYER_WATER_DRAG, PLAYER_SWIM_VERTICAL_MAX, PLAYER_GRAVITY, PLAYER_JUMP_FORCE,
} from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";
import { WaterBufferWriter, WATER_GRID } from "../../shared/water-buffer";
import { PlayerMoveRequest } from "../physics/RapierPhysicsSystem";
import { collectShoreSources, shoreDamping, shoreDisplacement, waterCutout, ShoreSource } from "../../shared/shore-damping";

const VCLIP_BASE_SPEED = 20; // m/s base flight speed

export class PlayerManager {
  private oxygenTankLevel = new Map<number, number>(); // playerId -> oxygen tank tier
  private prevVPressed = new Map<number, boolean>();
  private prevNumberKeys = new Map<number, boolean[]>();
  private prevF5Pressed = new Map<number, boolean>();
  private waterWriter: WaterBufferWriter;
  private isDev: boolean;
  private shoreSources: ShoreSource[] = [];
  private shoreCount = 0;
  private simTime = 0;

  // Movement requests computed during computeMovement, consumed by Rapier
  private moveRequests: PlayerMoveRequest[] = [];

  constructor(waterWriter: WaterBufferWriter, isDev: boolean = false) {
    this.waterWriter = waterWriter;
    this.isDev = isDev;
  }

  // Phase 1: Compute desired movement (runs BEFORE Rapier physics).
  // Collects PlayerMoveRequests that Rapier will resolve against world colliders.
  // For noclip/freecam/climbing, movement is applied directly (skipCollision=true).
  computeMovement(
    dt: number,
    input: InputBufferReader,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): PlayerMoveRequest[] {
    // Collect island/port positions for shore damping in water sampling
    if (this.shoreSources.length < 128) this.shoreSources = [];
    while (this.shoreSources.length < 128) this.shoreSources.push({ x: 0, z: 0, radius: 0, cutoutRadius: 0 });
    this.shoreCount = collectShoreSources(entities, entityCount, this.shoreSources);
    this.simTime += dt;

    this.moveRequests.length = 0;

    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;

      // Skip if dead
      if (p.flags & PLR_FLAG.DEAD) continue;

      // Skip if sleeping
      if (p.flags & PLR_FLAG.SLEEPING) continue;

      // Skip if climbing — BoatSystem controls position during climb animation
      if (p.flags & PLR_FLAG.CLIMBING) continue;

      // F5 toggles vclip (dev only, edge-triggered)
      if (this.isDev) {
        const f5Pressed = input.isKeyDown(i, KEY.F5);
        const f5WasPressed = this.prevF5Pressed.get(i) ?? false;
        if (f5Pressed && !f5WasPressed) {
          p.flags ^= PLR_FLAG.NOCLIP;
          if (p.flags & PLR_FLAG.NOCLIP) {
            p.velocity.x = 0; p.velocity.y = 0; p.velocity.z = 0;
          }
        }
        this.prevF5Pressed.set(i, f5Pressed);
      }

      const isNoclip = (p.flags & PLR_FLAG.NOCLIP) !== 0;

      // Skip movement if piloting a ship — BoatSystem handles control
      const isPiloting = (p.flags & PLR_FLAG.PILOTING) !== 0;

      // Skip WASD if piloting (ship controls) or in FreeCam (camera controls)
      const isFreeCam = p.cameraMode === CameraMode.FreeCam;
      let moveX = 0, moveZ = 0;
      if (!isPiloting && !isFreeCam) {
        if (input.isKeyDown(i, KEY.W)) moveZ -= 1;
        if (input.isKeyDown(i, KEY.S)) moveZ += 1;
        if (input.isKeyDown(i, KEY.A)) moveX -= 1;
        if (input.isKeyDown(i, KEY.D)) moveX += 1;
      }

      // Mouse-look: read heading/pitch from renderer via input buffer
      if (!isFreeCam) {
        p.heading = input.getLookHeading(i);
        p.pitch = input.getLookPitch(i);
      }

      // V key toggles camera mode (edge-triggered)
      const vPressed = input.isKeyDown(i, KEY.V);
      const vWasPressed = this.prevVPressed.get(i) ?? false;
      if (vPressed && !vWasPressed) {
        if (p.cameraMode === CameraMode.FirstPerson) {
          p.cameraMode = CameraMode.ThirdPerson;
        } else if (p.cameraMode === CameraMode.ThirdPerson) {
          p.cameraMode = CameraMode.FreeCam;
        } else {
          p.cameraMode = CameraMode.FirstPerson;
        }
      }
      this.prevVPressed.set(i, vPressed);

      // Number keys 1-0 select hotbar slot (edge-triggered)
      const numberKeys = [KEY.ONE, KEY.TWO, KEY.THREE, KEY.FOUR, KEY.FIVE, KEY.SIX, KEY.SEVEN, KEY.EIGHT, KEY.NINE, KEY.ZERO];
      let prevKeys = this.prevNumberKeys.get(i);
      if (!prevKeys) { prevKeys = new Array(10).fill(false); this.prevNumberKeys.set(i, prevKeys); }
      for (let s = 0; s < numberKeys.length && s < HOTBAR_SLOTS; s++) {
        const isDown = input.isKeyDown(i, numberKeys[s]);
        if (isDown && !prevKeys[s]) {
          p.activeSlot = s;
        }
        prevKeys[s] = isDown;
      }

      // Mouse wheel scrolls through all hotbar tools (wraps around)
      const wheel = input.consumeWheel(i);
      if (wheel !== 0) {
        const totalTools = HOTBAR_TOOLS.length;
        if (wheel > 0) {
          p.activeSlot = (p.activeSlot + 1) % totalTools;
        } else {
          p.activeSlot = (p.activeSlot - 1 + totalTools) % totalTools;
        }
      }

      const isOnboard = (p.flags & PLR_FLAG.ONBOARD) !== 0;

      // --- Water detection & vertical physics ---
      const waterHeight = this.sampleWaterAt(p.position.x, p.position.z);
      const inWater = !isOnboard && p.position.y < waterHeight;
      const isUnderwater = inWater && p.position.y < waterHeight - 0.5;

      if (inWater) {
        p.flags |= PLR_FLAG.SWIMMING;
        if (isUnderwater) {
          p.flags |= PLR_FLAG.UNDERWATER;
        } else {
          p.flags &= ~PLR_FLAG.UNDERWATER;
        }
      } else {
        p.flags &= ~PLR_FLAG.SWIMMING;
        p.flags &= ~PLR_FLAG.UNDERWATER;
      }

      // Skip physics & movement in FreeCam — player is frozen
      if (isFreeCam) {
        this.moveRequests.push({ playerIdx: i, desiredDeltaX: 0, desiredDeltaY: 0, desiredDeltaZ: 0, skipCollision: true });
        continue;
      }

      if (isNoclip) {
        // --- Vclip: free flight, no gravity, no collision ---
        let speedMultiplier = 1;
        if (input.isKeyDown(i, KEY.ALT)) speedMultiplier = 20;
        else if (input.isKeyDown(i, KEY.CTRL)) speedMultiplier = 10;
        else if (input.isKeyDown(i, KEY.SHIFT)) speedMultiplier = 3;

        const vclipSpeed = VCLIP_BASE_SPEED * speedMultiplier;

        let deltaX = 0, deltaY = 0, deltaZ = 0;

        // Horizontal movement (WASD relative to heading)
        if (!isPiloting) {
          const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
          if (len > 0) {
            moveX /= len;
            moveZ /= len;
            const cos = Math.cos(p.heading);
            const sin = Math.sin(p.heading);
            deltaX = (moveX * cos - moveZ * sin) * vclipSpeed * dt;
            deltaZ = (moveX * sin + moveZ * cos) * vclipSpeed * dt;
          }
        }

        // Vertical: Space=up, C=down
        if (input.isKeyDown(i, KEY.SPACE)) deltaY += vclipSpeed * dt;
        if (input.isKeyDown(i, KEY.C)) deltaY -= vclipSpeed * dt;

        // Apply directly — no collision for noclip
        p.position.x += deltaX;
        p.position.y += deltaY;
        p.position.z += deltaZ;

        this.moveRequests.push({ playerIdx: i, desiredDeltaX: 0, desiredDeltaY: 0, desiredDeltaZ: 0, skipCollision: true });
        continue;
      }

      // --- Normal movement (collision-resolved by Rapier) ---
      // SHIFT means dive when in water, run when on land
      const isRunning = !inWater && input.isKeyDown(i, KEY.SHIFT);
      const isFloating = inWater && input.isKeyDown(i, KEY.SPACE);
      const isDiving = inWater && input.isKeyDown(i, KEY.SHIFT);

      let desiredDeltaX = 0, desiredDeltaY = 0, desiredDeltaZ = 0;

      // Vertical movement
      if (inWater) {
        if (isFloating) {
          p.velocity.y += PLAYER_FLOAT_FORCE * dt;
        } else if (isDiving) {
          p.velocity.y -= PLAYER_DIVE_FORCE * dt;
        } else {
          // Gentle sink when no vertical input
          p.velocity.y -= PLAYER_WATER_SINK_RATE * dt;
        }
        // Water drag
        p.velocity.y *= PLAYER_WATER_DRAG;
        // Clamp vertical speed
        p.velocity.y = Math.max(-PLAYER_SWIM_VERTICAL_MAX, Math.min(PLAYER_SWIM_VERTICAL_MAX, p.velocity.y));
        // Desired vertical delta
        desiredDeltaY = p.velocity.y * dt;
        // Stop at water surface if floating up (don't launch out of water)
        if (isFloating && p.position.y + desiredDeltaY > waterHeight - 0.3) {
          desiredDeltaY = waterHeight - 0.3 - p.position.y;
          p.velocity.y = 0;
        }
      } else {
        // Gravity when not in water
        // Jump: if grounded (Rapier set GROUNDED) and SPACE pressed
        const isGrounded = (p.flags & PLR_FLAG.GROUNDED) !== 0;
        if (isGrounded && input.isKeyDown(i, KEY.SPACE) && !isPiloting) {
          p.velocity.y = PLAYER_JUMP_FORCE;
          p.flags &= ~PLR_FLAG.GROUNDED;
        }
        p.velocity.y -= PLAYER_GRAVITY * dt;
        desiredDeltaY = p.velocity.y * dt;
        // Simple ground collision (seabed / terrain) — fallback if no Rapier
        const seabedHeight = -75;
        if (p.position.y + desiredDeltaY < seabedHeight) {
          desiredDeltaY = seabedHeight - p.position.y;
          p.velocity.y = 0;
        }
      }

      // Normalize movement
      const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
      if (len > 0) {
        moveX /= len;
        moveZ /= len;
      }

      // Speed
      let speed = isRunning ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED;
      if (inWater) speed = PLAYER_SWIM_SPEED;

      // Compute desired horizontal movement relative to heading
      if (len > 0 && !isPiloting) {
        const cos = Math.cos(p.heading);
        const sin = Math.sin(p.heading);
        desiredDeltaX = (moveX * cos - moveZ * sin) * speed * dt;
        desiredDeltaZ = (moveX * sin + moveZ * cos) * speed * dt;

        // Update body heading to face movement direction
        const moveAngle = Math.atan2(desiredDeltaX, -desiredDeltaZ);
        let diff = moveAngle - p.bodyHeading;
        if (!Number.isFinite(diff)) diff = 0;
        else diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        const rotSpeed = 8.0 * dt;
        if (Math.abs(diff) <= rotSpeed) {
          p.bodyHeading = moveAngle;
        } else {
          p.bodyHeading += Math.sign(diff) * rotSpeed;
        }
      }

      // For piloting players, no movement delta (BoatSystem controls position)
      // For onboard players, BoatSystem handles ship-tracking + floor snap
      const skipCollision = isPiloting || isOnboard;

      this.moveRequests.push({
        playerIdx: i,
        desiredDeltaX,
        desiredDeltaY,
        desiredDeltaZ,
        skipCollision,
      });
    }

    return this.moveRequests;
  }

  // Phase 2: Sync player entity positions after Rapier resolved collisions.
  // Called after RapierPhysicsSystem.tickPlayers.
  syncEntities(
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;
      if (p.flags & PLR_FLAG.SLEEPING) continue;
      if (p.flags & PLR_FLAG.CLIMBING) continue;

      // Update player entity position
      for (let j = 0; j < entityCount; j++) {
        const ent = entities[j];
        if (!ent || ent.id !== p.entityId) continue;
        ent.position.x = p.position.x;
        ent.position.y = p.position.y;
        ent.position.z = p.position.z;
        break;
      }

      // Update oxygen tank capacity
      const tankTier = this.oxygenTankLevel.get(p.playerId) ?? 0;
      p.maxOxygen = 100 + tankTier * 50;
    }
  }

  // Set oxygen tank tier for a player
  setOxygenTank(playerId: number, tier: number): void {
    this.oxygenTankLevel.set(playerId, tier);
  }

  // Get oxygen tank tier
  getOxygenTank(playerId: number): number {
    return this.oxygenTankLevel.get(playerId) ?? 0;
  }

  // Deal damage to player
  damagePlayer(player: SimPlayer, amount: number): void {
    player.health = Math.max(0, player.health - amount);
    if (player.health <= 0) {
      player.flags |= PLR_FLAG.DEAD;
    }
  }

  // Heal player
  healPlayer(player: SimPlayer, amount: number): void {
    player.health = Math.min(player.maxHealth, player.health + amount);
  }

  // Respawn player
  respawnPlayer(player: SimPlayer, bedPos: { x: number; y: number; z: number }): void {
    player.health = PLAYER_MAX_HEALTH;
    player.flags &= ~PLR_FLAG.DEAD;
    player.position = { ...bedPos };
    player.velocity = { x: 0, y: 0, z: 0 };
  }

  // --- Water sampling ---
  private sampleWaterAt(x: number, z: number): number {
    // Inside a water cutout zone — no water (return very negative height)
    if (waterCutout(x, z, this.shoreSources, this.shoreCount)) return -1000;
    const patchSize = this.waterWriter.getPatchSize() || 4;
    const origin = this.waterWriter.getOrigin();
    const gx = ((x - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const gz = ((z - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
    const rawH = this.waterWriter.sampleHeight(gx, gz);
    // Apply shore damping + shore ring waves so player swimming matches the visual water near islands
    const damping = shoreDamping(x, z, this.shoreSources, this.shoreCount);
    const shore = shoreDisplacement(x, z, this.simTime, this.shoreSources, this.shoreCount);
    return rawH * damping + shore;
  }
}
