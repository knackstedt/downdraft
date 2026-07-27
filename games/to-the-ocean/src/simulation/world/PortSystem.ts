// ============================================================================
// Port System — manages port entity lifecycle, ship-to-port interaction,
// mooring, repairs, and market initialization. Runs in the sim worker thread.
// ============================================================================

import { SimEntity, SimPlayer } from "../Simulation";
import { EntityType, EntityFlags, PortDef, PortSize, PortService, SecurityLevel, BiomeType } from "../../shared/types";
import {
  PORT_INTERACTION_RANGE, PORT_DETECTION_RANGE, PORT_MOORING_SLOWDOWN,
  PORT_REPAIR_RATE, PORT_DATA, PORT_SERVICE_BITS, PORT_SCALE,
  SHIP_DATA, CHUNK_SIZE, getPortColliderDims,
} from "../../shared/constants";
import { PLR_FLAG } from "../../shared/sim-buffer";
import { BoatCellSystem } from "../boat/BoatCellSystem";
import { InputBufferReader, KEY } from "../../shared/input-buffer";

// Port climb parameters (mirrors boat climb constants)
const PORT_CLIMB_HEIGHT_THRESHOLD = 3.0;   // max height above player feet to climb (meters)
const PORT_CLIMB_HORIZONTAL_RANGE = 3.0;   // max horizontal distance to edge to start climb (meters)
const PORT_CLIMB_PHASE1_DURATION = 0.4;    // seconds: lerp to edge
const PORT_CLIMB_PHASE2_DURATION = 0.6;    // seconds: up and over
const PORT_CLIMB_ARC_HEIGHT = 0.5;         // extra arc height in phase 2 (meters)

interface PortClimbState {
  portEntityId: number;
  phase: number;           // 0 = lerp to edge, 1 = up and over
  t: number;               // 0..1 progress within current phase
  startX: number; startY: number; startZ: number;
  edgeX: number;  edgeY: number;  edgeZ: number;
  targetX: number; targetY: number; targetZ: number;
}

interface ActivePort {
  portDef: PortDef;
  entityId: number;       // sim entity ID
  entityIdx: number;      // sim entity array index
  mooredShipId: number;   // entity ID of currently moored ship (0 = none)
  dockProgress: number;   // 0-1, how close to fully docked
}

export class PortSystem {
  private activePorts = new Map<string, ActivePort>();  // portDef.id -> ActivePort
  private knownPortIds = new Set<string>();              // ports we've already spawned
  private playerNearbyPort = new Map<number, string | null>(); // playerId -> portId or null
  private boatCellSystem: BoatCellSystem | null = null;
  private portClimbStates = new Map<number, PortClimbState>(); // playerId -> climb state
  private prevSpace = new Map<number, boolean>(); // playerId -> prev SPACE state

  // Callbacks set by Simulation
  onSpawnPortEntity: ((port: PortDef, scale: number, data: Float32Array, flags: number) => number) | null = null;
  onRemovePortEntity: ((entityId: number) => void) | null = null;
  onInitPortMarket: ((portId: string, size: PortSize) => void) | null = null;

  setBoatCellSystem(bcs: BoatCellSystem): void {
    this.boatCellSystem = bcs;
  }

  // --- Chunk-driven port entity management ---

  updatePorts(nearbyPorts: PortDef[]): void {
    const seenIds = new Set<string>();

    for (let i = 0; i < nearbyPorts.length; i++) {
      const port = nearbyPorts[i];
      seenIds.add(port.id);

      if (!this.knownPortIds.has(port.id)) {
        this.spawnPortEntity(port);
        this.knownPortIds.add(port.id);
      }
    }

    // Despawn ports that are no longer nearby
    const toRemove: string[] = [];
    for (const [portId, active] of this.activePorts) {
      if (!seenIds.has(portId)) {
        toRemove.push(portId);
      }
    }
    for (let i = 0; i < toRemove.length; i++) {
      this.despawnPort(toRemove[i]);
    }
  }

