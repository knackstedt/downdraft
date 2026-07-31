// ============================================================================
// Boat System — boarding, disembarking, ship control, propulsion, repair
// ============================================================================

import {
    BOAT_CELL_WORLD_SIZE,
    BOAT_GRID_MAX,
    BOAT_LAYER_HEIGHT,
    BoatCellType,
    BUILDER_CELL_OPTIONS,
    CellTemplateEntry,
    HOTBAR_TOOLS,
    PLAYER_EYE_HEIGHT, PLAYER_HEIGHT,
    PLAYER_JUMP_FORCE,
    rotateTemplate,
    SHIP_ACCEL_RATE,
    SHIP_ANGULAR_DRAG,
    SHIP_BASE_SPEED,
    SHIP_DATA,
    SHIP_DISEMBARK_OFFSET,
    SHIP_DRAG,
    SHIP_MAX_SPEED,
    SHIP_REPAIR_RATE,
    SHIP_TURN_RATE,
    SHIP_TURN_SPEED_FACTOR,
    SHIP_YAW_MAX
} from "../../shared/constants";
import { InputBufferReader, KEY } from "../../shared/input-buffer";
import { PLR_FLAG } from "../../shared/sim-buffer";
import { EntityType } from "../../shared/types";
import { SimEntity, SimPlayer } from "../Simulation";
import { AnchorSystem } from "./AnchorSystem";
import { BoatCellSystem } from "./BoatCellSystem";
import { BoatDesignSystem } from "./BoatDesignSystem";

interface ClimbAnimState {
  shipEntityId: number;
  phase: number;           // 0 = lerp to edge, 1 = up and over
  t: number;               // 0..1 progress within current phase
  // Ship-local space positions (so climb tracks ship movement)
  startLocalX: number; startLocalY: number; startLocalZ: number;
  edgeLocalX: number;  edgeLocalY: number;  edgeLocalZ: number;
  targetLocalX: number; targetLocalY: number; targetLocalZ: number;
}

interface PlayerShipState {
  shipEntityId: number;     // entity ID of the ship the player is on (0 = none)
  boardingCooldown: number; // seconds until can board/disembark again
  repairActive: boolean;    // currently repairing
  buildCooldown: number;    // cooldown for build mode clicks
  prevMouseLeft: boolean;   // previous mouse left state for edge detection
  isOnboard: boolean;       // player is standing on a ship
  isPiloting: boolean;      // player is at the helm, controlling the ship
  ownedShipId: number;      // entity ID of the ship this player owns
  prevShipPosX: number;     // ship X position from last tick (for delta tracking)
  prevShipPosY: number;     // ship Y position from last tick
  prevShipPosZ: number;     // ship Z position from last tick
  prevShipHeading: number;  // ship heading from last tick (for rotation tracking)
  prevShipPitch: number;    // ship pitch from last tick
  prevShipRoll: number;     // ship roll from last tick
  prevLocalX: number;       // player's local X from last tick (for displacement clamp)
  prevLocalY: number;       // player's local Y from last tick
  prevLocalZ: number;       // player's local Z from last tick
  hasPrevLocal: boolean;    // whether prevLocal is initialized
  climbState: ClimbAnimState | null;  // active climb animation (null = not climbing)
  prevSpace: boolean;       // previous SPACE key state for edge detection
  prevQ: boolean;           // previous Q key state for anchor toggle edge detection
}

// Helm position relative to ship center (in local space before rotation)
const HELM_LOCAL_OFFSET = { x: 0, z: 1 }; // near the back of the ship
const HELM_INTERACT_RANGE = 2.5; // meters to interact with helm
const DISEMBARK_EDGE_RANGE = 1.5; // meters from ship edge to disembark

// Climb parameters
const CLIMB_HEIGHT_THRESHOLD = 2.5;   // max height above player feet to climb (meters)
const CLIMB_HORIZONTAL_RANGE = 3.0;   // max horizontal distance to edge to start climb (meters)
const CLIMB_PHASE1_DURATION = 0.4;    // seconds: lerp to edge
const CLIMB_PHASE2_DURATION = 0.6;    // seconds: up and over
const CLIMB_ARC_HEIGHT = 0.5;         // extra arc height in phase 2 (meters)

export class BoatSystem {
  private playerShipState = new Map<number, PlayerShipState>();
  private pilotedShipIds = new Set<number>();
  private boatDesignSystem: BoatDesignSystem | null = null;
  private anchorSystem: AnchorSystem | null = null;

  setBoatDesignSystem(bds: BoatDesignSystem): void {
    this.boatDesignSystem = bds;
  }

  setAnchorSystem(as: AnchorSystem): void {
    this.anchorSystem = as;
  }

  // Hull queries: check both smooth design geometry AND legacy cell grid.
  // A player is "over the ship" if they're over the hull mesh OR any cell
  // (bridge/deck cells may not be in the smooth hull mesh).
  private isOverShip(shipId: number, localX: number, localZ: number, boatCellSystem: BoatCellSystem): boolean {
    if (this.boatDesignSystem && this.boatDesignSystem.isOverHull(shipId, localX, localZ)) return true;
    return boatCellSystem.isOverShipCells(shipId, localX, localZ);
  }

  private resolvePlayerHull(
    shipId: number, localX: number, localY: number, localZ: number,
    radius: number, height: number, boatCellSystem: BoatCellSystem,
  ): { x: number; z: number; floorY: number } {
    // Cell system is the primary and authoritative source for floor detection.
    // It correctly finds the floor at/below the player's feet, and snaps up
    // to the nearest solid surface above when no floor below is found.
    const cellResult = boatCellSystem.resolveCellCollision(shipId, localX, localY, localZ, radius, height);

    // If the cell system found a floor, use it exclusively — don't mix in
    // the design system's floorY (its geometry doesn't match the cell layout
    // and getHeightAt returns the highest surface, which could be a roof).
    if (Number.isFinite(cellResult.floorY)) return cellResult;

    // No cell floor found — try design system as fallback (e.g. smooth-hull only ships)
    if (this.boatDesignSystem) {
      const designResult = this.boatDesignSystem.resolvePlayerCollision(shipId, cellResult.x, localY, cellResult.z, radius, height);
      return {
        x: designResult.x,
        z: designResult.z,
        floorY: designResult.floorY,
      };
    }

    return cellResult;
  }

  private findClimbableHullEdge(
    shipId: number, localX: number, localY: number, localZ: number,
    climbThreshold: number, playerHeight: number, maxHorizontalDist: number,
    boatCellSystem: BoatCellSystem,
  ): { gridX: number; gridY: number; gridZ: number; edgeLocalX: number; edgeLocalZ: number; topLocalY: number; targetLocalX: number; targetLocalZ: number } | null {
    if (this.boatDesignSystem) {
      const result = this.boatDesignSystem.findClimbableEdge(shipId, localX, localY, localZ, climbThreshold, playerHeight, maxHorizontalDist);
      if (result) return result;
    }
    return boatCellSystem.findClimbableEdge(shipId, localX, localY, localZ, climbThreshold, playerHeight, maxHorizontalDist);
  }

  // Phase 1: Handle piloting controls (runs BEFORE buoyancy/collision)
  controlTick(
    dt: number,
    input: InputBufferReader,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
    boatCellSystem: BoatCellSystem,
  ): void {
    this.pilotedShipIds.clear();

    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;

      let state = this.playerShipState.get(p.playerId);
      if (!state) {
        state = { shipEntityId: 0, boardingCooldown: 0, repairActive: false, buildCooldown: 0, prevMouseLeft: false, isOnboard: false, isPiloting: false, ownedShipId: 0, prevShipPosX: 0, prevShipPosY: 0, prevShipPosZ: 0, prevShipHeading: 0, prevShipPitch: 0, prevShipRoll: 0, prevLocalX: 0, prevLocalY: 0, prevLocalZ: 0, hasPrevLocal: false, climbState: null, prevSpace: false, prevQ: false };
        this.playerShipState.set(p.playerId, state);
      }

      if (p.flags & PLR_FLAG.CLIMBING) {
        if (!state.climbState) continue;
      }

      if (p.flags & PLR_FLAG.NOCLIP) {
        if (state.isOnboard || state.isPiloting) {
          this.disembark(p, state, entities, entityCount);
        }
        continue;
      }

      if (state.boardingCooldown > 0) {
        state.boardingCooldown -= dt;
      }

      const isPiloting = state.isPiloting;
      const isOnboard = state.isOnboard;

      // F key — piloting toggle
      const fPressed = input.isKeyDown(i, KEY.F);
      if (fPressed && state.boardingCooldown <= 0) {
        if (isPiloting) {
          state.isPiloting = false;
          p.flags &= ~PLR_FLAG.PILOTING;
          const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
          if (ship) {
            ship.data[SHIP_DATA.THROTTLE] = 0;
            ship.data[SHIP_DATA.STEERING] = 0;
          }
          state.boardingCooldown = 0.3;
        } else if (isOnboard && state.shipEntityId !== 0) {
          const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
          if (ship) {
            const distToHelm = this.distToHelm(p, ship);
            if (distToHelm <= HELM_INTERACT_RANGE) {
              state.isPiloting = true;
              p.flags |= PLR_FLAG.PILOTING;
              state.boardingCooldown = 0.3;
            }
          }
        }
      }

      // If piloting, control the ship
      if (state.isPiloting && state.shipEntityId !== 0) {
        const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
        if (ship && ship.type === EntityType.Ship) {
          this.controlShip(dt, input, i, p, ship, state);
          this.pilotedShipIds.add(ship.id);
        }
      }
    }
  }

  getPilotedShipIds(): Set<number> {
    return this.pilotedShipIds;
  }

  // Phase 2: Player tracking and interactions (runs AFTER buoyancy/collision/updateAllShips)
  postPhysicsTick(
    dt: number,
    input: InputBufferReader,
    players: SimPlayer[],
    playerCount: number,
    entities: SimEntity[],
    entityCount: number,
    boatCellSystem: BoatCellSystem,
  ): void {
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;

      let state = this.playerShipState.get(p.playerId);
      if (!state) {
        state = { shipEntityId: 0, boardingCooldown: 0, repairActive: false, buildCooldown: 0, prevMouseLeft: false, isOnboard: false, isPiloting: false, ownedShipId: 0, prevShipPosX: 0, prevShipPosY: 0, prevShipPosZ: 0, prevShipHeading: 0, prevShipPitch: 0, prevShipRoll: 0, prevLocalX: 0, prevLocalY: 0, prevLocalZ: 0, hasPrevLocal: false, climbState: null, prevSpace: false, prevQ: false };
        this.playerShipState.set(p.playerId, state);
      }

      // Skip if climbing a port — PortSystem controls position during port climb
      if (p.flags & PLR_FLAG.CLIMBING) {
        // Only skip if BoatSystem doesn't own this climb
        if (!state.climbState) continue;
      }

      // Skip if noclipping — vclip passes through ships freely
      if (p.flags & PLR_FLAG.NOCLIP) continue;

      const isPiloting = state.isPiloting;
      const isOnboard = state.isOnboard;

      // Handle active climb animation (takes priority over onboard/not-onboard logic)
      if (state.climbState) {
        this.updateClimb(p, state, dt, entities, entityCount, boatCellSystem);
        state.prevSpace = input.isKeyDown(i, KEY.SPACE);
        continue;
      }

      // If onboard, keep player on ship and handle build mode
      if (isOnboard && state.shipEntityId !== 0) {
        const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
        if (!ship || ship.type !== EntityType.Ship) {
          this.disembark(p, state, entities, entityCount);
          boatCellSystem.clearPreview();
          continue;
        }

        // Update player position on ship (tracks ship movement, handles jump/deck)
        this.updatePlayerOnShip(p, ship, state, isPiloting, input, i, boatCellSystem);

        // Check if player walked off the ship
        const local = this.worldToLocal(p, ship);
        if (!this.isOverShip(ship.id, local.localX, local.localZ, boatCellSystem)) {
          // Player is no longer over ship cells — auto-disembark
          this.autoDisembark(p, state);
          boatCellSystem.clearPreview();
          // Try to board another ship immediately (e.g., stepped onto another boat)
          this.tryAutoBoard(p, state, entities, entityCount, boatCellSystem);
        } else {
          // Still on ship — handle build mode
          this.handleBuildMode(dt, input, i, p, ship, state, boatCellSystem);
        }
      } else {
        // Not onboard — Rapier's character controller handles player-vs-ship collision.
        // Try auto-boarding (standing on a ship)
        const boarded = this.tryAutoBoard(p, state, entities, entityCount, boatCellSystem);
        if (!boarded) {
          boatCellSystem.clearPreview();

          // Try climbing onto boat when SPACE is pressed (edge-triggered)
          const spacePressed = input.isKeyDown(i, KEY.SPACE);
          if (spacePressed && !state.prevSpace) {
            this.tryStartClimb(p, state, entities, entityCount, boatCellSystem);
          }
          state.prevSpace = spacePressed;
        } else {
          state.prevSpace = input.isKeyDown(i, KEY.SPACE);
        }
      }

      // R key — toggle repair mode (only when onboard AND builder tool not active)
      if (isOnboard && state.shipEntityId !== 0 && p.activeSlot !== 0) {
        const rPressed = input.isKeyDown(i, KEY.R);
        if (rPressed && state.boardingCooldown <= 0) {
          state.repairActive = !state.repairActive;
          state.boardingCooldown = 0.3;
        }

        if (state.repairActive) {
          const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
          if (ship) {
            this.repairShip(ship, dt);
          }
        }
      }
    }
  }

  // --- Climb: try to start a climb onto a nearby boat edge ---

  private tryStartClimb(
    player: SimPlayer,
    state: PlayerShipState,
    entities: SimEntity[],
    entityCount: number,
    boatCellSystem: BoatCellSystem,
  ): void {
    const maxExtent = BOAT_GRID_MAX * BOAT_CELL_WORLD_SIZE + 2;

    for (let j = 0; j < entityCount; j++) {
      const ship = entities[j];
      if (!ship || ship.type !== EntityType.Ship) continue;

      // Broad-phase: skip ships too far away
      const sdx = player.position.x - ship.position.x;
      const sdz = player.position.z - ship.position.z;
      const sdistSq = sdx * sdx + sdz * sdz;
      if (sdistSq > maxExtent * maxExtent) continue;

      // Transform player position to ship-local space
      const heading = ship.data[SHIP_DATA.HEADING] ?? 0;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const localX = sdx * cos - sdz * sin;
      const localZ = sdx * sin + sdz * cos;
      const localY = player.position.y - ship.position.y;

      const edge = this.findClimbableHullEdge(
        ship.id, localX, localY, localZ,
        CLIMB_HEIGHT_THRESHOLD, PLAYER_HEIGHT, CLIMB_HORIZONTAL_RANGE,
        boatCellSystem,
      );

      if (edge) {
        // Start climb animation
        state.climbState = {
          shipEntityId: ship.id,
          phase: 0,
          t: 0,
          startLocalX: localX, startLocalY: localY, startLocalZ: localZ,
          edgeLocalX: edge.edgeLocalX, edgeLocalY: edge.topLocalY, edgeLocalZ: edge.edgeLocalZ,
          targetLocalX: edge.targetLocalX, targetLocalY: edge.topLocalY, targetLocalZ: edge.targetLocalZ,
        };
        player.flags |= PLR_FLAG.CLIMBING;
        player.velocity.x = 0;
        player.velocity.y = 0;
        player.velocity.z = 0;
        return;
      }
    }
  }

  // --- Climb: update climb animation each tick ---

  private updateClimb(
    player: SimPlayer,
    state: PlayerShipState,
    dt: number,
    entities: SimEntity[],
    entityCount: number,
    boatCellSystem: BoatCellSystem,
  ): void {
    const climb = state.climbState;
    if (!climb) return;

    const ship = this.findEntityById(entities, entityCount, climb.shipEntityId);
    if (!ship || ship.type !== EntityType.Ship) {
      // Ship destroyed — cancel climb
      state.climbState = null;
      player.flags &= ~PLR_FLAG.CLIMBING;
      return;
    }

    const heading = ship.data[SHIP_DATA.HEADING] ?? 0;

    // Advance progress
    const duration = climb.phase === 0 ? CLIMB_PHASE1_DURATION : CLIMB_PHASE2_DURATION;
    climb.t += dt / duration;

    if (climb.t >= 1) {
      if (climb.phase === 0) {
        // Transition to phase 1 (up and over)
        climb.phase = 1;
        climb.t = 0;
      } else {
        // Climb complete — place player on ship and set onboard
        const world = this.localToWorld(ship, climb.targetLocalX, climb.targetLocalY, climb.targetLocalZ);
        player.position.x = world.x;
        player.position.y = world.y;
        player.position.z = world.z;
        player.velocity.x = 0;
        player.velocity.y = 0;
        player.velocity.z = 0;

        state.climbState = null;
        player.flags &= ~PLR_FLAG.CLIMBING;

        // Set onboard state
        state.shipEntityId = ship.id;
        state.isOnboard = true;
        state.isPiloting = false;
        state.ownedShipId = ship.id;
        state.prevShipPosX = ship.position.x;
        state.prevShipPosY = ship.position.y;
        state.prevShipPosZ = ship.position.z;
        state.prevShipHeading = heading;
        state.prevShipPitch = ship.data[SHIP_DATA.PITCH] ?? 0;
        state.prevShipRoll = ship.data[SHIP_DATA.ROLL] ?? 0;
        state.hasPrevLocal = false;
        player.flags |= PLR_FLAG.ONBOARD;
        player.flags &= ~PLR_FLAG.PILOTING;
        return;
      }
    }

    // Compute current position via lerp in ship-local space
    let localX: number, localY: number, localZ: number;
    const t = Math.min(1, climb.t);

    if (climb.phase === 0) {
      // Phase 0: lerp from start to edge (mostly horizontal, Y stays at start)
      localX = climb.startLocalX + (climb.edgeLocalX - climb.startLocalX) * t;
      localY = climb.startLocalY + (climb.edgeLocalY - climb.startLocalY) * t;
      localZ = climb.startLocalZ + (climb.edgeLocalZ - climb.startLocalZ) * t;
    } else {
      // Phase 1: lerp from edge to target with arc on Y (up and over)
      localX = climb.edgeLocalX + (climb.targetLocalX - climb.edgeLocalX) * t;
      localZ = climb.edgeLocalZ + (climb.targetLocalZ - climb.edgeLocalZ) * t;
      // Y follows an arc: linear lerp + sine bump
      const linearY = climb.edgeLocalY + (climb.targetLocalY - climb.edgeLocalY) * t;
      localY = linearY + Math.sin(Math.PI * t) * CLIMB_ARC_HEIGHT;
    }

    // Transform to world space using full rotation (heading + pitch + roll)
    const world = this.localToWorld(ship, localX, localY, localZ);
    player.position.x = world.x;
    player.position.y = world.y;
    player.position.z = world.z;
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
  }

  // --- Auto Boarding ---

  private tryAutoBoard(
    player: SimPlayer,
    state: PlayerShipState,
    entities: SimEntity[],
    entityCount: number,
    boatCellSystem: BoatCellSystem,
  ): boolean {
    if (state.boardingCooldown > 0) return false; // recently disembarked — give player time to move away
    let bestShip: SimEntity | null = null;
    let bestDist = Infinity;

    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.Ship) continue;

      // Transform player position to ship-local space
      const heading = ent.data[SHIP_DATA.HEADING] ?? 0;
      const dx = player.position.x - ent.position.x;
      const dz = player.position.z - ent.position.z;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const localX = dx * cos - dz * sin;
      const localZ = dx * sin + dz * cos;

      // Check if player is over ship hull
      if (!this.isOverShip(ent.id, localX, localZ, boatCellSystem)) continue;

      // Check if player is at or above deck level (within tolerance for falling onto ship)
      const deckY = ent.position.y + 1.0;
      if (player.position.y < deckY - 2.0) continue; // too far below (swimming under ship)

      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestShip = ent;
      }
    }

    if (bestShip) {
      state.shipEntityId = bestShip.id;
      state.isOnboard = true;
      state.isPiloting = false;
      state.ownedShipId = bestShip.id;
      state.prevShipPosX = bestShip.position.x;
      state.prevShipPosY = bestShip.position.y;
      state.prevShipPosZ = bestShip.position.z;
      state.prevShipHeading = bestShip.data[SHIP_DATA.HEADING] ?? 0;
      state.prevShipPitch = bestShip.data[SHIP_DATA.PITCH] ?? 0;
      state.prevShipRoll = bestShip.data[SHIP_DATA.ROLL] ?? 0;
      state.hasPrevLocal = false; // reset clamp — no previous local position yet
      player.flags |= PLR_FLAG.ONBOARD;
      player.flags &= ~PLR_FLAG.PILOTING;
      return true;
    }
    return false;
  }

  // Distance from player to helm position on the ship
  private distToHelm(player: SimPlayer, ship: SimEntity): number {
    const heading = ship.data[SHIP_DATA.HEADING] ?? 0;
    // Helm is at local offset, rotated by ship heading
    const helmX = ship.position.x + Math.sin(heading) * HELM_LOCAL_OFFSET.z + Math.cos(heading) * HELM_LOCAL_OFFSET.x;
    const helmZ = ship.position.z + Math.cos(heading) * HELM_LOCAL_OFFSET.z - Math.sin(heading) * HELM_LOCAL_OFFSET.x;
    const dx = player.position.x - helmX;
    const dz = player.position.z - helmZ;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // --- Auto Disembark (no teleport — just clears state) ---

  private autoDisembark(
    player: SimPlayer,
    state: PlayerShipState,
  ): void {
    state.shipEntityId = 0;
    state.isOnboard = false;
    state.isPiloting = false;
    state.repairActive = false;
    state.boardingCooldown = 0.5; // prevent immediate re-boarding after walking off
    player.flags &= ~PLR_FLAG.PILOTING;
    player.flags &= ~PLR_FLAG.ONBOARD;
  }

  // --- World-to-ship-local transform ---

  private worldToLocal(player: SimPlayer, ship: SimEntity): { localX: number; localZ: number } {
    const heading = ship.data[SHIP_DATA.HEADING] ?? 0;
    const dx = player.position.x - ship.position.x;
    const dz = player.position.z - ship.position.z;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    return {
      localX: dx * cos - dz * sin,
      localZ: dx * sin + dz * cos,
    };
  }

  // Full 3D local-to-world transform using heading (yaw) + pitch + roll.
  // Rotation order matches the buoyancy system: pitch (around X) → roll (around Z) → yaw (around Y).
  localToWorld(
    ship: SimEntity,
    localX: number, localY: number, localZ: number,
  ): { x: number; y: number; z: number } {
    return this.localToWorldRot(
      ship.position.x, ship.position.y, ship.position.z,
      ship.data[SHIP_DATA.HEADING] ?? 0,
      ship.data[SHIP_DATA.PITCH] ?? 0,
      ship.data[SHIP_DATA.ROLL] ?? 0,
      localX, localY, localZ,
    );
  }

  localToWorldRot(
    posX: number, posY: number, posZ: number,
    heading: number, pitch: number, roll: number,
    localX: number, localY: number, localZ: number,
  ): { x: number; y: number; z: number } {
    const cosH = Math.cos(heading), sinH = Math.sin(heading);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const cosR = Math.cos(roll), sinR = Math.sin(roll);

    // Pitch (around X): y' = y*cosP - z*sinP, z' = y*sinP + z*cosP
    const pY = localY * cosP - localZ * sinP;
    const pZ = localY * sinP + localZ * cosP;
    // Roll (around Z): y' = x*sinR + y*cosR, x' = x*cosR - y*sinR
    const rY = localX * sinR + pY * cosR;
    const rX = localX * cosR - pY * sinR;
    // Yaw (around Y): x' = x*cosH + z*sinH, z' = -x*sinH + z*cosH
    return {
      x: posX + rX * cosH + pZ * sinH,
      y: posY + rY,
      z: posZ - rX * sinH + pZ * cosH,
    };
  }

  // Full 3D world-to-local transform (inverse of localToWorld).
  worldToLocalRot(
    posX: number, posY: number, posZ: number,
    heading: number, pitch: number, roll: number,
    worldX: number, worldY: number, worldZ: number,
  ): { x: number; y: number; z: number } {
    const cosH = Math.cos(heading), sinH = Math.sin(heading);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const cosR = Math.cos(roll), sinR = Math.sin(roll);

    // Inverse yaw: localX = dx*cosH - dz*sinH, localZ = dx*sinH + dz*cosH
    const dx = worldX - posX;
    const dy = worldY - posY;
    const dz = worldZ - posZ;
    const yx = dx * cosH - dz * sinH;
    const yz = dx * sinH + dz * cosH;
    const yy = dy;
    // Inverse roll: x = x'*cosR + y'*sinR, y = -x'*sinR + y'*cosR
    const rx = yx * cosR + yy * sinR;
    const ry = -yx * sinR + yy * cosR;
    // Inverse pitch: y = y'*cosP + z'*sinP, z = -y'*sinP + z'*cosP
    return {
      x: rx,
      y: ry * cosP + yz * sinP,
      z: -ry * sinP + yz * cosP,
    };
  }

  // --- Disembarking ---

  private disembark(
    player: SimPlayer,
    state: PlayerShipState,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    const ship = this.findEntityById(entities, entityCount, state.shipEntityId);
    if (ship) {
      // Place player beside the ship at water level (stern / local +Z)
      const heading = ship.data[SHIP_DATA.HEADING] ?? 0;
      const offsetX = Math.sin(heading) * SHIP_DISEMBARK_OFFSET;
      const offsetZ = Math.cos(heading) * SHIP_DISEMBARK_OFFSET;
      player.position.x = ship.position.x + offsetX;
      player.position.y = ship.position.y + 1;
      player.position.z = ship.position.z + offsetZ;

      // Reset ship throttle
      ship.data[SHIP_DATA.THROTTLE] = 0;
      ship.data[SHIP_DATA.STEERING] = 0;
    }

    state.shipEntityId = 0;
    state.isOnboard = false;
    state.isPiloting = false;
    state.repairActive = false;
    player.flags &= ~PLR_FLAG.PILOTING;
    player.flags &= ~PLR_FLAG.ONBOARD;
  }

  // --- Ship Control ---

  private controlShip(
    dt: number,
    input: InputBufferReader,
    playerIdx: number,
    player: SimPlayer,
    ship: SimEntity,
    state: PlayerShipState,
  ): void {
    // Read throttle input: W = forward, S = reverse
    let throttleInput = 0;
    if (input.isKeyDown(playerIdx, KEY.W)) throttleInput += 1;
    if (input.isKeyDown(playerIdx, KEY.S)) throttleInput -= 1;

    // Read steering input: A = port (left), D = starboard (right)
    let steeringInput = 0;
    if (input.isKeyDown(playerIdx, KEY.A)) steeringInput -= 1;
    if (input.isKeyDown(playerIdx, KEY.D)) steeringInput += 1;

    // Smoothly adjust throttle toward target
    const currentThrottle = ship.data[SHIP_DATA.THROTTLE] ?? 0;
    const targetThrottle = throttleInput;
    const throttleDiff = targetThrottle - currentThrottle;
    const maxChange = SHIP_ACCEL_RATE * dt;
    const newThrottle = currentThrottle + Math.max(-maxChange, Math.min(maxChange, throttleDiff));
    ship.data[SHIP_DATA.THROTTLE] = newThrottle;

    // Steering is more responsive
    ship.data[SHIP_DATA.STEERING] = steeringInput;

    // Get current heading
    let heading = ship.data[SHIP_DATA.HEADING] ?? 0;

    // Debug speed modifier: Shift=3x, Ctrl=10x, Alt=20x
    let speedMultiplier = 1;
    if (input.isKeyDown(playerIdx, KEY.ALT)) speedMultiplier = 20;
    else if (input.isKeyDown(playerIdx, KEY.CTRL)) speedMultiplier = 10;
    else if (input.isKeyDown(playerIdx, KEY.SHIFT)) speedMultiplier = 3;

    // --- Steering via angularVelocity.y (damped yaw) ---
    // Turning effectiveness scales with speed
    const fwdSpeed = Math.abs(ship.data[SHIP_DATA.SPEED] ?? 0);
    const speedFactor = Math.min(1, fwdSpeed / SHIP_BASE_SPEED) * SHIP_TURN_SPEED_FACTOR + 0.3;
    const targetYawRate = -steeringInput * SHIP_TURN_RATE * speedFactor;
    // Smoothly approach target yaw rate
    const yawRateDiff = targetYawRate - ship.angularVelocity.y;
    ship.angularVelocity.y += Math.max(-SHIP_TURN_RATE * dt, Math.min(SHIP_TURN_RATE * dt, yawRateDiff));

    // Apply angular drag to yaw
    ship.angularVelocity.y *= Math.max(0, 1 - SHIP_ANGULAR_DRAG * dt);

    // Cap yaw rate from all sources (steering + collision)
    if (ship.angularVelocity.y > SHIP_YAW_MAX) ship.angularVelocity.y = SHIP_YAW_MAX;
    if (ship.angularVelocity.y < -SHIP_YAW_MAX) ship.angularVelocity.y = -SHIP_YAW_MAX;

    // Integrate heading from angular velocity
    heading += ship.angularVelocity.y * dt;

    // Normalize heading to [-PI, PI] (safe for Infinity/NaN)
    ship.data[SHIP_DATA.HEADING] = Number.isFinite(heading)
      ? Math.atan2(Math.sin(heading), Math.cos(heading))
      : 0;

    // --- Propulsion: apply throttle as acceleration along bow direction ---
    // Bow faces -Z in local space, so forward = (-sin(heading), 0, -cos(heading))
    const fwdX = -Math.sin(heading);
    const fwdZ = -Math.cos(heading);
    const maxSpeed = SHIP_MAX_SPEED * speedMultiplier;
    const targetSpeed = newThrottle * maxSpeed;
    const currentFwdSpeed = ship.velocity.x * fwdX + ship.velocity.z * fwdZ;
    const speedDiff = targetSpeed - currentFwdSpeed;
    const accel = SHIP_ACCEL_RATE * maxSpeed * dt * 0.3;
    const accelClamped = Math.max(-accel, Math.min(accel, speedDiff));

    // Skip propulsion if anchored — anchor system will apply drag/spring forces
    const anchored = this.anchorSystem?.isAnchored(ship) ?? false;
    if (!anchored) {
      // Apply acceleration along forward axis (additive to existing velocity)
      ship.velocity.x += fwdX * accelClamped;
      ship.velocity.z += fwdZ * accelClamped;
    }

    // Apply water drag to velocity vector (always, stronger when no throttle)
    const dragAmount = (Math.abs(newThrottle) < 0.01 || anchored) ? SHIP_DRAG : SHIP_DRAG * 0.3;
    const dragFactor = Math.max(0, 1 - dragAmount * dt);
    ship.velocity.x *= dragFactor;
    ship.velocity.z *= dragFactor;

    // Derive scalar SPEED from velocity projected onto forward axis
    const finalFwdSpeed = ship.velocity.x * fwdX + ship.velocity.z * fwdZ;
    ship.data[SHIP_DATA.SPEED] = finalFwdSpeed;

    // Update hull integrity percentage
    ship.data[SHIP_DATA.HULL_INTEGRITY_PCT] = ship.health / ship.maxHealth;

    // Repair flag
    ship.data[SHIP_DATA.REPAIRING] = state.repairActive ? 1 : 0;

    // Anchor toggle: Q key (edge-triggered, only while piloting)
    const qPressed = input.isKeyDown(playerIdx, KEY.Q);
    if (qPressed && !state.prevQ && this.anchorSystem) {
      if (this.anchorSystem.isAnchored(ship)) {
        this.anchorSystem.raiseAnchor(ship);
      } else {
        this.anchorSystem.dropAnchor(ship);
      }
    }
    state.prevQ = qPressed;

    // Note: do NOT set player.heading here — let the player look around freely with mouse.
    // The camera follows the player's heading, not the ship's heading.
  }

  // Compose ship quaternion from heading (yaw) + pitch + roll
  // Called every tick for ALL ships after buoyancy updates pitch/roll
  composeShipQuaternion(ship: SimEntity): void {
    const heading = ship.data[SHIP_DATA.HEADING] ?? 0;
    const pitch = ship.data[SHIP_DATA.PITCH] ?? 0;
    const roll = ship.data[SHIP_DATA.ROLL] ?? 0;

    const hy = heading / 2;
    const px = pitch / 2;
    const rz = roll / 2;
    const shy = Math.sin(hy), chy = Math.cos(hy);
    const spx = Math.sin(px), cpx = Math.cos(px);
    const srz = Math.sin(rz), crz = Math.cos(rz);

    const prx = spx * crz;
    const pry = -spx * srz;
    const prz = cpx * srz;
    const prw = cpx * crz;

    ship.rotation.x = chy * prx + shy * prz;
    ship.rotation.y = shy * prw + chy * pry;
    ship.rotation.z = chy * prz - shy * prx;
    ship.rotation.w = chy * prw - shy * pry;
  }

  // Update all ships: apply drag/heading integration for non-piloted ships,
  // compose quaternion for ALL ships, derive SPEED from velocity.
  // Called after buoyancy and collision, before player tracking.
  updateAllShips(
    dt: number,
    entities: SimEntity[],
    entityCount: number,
    pilotedShipIds: Set<number>,
  ): void {
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (!ent) continue;
      if (ent.type !== EntityType.Ship && ent.type !== EntityType.SmallCraft && ent.type !== EntityType.PirateShip) continue;

      const isPiloted = pilotedShipIds.has(ent.id);

      if (!isPiloted) {
        // Apply water drag to velocity
        const dragFactor = Math.max(0, 1 - SHIP_DRAG * dt);
        ent.velocity.x *= dragFactor;
        ent.velocity.z *= dragFactor;

        // Apply angular drag and integrate heading from angularVelocity.y
        ent.angularVelocity.y *= Math.max(0, 1 - SHIP_ANGULAR_DRAG * dt);
        if (Math.abs(ent.angularVelocity.y) > SHIP_YAW_MAX) {
          ent.angularVelocity.y = Math.sign(ent.angularVelocity.y) * SHIP_YAW_MAX;
        }

        let heading = (ent.data[SHIP_DATA.HEADING] ?? 0) + ent.angularVelocity.y * dt;
        ent.data[SHIP_DATA.HEADING] = Number.isFinite(heading)
          ? Math.atan2(Math.sin(heading), Math.cos(heading))
          : 0;

        // Derive SPEED from velocity projected onto forward axis
        const fwdX = -Math.sin(ent.data[SHIP_DATA.HEADING] ?? 0);
        const fwdZ = -Math.cos(ent.data[SHIP_DATA.HEADING] ?? 0);
        ent.data[SHIP_DATA.SPEED] = ent.velocity.x * fwdX + ent.velocity.z * fwdZ;
      }

      // Compose quaternion from heading + pitch + roll for ALL ships
      this.composeShipQuaternion(ent);
    }
  }

  // --- Player on Ship Update ---

  private updatePlayerOnShip(
    player: SimPlayer,
    ship: SimEntity,
    state: PlayerShipState,
    isPiloting: boolean,
    input: InputBufferReader,
    playerIdx: number,
    boatCellSystem: BoatCellSystem,
  ): void {
    const currHeading = ship.data[SHIP_DATA.HEADING] ?? 0;
    const currPitch = ship.data[SHIP_DATA.PITCH] ?? 0;
    const currRoll = ship.data[SHIP_DATA.ROLL] ?? 0;

    if (isPiloting) {
      // Lock player to helm position using full rotation (pitch/roll applied)
      const helmWorld = this.localToWorld(ship, HELM_LOCAL_OFFSET.x, 1.5, HELM_LOCAL_OFFSET.z);
      player.position.x = helmWorld.x;
      player.position.y = helmWorld.y;
      player.position.z = helmWorld.z;
    } else {
      // Convert player's world position to ship-local using PREVIOUS ship transform
      // (including previous pitch/roll)
      const prev = this.worldToLocalRot(
        state.prevShipPosX, state.prevShipPosY, state.prevShipPosZ,
        state.prevShipHeading, state.prevShipPitch, state.prevShipRoll,
        player.position.x, player.position.y, player.position.z,
      );
      let localX = prev.x;
      let localY = prev.y;
      let localZ = prev.z;

      // Clamp local XZ displacement to prevent tunneling through walls.
      // When the ship rolls/pitches quickly, the world→local transform can
      // produce large apparent local displacement (the player appears to slide
      // across the deck in local space). Without clamping, this can move the
      // player past walls in a single tick. We limit local XZ movement to
      // a safe maximum per tick. Y is not clamped (gravity/floor snap handles it).
      const MAX_LOCAL_DISPLACEMENT = 1.5; // meters per tick — limits tunneling through thin walls
      if (state.hasPrevLocal) {
        const dx = localX - state.prevLocalX;
        const dz = localZ - state.prevLocalZ;
        const dispSq = dx * dx + dz * dz;
        if (dispSq > MAX_LOCAL_DISPLACEMENT * MAX_LOCAL_DISPLACEMENT) {
          const scale = MAX_LOCAL_DISPLACEMENT / Math.sqrt(dispSq);
          localX = state.prevLocalX + dx * scale;
          localZ = state.prevLocalZ + dz * scale;
        }
      }

      // Resolve collision against boat cells on ALL layers.
      // Sub-step the movement to prevent tunneling through thin walls (0.3m)
      // when ship rotation produces large local displacement. The discrete
      // position-based collision check can miss walls if the player jumps past
      // them in a single step. By sub-stepping at < WALL_THICKNESS + PLAYER_RADIUS,
      // each intermediate position is checked and the player is pushed out of
      // any wall they overlap.
      const PLAYER_RADIUS = 0.5; // slightly wider than capsule radius for wall collision
      const SUB_STEP_MAX = 0.35; // meters per sub-step (< WALL_THICKNESS + PLAYER_RADIUS = 0.8)
      let collision: { x: number; z: number; floorY: number };

      if (state.hasPrevLocal) {
        const totalDx = localX - state.prevLocalX;
        const totalDz = localZ - state.prevLocalZ;
        const totalDy = localY - state.prevLocalY;
        // Use 3D distance for sub-step count — Y displacement from ship
        // pitch/roll can be much larger than XZ (player far from ship
        // center during a hard roll). If we only sub-step based on XZ,
        // each sub-step can skip past a wall's 1.0m vertical span.
        const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy + totalDz * totalDz);

        if (totalDist > SUB_STEP_MAX) {
          const numSteps = Math.min(Math.ceil(totalDist / SUB_STEP_MAX), 30);
          const stepDx = totalDx / numSteps;
          const stepDz = totalDz / numSteps;
          const stepDy = totalDy / numSteps;
          let stepX = state.prevLocalX;
          let stepZ = state.prevLocalZ;
          let stepY = state.prevLocalY;

          for (let s = 0; s < numSteps; s++) {
            stepX += stepDx;
            stepZ += stepDz;
            stepY += stepDy;
            const stepResult = this.resolvePlayerHull(
              ship.id, stepX, stepY, stepZ, PLAYER_RADIUS, PLAYER_HEIGHT, boatCellSystem,
            );
            stepX = stepResult.x;
            stepZ = stepResult.z;
            collision = stepResult;
          }
          localX = collision.x;
          localZ = collision.z;
        } else {
          collision = this.resolvePlayerHull(
            ship.id, localX, localY, localZ, PLAYER_RADIUS, PLAYER_HEIGHT, boatCellSystem,
          );
          localX = collision.x;
          localZ = collision.z;
        }
      } else {
        collision = this.resolvePlayerHull(
          ship.id, localX, localY, localZ, PLAYER_RADIUS, PLAYER_HEIGHT, boatCellSystem,
        );
        localX = collision.x;
        localZ = collision.z;
      }

      // Snap localY to floor BEFORE world transform so that pitch/roll
      // rotation correctly mixes Y with X and Z. Without this, the world
      // transform uses the pre-gravity localY, and the subsequent floor snap
      // only corrects Y — leaving X/Z wrong and the player visually detached
      // from the deck when the ship tilts.
      if (Number.isFinite(collision.floorY) && localY <= collision.floorY) {
        localY = collision.floorY;
        if (player.velocity.y < 0) player.velocity.y = 0;
      }

      // Transform back to world using CURRENT ship transform (including pitch/roll)
      const world = this.localToWorldRot(
        ship.position.x, ship.position.y, ship.position.z,
        currHeading, currPitch, currRoll,
        localX, localY, localZ,
      );
      player.position.x = world.x;
      player.position.y = world.y;
      player.position.z = world.z;

      // Rotate player heading with ship
      const headingDelta = currHeading - state.prevShipHeading;
      player.heading += headingDelta;

      // Floor level in world space — transform local floorY through full rotation
      const floorWorld = this.localToWorldRot(
        ship.position.x, ship.position.y, ship.position.z,
        currHeading, currPitch, currRoll,
        localX, collision.floorY, localZ,
      );
      const floorY = floorWorld.y;

      // Jump detection: SPACE pressed and on floor
      if (input.isKeyDown(playerIdx, KEY.SPACE) && player.position.y <= floorY + 0.05 && player.velocity.y <= 0.1) {
        player.velocity.y = PLAYER_JUMP_FORCE;
      }

      // Floor snap: if player is at or below floor, snap to floor surface
      if (player.position.y <= floorY) {
        player.position.y = floorY;
        if (player.velocity.y < 0) player.velocity.y = 0;
      }
    }

    // Store current ship state for next tick
    state.prevShipPosX = ship.position.x;
    state.prevShipPosY = ship.position.y;
    state.prevShipPosZ = ship.position.z;
    state.prevShipHeading = currHeading;
    state.prevShipPitch = currPitch;
    state.prevShipRoll = currRoll;

    // Store local position for next tick's displacement clamp
    if (!isPiloting) {
      const finalLocal = this.worldToLocalRot(
        ship.position.x, ship.position.y, ship.position.z,
        currHeading, currPitch, currRoll,
        player.position.x, player.position.y, player.position.z,
      );
      state.prevLocalX = finalLocal.x;
      state.prevLocalY = finalLocal.y;
      state.prevLocalZ = finalLocal.z;
      state.hasPrevLocal = true;
    } else {
      state.hasPrevLocal = false;
    }
  }

  // --- Build Mode ---

  private handleBuildMode(
    dt: number,
    input: InputBufferReader,
    playerIdx: number,
    player: SimPlayer,
    ship: SimEntity,
    state: PlayerShipState,
    boatCellSystem: BoatCellSystem,
  ): void {
    // Decrement build cooldown
    if (state.buildCooldown > 0) {
      state.buildCooldown -= dt;
    }

    // Read active hotbar slot
    const activeSlot = player.activeSlot;
    if (activeSlot < 0 || activeSlot >= HOTBAR_TOOLS.length) {
      boatCellSystem.clearPreview();
      return;
    }
    const tool = HOTBAR_TOOLS[activeSlot];

    // Gun and Shovel are handled by ToolSystem, not build mode
    if (tool.action === "gun" || tool.action === "shovel") {
      boatCellSystem.clearPreview();
      return;
    }

    // Player eye position
    const eyeX = player.position.x;
    const eyeY = player.position.y + PLAYER_EYE_HEIGHT;
    const eyeZ = player.position.z;

    // Look direction from heading + pitch
    const heading = player.heading;
    const pitch = player.pitch ?? 0;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const dirX = Math.sin(heading) * cp;
    const dirY = sp; // pitch positive = looking up
    const dirZ = -Math.cos(heading) * cp;

    const shipHeading = ship.data[SHIP_DATA.HEADING] ?? 0;
    const bufferSlot = boatCellSystem.getBufferSlot(ship.id);
    if (bufferSlot < 0) {
      boatCellSystem.clearPreview();
      return;
    }

    // Transform eye position into ship-local space for raycasting
    const dx = eyeX - ship.position.x;
    const dz = eyeZ - ship.position.z;
    const cos = Math.cos(shipHeading);
    const sin = Math.sin(shipHeading);
    const localEyeX = dx * cos - dz * sin;
    const localEyeZ = dx * sin + dz * cos;
    const localEyeY = eyeY - ship.position.y;

    // Transform direction into ship-local space (rotate by heading)
    const localDirX = dirX * cos - dirZ * sin;
    const localDirZ = dirX * sin + dirZ * cos;
    const localDirY = dirY;

    // Try 3D raycast against existing cells first
    const rayHit = boatCellSystem.raycastCells(
      ship.id,
      localEyeX, localEyeY, localEyeZ,
      localDirX, localDirY, localDirZ,
      50,
    );

    let gridX: number, gridY: number, gridZ: number;

    if (rayHit) {
      // Hit an existing cell — place adjacent to the hit face
      gridX = rayHit.gridX;
      gridY = rayHit.gridY;
      gridZ = rayHit.gridZ;
    } else {
      // No cell hit — fall back to deck plane intersection at the player's current layer
      // Use feet position (eye - PLAYER_EYE_HEIGHT) so the layer matches where the player stands
      const feetY = localEyeY - PLAYER_EYE_HEIGHT;
      const deckY = Math.round(feetY / BOAT_LAYER_HEIGHT) * BOAT_LAYER_HEIGHT;
      const dy = deckY - localEyeY;
      if (Math.abs(localDirY) < 0.001 || (dy > 0 && localDirY < 0) || (dy < 0 && localDirY > 0)) {
        boatCellSystem.clearPreview();
        return;
      }
      const t = dy / localDirY;
      if (t < 0 || t > 50) {
        boatCellSystem.clearPreview();
        return;
      }
      const hitX = localEyeX + localDirX * t;
      const hitZ = localEyeZ + localDirZ * t;
      gridX = Math.round(hitX / BOAT_CELL_WORLD_SIZE);
      gridZ = Math.round(hitZ / BOAT_CELL_WORLD_SIZE);
      gridY = Math.round(deckY / BOAT_LAYER_HEIGHT);
    }

    // For the Builder tool, read the selected cell type and rotation from the input buffer
    let buildCellType: number = BoatCellType.HULL;
    let buildTemplate: CellTemplateEntry[] | undefined;
    let buildRotation = 0;
    if (tool.action === "build") {
      const builderIdx = input.getBuilderCellType(playerIdx);
      if (builderIdx >= 0 && builderIdx < BUILDER_CELL_OPTIONS.length) {
        const opt = BUILDER_CELL_OPTIONS[builderIdx];
        buildCellType = opt.cellType ?? BoatCellType.HULL;
        buildTemplate = opt.template;
      }
      buildRotation = input.getBuilderRotation(playerIdx) % 4;
    }

    // For templates, apply rotation by rotating offsets and cell rotations
    let effectiveTemplate = buildTemplate;
    if (buildTemplate && buildRotation > 0) {
      effectiveTemplate = rotateTemplate(buildTemplate, buildRotation);
    }

    // Determine preview cell type based on tool
    const previewCellType = tool.action === "delete" ? 255 : (effectiveTemplate?.[0]?.type ?? buildCellType);
    const previewRotation = tool.action === "delete" ? 0 : (effectiveTemplate?.[0]?.rotation ?? buildRotation);

    // Write preview every tick so renderer can show holo (only if valid placement)
    const isValid = boatCellSystem.canPlaceCell(ship.id, tool.action, gridX, gridY, gridZ, effectiveTemplate, buildCellType, buildRotation);
    boatCellSystem.setPreview(bufferSlot, gridX, gridY, gridZ, previewCellType, isValid, previewRotation);

    // Edge-detect mouse left click
    const mouseLeft = input.isMouseDown(playerIdx, 0);
    const clicked = mouseLeft && !state.prevMouseLeft;
    state.prevMouseLeft = mouseLeft;

    if (!clicked || state.buildCooldown > 0) return;
    state.buildCooldown = 0.15; // 150ms cooldown between build actions

    switch (tool.action) {
      case "build": {
        if (effectiveTemplate) {
          boatCellSystem.addTemplate(ship.id, effectiveTemplate, gridX, gridY, gridZ);
        } else {
          const existing = boatCellSystem.getCellAt(ship.id, gridX, gridY, gridZ);
          if (!existing) {
            boatCellSystem.addCell(ship.id, buildCellType, buildRotation, gridX, gridY, gridZ);
          }
        }
        break;
      }
      case "delete":
        boatCellSystem.removeCell(ship.id, gridX, gridY, gridZ);
        break;
      case "rotate":
        boatCellSystem.rotateCell(ship.id, gridX, gridY, gridZ);
        break;
    }
  }

  // --- Repair ---

  private repairShip(ship: SimEntity, dt: number): void {
    if (ship.health >= ship.maxHealth) return;
    ship.health = Math.min(ship.maxHealth, ship.health + SHIP_REPAIR_RATE * dt);
  }

  // --- Helpers ---

  private findEntityById(entities: SimEntity[], count: number, id: number): SimEntity | null {
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (ent && ent.id === id) return ent;
    }
    return null;
  }

  // --- Public API ---

  // Get the ship entity a player is piloting
  getPilotedShipId(playerId: number): number {
    return this.playerShipState.get(playerId)?.shipEntityId ?? 0;
  }

  // Check if a player is currently piloting a ship
  isPiloting(playerId: number): boolean {
    const state = this.playerShipState.get(playerId);
    return state !== undefined && state.isPiloting;
  }

  // Check if a player is currently onboard a ship
  isOnboard(playerId: number): boolean {
    const state = this.playerShipState.get(playerId);
    return state !== undefined && state.isOnboard;
  }

  // Get the ship entity a player is on
  getOnboardShipId(playerId: number): number {
    return this.playerShipState.get(playerId)?.shipEntityId ?? 0;
  }

  // Get the ship entity ID a player owns
  getOwnedShipId(playerId: number): number {
    return this.playerShipState.get(playerId)?.ownedShipId ?? 0;
  }

  // Force a player to disembark (e.g., on ship destruction)
  forceDisembark(
    player: SimPlayer,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    const state = this.playerShipState.get(player.playerId);
    if (state && state.shipEntityId !== 0) {
      this.disembark(player, state, entities, entityCount);
    }
  }

  // Set a player's mothership (the ship they own)
  // This is tracked externally via the player's bedEntityId or a separate field
  setMothership(playerId: number, shipEntityId: number): void {
    let state = this.playerShipState.get(playerId);
    if (!state) {
      state = { shipEntityId: 0, boardingCooldown: 0, repairActive: false, buildCooldown: 0, prevMouseLeft: false, isOnboard: false, isPiloting: false, ownedShipId: shipEntityId, prevShipPosX: 0, prevShipPosY: 0, prevShipPosZ: 0, prevShipHeading: 0, prevShipPitch: 0, prevShipRoll: 0, prevLocalX: 0, prevLocalY: 0, prevLocalZ: 0, hasPrevLocal: false, climbState: null, prevSpace: false, prevQ: false };
      this.playerShipState.set(playerId, state);
    }
    state.ownedShipId = shipEntityId;
  }

  // Get repair status for a player
  isRepairing(playerId: number): boolean {
    return this.playerShipState.get(playerId)?.repairActive ?? false;
  }
}