  private spawnPortEntity(port: PortDef): void {
    const scale = port.size === PortSize.Large ? PORT_SCALE.Large :
                  port.size === PortSize.Medium ? PORT_SCALE.Medium :
                  PORT_SCALE.Small;

    // Build service bitmask
    let serviceBits = 0;
    for (let i = 0; i < port.services.length; i++) {
      const svc = port.services[i];
      switch (svc) {
        case PortService.Trading: serviceBits |= PORT_SERVICE_BITS.Trading; break;
        case PortService.Shipyard: serviceBits |= PORT_SERVICE_BITS.Shipyard; break;
        case PortService.HullModification: serviceBits |= PORT_SERVICE_BITS.HullModification; break;
        case PortService.Fishing: serviceBits |= PORT_SERVICE_BITS.Fishing; break;
        case PortService.Supplies: serviceBits |= PORT_SERVICE_BITS.Supplies; break;
        case PortService.Inn: serviceBits |= PORT_SERVICE_BITS.Inn; break;
        case PortService.Licenses: serviceBits |= PORT_SERVICE_BITS.Licenses; break;
        case PortService.Storage: serviceBits |= PORT_SERVICE_BITS.Storage; break;
      }
    }

    const data = new Float32Array(6);
    data[PORT_DATA.SIZE] = port.size;
    data[PORT_DATA.SERVICES] = serviceBits;
    data[PORT_DATA.SECURITY] = port.securityLevel;
    data[PORT_DATA.MOORED_SHIP_ID] = 0;
    data[PORT_DATA.DOCK_PROGRESS] = 0;
    data[PORT_DATA.BIOME] = port.biome;

    const flags = EntityFlags.Static;

    let entityId = 0;
    if (this.onSpawnPortEntity) {
      entityId = this.onSpawnPortEntity(port, scale, data, flags);
    }

    this.activePorts.set(port.id, {
      portDef: port,
      entityId,
      entityIdx: -1, // will be resolved during tick
      mooredShipId: 0,
      dockProgress: 0,
    });

    // Initialize market for this port
    if (this.onInitPortMarket) {
      this.onInitPortMarket(port.id, port.size);
    }
  }

  private despawnPort(portId: string): void {
    const active = this.activePorts.get(portId);
    if (!active) return;

    if (this.onRemovePortEntity) {
      this.onRemovePortEntity(active.entityId);
    }

    this.activePorts.delete(portId);
    this.knownPortIds.delete(portId);

    // Clear any players who were near this port
    for (const [pid, nearbyId] of this.playerNearbyPort) {
      if (nearbyId === portId) {
        this.playerNearbyPort.set(pid, null);
      }
    }
  }

  // --- Tick: ship-to-port interaction ---

  tick(
    dt: number,
    input: InputBufferReader,
    entities: SimEntity[],
    entityCount: number,
    players: SimPlayer[],
    playerCount: number,
    pilotedShipIds: Set<number>,
  ): void {
    // Resolve entity indices for active ports
    for (const [portId, active] of this.activePorts) {
      active.entityIdx = -1;
      for (let i = 0; i < entityCount; i++) {
        const ent = entities[i];
        if (!ent) continue;
        if (ent.id === active.entityId) {
          active.entityIdx = i;
          break;
        }
      }
    }

    // Check each port against all ships
    for (const [portId, active] of this.activePorts) {
      const port = active.portDef;
      const portEnt = active.entityIdx >= 0 ? entities[active.entityIdx] : null;
      if (!portEnt) continue;

      const portSize = portEnt.data[PORT_DATA.SIZE] ?? 0;
      const cd = getPortColliderDims(portSize, portEnt.scale);
      if (!cd) continue;

      let nearestShipId = 0;
      let nearestDist = Infinity;
      let nearestShipIdx = -1;

      for (let i = 0; i < entityCount; i++) {
        const ent = entities[i];
        if (!ent) continue;
        if (ent.type !== EntityType.Ship) continue;

        const dx = ent.position.x - port.position.x;
        const dz = ent.position.z - port.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < nearestDist) {
          nearestDist = dist;
          nearestShipId = ent.id;
          nearestShipIdx = i;
        }
      }

      // --- Docking / mooring logic ---
      // Only moor ships that are NOT being actively piloted
      const isPiloted = nearestShipId !== 0 && pilotedShipIds.has(nearestShipId);

      if (nearestDist < PORT_INTERACTION_RANGE && nearestShipId !== 0) {
        // Progress docking
        active.dockProgress = Math.min(1, active.dockProgress + dt * 0.5);

        if (active.dockProgress >= 1 && active.mooredShipId === 0 && !isPiloted) {
          // Fully docked — moor the ship (only if not piloted)
          active.mooredShipId = nearestShipId;
          portEnt.data[PORT_DATA.MOORED_SHIP_ID] = nearestShipId;
        }
      } else if (nearestDist > PORT_INTERACTION_RANGE * 1.5) {
        // Ship moved away — unmoor
        if (active.mooredShipId !== 0) {
          active.mooredShipId = 0;
          portEnt.data[PORT_DATA.MOORED_SHIP_ID] = 0;
        }
        active.dockProgress = Math.max(0, active.dockProgress - dt * 0.5);
      }

      portEnt.data[PORT_DATA.DOCK_PROGRESS] = active.dockProgress;

      // Apply mooring effects to the ship (only for non-piloted moored ships)
      if (active.mooredShipId !== 0) {
        for (let i = 0; i < entityCount; i++) {
          const ent = entities[i];
          if (!ent || ent.id !== active.mooredShipId) continue;
          if (ent.type !== EntityType.Ship) continue;

          // Slow down ship velocity (mooring)
          ent.velocity.x *= PORT_MOORING_SLOWDOWN;
          ent.velocity.z *= PORT_MOORING_SLOWDOWN;

          // Repair ship hull
          const hullPct = ent.data[SHIP_DATA.HULL_INTEGRITY_PCT];
          if (hullPct < 1) {
            ent.data[SHIP_DATA.HULL_INTEGRITY_PCT] = Math.min(1, hullPct + PORT_REPAIR_RATE * dt / ent.maxHealth);
            ent.health = Math.min(ent.maxHealth, ent.health + PORT_REPAIR_RATE * dt);
          }

          // Zero throttle when moored
          ent.data[SHIP_DATA.THROTTLE] = 0;
          ent.data[SHIP_DATA.STEERING] = 0;
          break;
        }
      }

      // Apply repair benefit to piloted ships in range (without mooring them)
      if (isPiloted && nearestDist < PORT_INTERACTION_RANGE && nearestShipId !== 0) {
        for (let i = 0; i < entityCount; i++) {
          const ent = entities[i];
          if (!ent || ent.id !== nearestShipId) continue;
          if (ent.type !== EntityType.Ship) continue;

          const hullPct = ent.data[SHIP_DATA.HULL_INTEGRITY_PCT];
          if (hullPct < 1) {
            ent.data[SHIP_DATA.HULL_INTEGRITY_PCT] = Math.min(1, hullPct + PORT_REPAIR_RATE * dt / ent.maxHealth);
            ent.health = Math.min(ent.maxHealth, ent.health + PORT_REPAIR_RATE * dt);
          }
          break;
        }
      }
    }

    // Update player nearby port status
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;

      let nearbyPortId: string | null = null;
      let nearestDist = PORT_DETECTION_RANGE;

      for (const [portId, active] of this.activePorts) {
        const dx = p.position.x - active.portDef.position.x;
        const dz = p.position.z - active.portDef.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearbyPortId = portId;
        }
      }

      this.playerNearbyPort.set(p.playerId, nearbyPortId);
    }

    // --- Player climb-onto-port logic ---
    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p?.active) continue;
      if (p.flags & PLR_FLAG.DEAD) continue;
      if (p.flags & PLR_FLAG.NOCLIP) continue;
      if (p.flags & PLR_FLAG.ONBOARD) continue;

      // Update active climb
      if (p.flags & PLR_FLAG.CLIMBING) {
        this.updatePortClimb(p, dt, entities, entityCount);
        this.prevSpace.set(p.playerId, input.isKeyDown(i, KEY.SPACE));
        continue;
      }

      // Try starting a climb while SPACE is held (continuous — player floats up next to port
      // and climb triggers automatically when in range, since edge-trigger would never fire
      // while SPACE is being held to float)
      const spacePressed = input.isKeyDown(i, KEY.SPACE);
      if (spacePressed) {
        this.tryStartPortClimb(p, entities, entityCount);
      }
      this.prevSpace.set(p.playerId, spacePressed);
    }
  }

  // --- Port climb: try to start a climb onto a nearby port dock/pier edge ---

  private tryStartPortClimb(
    player: SimPlayer,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    for (let j = 0; j < entityCount; j++) {
      const ent = entities[j];
      if (!ent || ent.type !== EntityType.Port) continue;

      const portSize = ent.data[PORT_DATA.SIZE] ?? 0;
      const cd = getPortColliderDims(portSize, ent.scale);
      if (!cd) continue;

      const px = player.position.x - ent.position.x;
      const pz = player.position.z - ent.position.z;
      const py = player.position.y - ent.position.y;

      // Check dock and pier rectangles
      const rects = [
        { halfW: cd.dock.halfW, halfD: cd.dock.halfD, topY: cd.dock.centerY + cd.dock.halfH, cx: 0, cz: 0 },
        { halfW: cd.pier.halfW, halfD: cd.pier.halfL, topY: cd.pier.centerY + cd.pier.halfH, cx: 0, cz: cd.pier.centerZ },
      ];

      for (let r = 0; r < rects.length; r++) {
        const rect = rects[r];
        const localX = px - rect.cx;
        const localZ = pz - rect.cz;

        // Dock/pier top must be above player feet but within climb threshold
        if (rect.topY <= py + 0.1) continue;
        if (rect.topY - py > PORT_CLIMB_HEIGHT_THRESHOLD) continue;

        // Find the closest point on the rectangle's edge to the player
        const closestEdgeX = Math.max(-rect.halfW, Math.min(rect.halfW, localX));
        const closestEdgeZ = Math.max(-rect.halfD, Math.min(rect.halfD, localZ));

        // Distance from player to the closest edge point
        const dx = localX - closestEdgeX;
        const dz = localZ - closestEdgeZ;
        const hDistSq = dx * dx + dz * dz;

        if (hDistSq > PORT_CLIMB_HORIZONTAL_RANGE * PORT_CLIMB_HORIZONTAL_RANGE) continue;

        // Edge point in world space
        const edgeWorldX = ent.position.x + rect.cx + closestEdgeX;
        const edgeWorldZ = ent.position.z + rect.cz + closestEdgeZ;
        const edgeWorldY = ent.position.y + rect.topY;

        // Target: just inside the edge (1.5m inward), not the rect center
        // For large ports the dock can be 50m wide — center would teleport the player far
        const inwardDx = closestEdgeX - localX;
        const inwardDz = closestEdgeZ - localZ;
        const inwardLen = Math.sqrt(inwardDx * inwardDx + inwardDz * inwardDz);
        const climbOffset = 1.5;
        let targetLocalX: number, targetLocalZ: number;
        if (inwardLen > 0.001) {
          targetLocalX = closestEdgeX + (inwardDx / inwardLen) * climbOffset;
          targetLocalZ = closestEdgeZ + (inwardDz / inwardLen) * climbOffset;
        } else {
          targetLocalX = closestEdgeX * 0.9;
          targetLocalZ = closestEdgeZ * 0.9;
        }
        const targetX = ent.position.x + rect.cx + targetLocalX;
        const targetZ = ent.position.z + rect.cz + targetLocalZ;
        const targetY = ent.position.y + rect.topY;

        // Start climb animation
        this.portClimbStates.set(player.playerId, {
          portEntityId: ent.id,
          phase: 0,
          t: 0,
          startX: player.position.x, startY: player.position.y, startZ: player.position.z,
          edgeX: edgeWorldX, edgeY: edgeWorldY, edgeZ: edgeWorldZ,
          targetX, targetY, targetZ,
        });
        player.flags |= PLR_FLAG.CLIMBING;
        player.velocity.x = 0;
        player.velocity.y = 0;
        player.velocity.z = 0;
        return;
      }
    }
  }

  // --- Port climb: update climb animation each tick ---

  private updatePortClimb(
    player: SimPlayer,
    dt: number,
    entities: SimEntity[],
    entityCount: number,
  ): void {
    const climb = this.portClimbStates.get(player.playerId);
    if (!climb) {
      player.flags &= ~PLR_FLAG.CLIMBING;
      return;
    }

    // Find the port entity
    let portEnt: SimEntity | null = null;
    for (let i = 0; i < entityCount; i++) {
      const ent = entities[i];
      if (ent && ent.id === climb.portEntityId) {
        portEnt = ent;
        break;
      }
    }
    if (!portEnt) {
      // Port despawned — cancel climb
      this.portClimbStates.delete(player.playerId);
      player.flags &= ~PLR_FLAG.CLIMBING;
      return;
    }

    // Advance progress
    const duration = climb.phase === 0 ? PORT_CLIMB_PHASE1_DURATION : PORT_CLIMB_PHASE2_DURATION;
    climb.t += dt / duration;

    if (climb.t >= 1) {
      if (climb.phase === 0) {
        climb.phase = 1;
        climb.t = 0;
      } else {
        // Climb complete — place player on port surface
        player.position.x = climb.targetX;
        player.position.y = climb.targetY;
        player.position.z = climb.targetZ;
        player.velocity.x = 0;
        player.velocity.y = 0;
        player.velocity.z = 0;

        this.portClimbStates.delete(player.playerId);
        player.flags &= ~PLR_FLAG.CLIMBING;
        return;
      }
    }

    // Compute current position via lerp in world space (ports don't move)
    const t = Math.min(1, climb.t);
    let x: number, y: number, z: number;

    if (climb.phase === 0) {
      // Phase 0: lerp from start to edge (mostly horizontal)
      x = climb.startX + (climb.edgeX - climb.startX) * t;
      y = climb.startY + (climb.edgeY - climb.startY) * t;
      z = climb.startZ + (climb.edgeZ - climb.startZ) * t;
    } else {
      // Phase 1: lerp from edge to target with arc on Y
      x = climb.edgeX + (climb.targetX - climb.edgeX) * t;
      z = climb.edgeZ + (climb.targetZ - climb.edgeZ) * t;
      const linearY = climb.edgeY + (climb.targetY - climb.edgeY) * t;
      y = linearY + Math.sin(Math.PI * t) * PORT_CLIMB_ARC_HEIGHT;
    }

    player.position.x = x;
    player.position.y = y;
    player.position.z = z;
    player.velocity.x = 0;
    player.velocity.y = 0;
    player.velocity.z = 0;
  }

  // --- Queries ---

  getNearbyPortForPlayer(playerId: number): PortDef | null {
    const portId = this.playerNearbyPort.get(playerId);
    if (!portId) return null;
    return this.activePorts.get(portId)?.portDef ?? null;
  }

  getMooredShipId(portId: string): number {
    return this.activePorts.get(portId)?.mooredShipId ?? 0;
  }

  getActivePorts(): PortDef[] {
    const result: PortDef[] = [];
    for (const active of this.activePorts.values()) {
      result.push(active.portDef);
    }
    return result;
  }

  getPortById(portId: string): PortDef | null {
    return this.activePorts.get(portId)?.portDef ?? null;
  }

  getPortEntityId(portId: string): number {
    return this.activePorts.get(portId)?.entityId ?? 0;
  }

  isShipMoored(shipEntityId: number): boolean {
    for (const active of this.activePorts.values()) {
      if (active.mooredShipId === shipEntityId) return true;
    }
    return false;
  }

  getPortForMooredShip(shipEntityId: number): PortDef | null {
    for (const active of this.activePorts.values()) {
      if (active.mooredShipId === shipEntityId) return active.portDef;
    }
    return null;
  }

  // Get port info for serialization / MCP queries
  getPortInfo(portId: string): {
    name: string;
    size: PortSize;
    theme: string;
    securityLevel: SecurityLevel;
    biome: BiomeType;
    services: PortService[];
    marketSpecialties: string[];
    position: { x: number; y: number; z: number };
    mooredShipId: number;
  } | null {
    const active = this.activePorts.get(portId);
    if (!active) return null;
    const p = active.portDef;
    return {
      name: p.name,
      size: p.size,
      theme: p.theme,
      securityLevel: p.securityLevel,
      biome: p.biome,
      services: p.services,
      marketSpecialties: p.marketSpecialties,
      position: p.position,
      mooredShipId: active.mooredShipId,
    };
  }

  shutdown(): void {
    this.activePorts.clear();
    this.knownPortIds.clear();
    this.playerNearbyPort.clear();
    this.portClimbStates.clear();
    this.prevSpace.clear();
  }
}
