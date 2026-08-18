// ============================================================================
// Game Debug Providers — game-specific implementations of plugin-devtools
// interfaces. Bridges SimBufferReader/BoatBufferReader to generic interfaces.
// ============================================================================

import {
  BOAT_CELL_WORLD_SIZE,
  BOAT_LAYER_HEIGHT,
  CHUNK_SIZE,
  CHUNKS_VISIBLE,
  getCellGeometry,
  hasSolidCollision,
  isWalkableSurface,
  PLAYER_EYE_HEIGHT,
} from "@shared/constants";
import { BoatBufferReader } from "@to-the-ocean/library-boats/boat-sab";
import { ENT, PLR, SimBufferReader } from "@downdraft/core";
import { CameraMode, EntityType, EntityTypeNames } from "@shared/types";
import type {
  IDebugOverlayData,
  ILabelEntry,
  ILabelProvider,
  IRaycastProvider,
  IRaycastResult,
  ISceneEntitySnapshot,
  ISceneSyncProvider,
} from "@downdraft/plugin-devtools";

const MAX_RENDER_DIST = 500;
const RAY_MAX_DIST = 60;

const LABEL_COLORS: Record<number, string> = {
  [EntityType.Player]: "#4ec9b0",
  [EntityType.Ship]: "#569cd6",
  [EntityType.SmallCraft]: "#569cd6",
  [EntityType.Fish]: "#dcdcaa",
  [EntityType.Shark]: "#f44747",
  [EntityType.Eel]: "#ce9178",
  [EntityType.Jellyfish]: "#c586c0",
  [EntityType.DevilShrimp]: "#f44747",
  [EntityType.Whale]: "#9cdcfe",
  [EntityType.Dolphin]: "#9cdcfe",
  [EntityType.Turtle]: "#b5cea8",
  [EntityType.Crustacean]: "#dcdcaa",
  [EntityType.Coral]: "#c586c0",
  [EntityType.Moose]: "#dcdcaa",
  [EntityType.Pirate]: "#f44747",
  [EntityType.PirateShip]: "#f44747",
  [EntityType.Island]: "#b5cea8",
  [EntityType.Port]: "#dcdcaa",
  [EntityType.Reef]: "#c586c0",
  [EntityType.Wreck]: "#ce9178",
  [EntityType.Pet]: "#dcdcaa",
  [EntityType.Livestock]: "#b5cea8",
  [EntityType.Plant]: "#b5cea8",
  [EntityType.Placeable]: "#dcdcaa",
  [EntityType.RainCollector]: "#dcdcaa",
  [EntityType.Treasure]: "#dcdcaa",
};

// --- IDebugOverlayData implementation ---

export class GameDebugOverlayData implements IDebugOverlayData {
  constructor(private simReader: SimBufferReader) {}

  getEntityCount(): number {
    return this.simReader.getEntityCount();
  }

  getEntityPosition(i: number): { x: number; y: number; z: number } | null {
    const slot = this.simReader.getEntitySlot(i);
    if (!slot) return null;
    return {
      x: slot.f32[ENT.POS_X],
      y: slot.f32[ENT.POS_Y],
      z: slot.f32[ENT.POS_Z],
    };
  }

  getEntityVelocity(i: number): { x: number; y: number; z: number } | null {
    const slot = this.simReader.getEntitySlot(i);
    if (!slot) return null;
    return {
      x: slot.f32[ENT.VEL_X],
      y: slot.f32[ENT.VEL_Y],
      z: slot.f32[ENT.VEL_Z],
    };
  }

  getPlayerPosition(): { x: number; z: number } | null {
    const slot = this.simReader.getPlayerSlot(0);
    if (!slot) return null;
    return { x: slot.f32[PLR.POS_X], z: slot.f32[PLR.POS_Z] };
  }

  getChunkGridConfig(): { chunkSize: number; chunksVisible: number } {
    return { chunkSize: CHUNK_SIZE, chunksVisible: CHUNKS_VISIBLE };
  }
}

// --- IRaycastProvider implementation ---

export class GameRaycastProvider implements IRaycastProvider {
  constructor(
    private simReader: SimBufferReader,
    private boatReader: BoatBufferReader | null,
  ) {}

  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): IRaycastResult | null {
    if (!this.simReader.isValid()) return null;

    const entityCount = this.simReader.getEntityCount();
    let bestT = maxDist;
    let bestEntityIdx = -1;
    let bestEntityId = 0;
    let bestEntityType = EntityType.Player;
    let bestHitX = 0, bestHitY = 0, bestHitZ = 0;
    let bestScale = 1;

    for (let i = 0; i < entityCount; i++) {
      const slot = this.simReader.getEntitySlot(i);
      if (!slot) continue;

      const entId = slot.u32[ENT.ID];
      if (entId === 0) continue;

      const type = slot.u32[ENT.TYPE] as EntityType;
      const ex = slot.f32[ENT.POS_X];
      const ey = slot.f32[ENT.POS_Y];
      const ez = slot.f32[ENT.POS_Z];
      const scale = slot.f32[ENT.SCALE];
      const rx = slot.f32[ENT.ROT_X];
      const ry = slot.f32[ENT.ROT_Y];
      const rz = slot.f32[ENT.ROT_Z];
      const rw = slot.f32[ENT.ROT_W];

      if (type === EntityType.Ship || type === EntityType.SmallCraft) {
        if (!this.boatReader || !this.boatReader.isValid()) continue;
        const boatCount = this.boatReader.getBoatCount();
        let boatSlot = -1;
        for (let bs = 0; bs < boatCount; bs++) {
          if (this.boatReader.getBoatEntityId(bs) === entId) {
            boatSlot = bs;
            break;
          }
        }
        if (boatSlot < 0) continue;

        const cells = this.boatReader.getBoatCells(boatSlot);
        for (let ci = 0; ci < cells.length; ci++) {
          const cell = cells[ci];
          if (!hasSolidCollision(cell.type) && !isWalkableSurface(cell.type)) continue;

          const geo = getCellGeometry(cell.type);
          const lx = cell.gridX * BOAT_CELL_WORLD_SIZE;
          const ly = cell.gridY * BOAT_LAYER_HEIGHT + geo.y0;
          const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE;
          const hx = (geo.sizeX * BOAT_CELL_WORLD_SIZE) * 0.5;
          const hz = (geo.sizeZ * BOAT_CELL_WORLD_SIZE) * 0.5;
          const hy = (geo.y1 - geo.y0) * 0.5;
          const cx = lx + hx;
          const cy = ly + hy;
          const cz = lz + hz;

          const tx = (1 - 2 * (ry * ry + rz * rz)) * cx + 2 * (rx * ry - rw * rz) * cz + 2 * (rx * rz + rw * ry) * cy;
          const ty = 2 * (rx * ry + rw * rz) * cx + (1 - 2 * (rx * rx + rz * rz)) * cy + 2 * (ry * rz - rw * rx) * cz;
          const tz = 2 * (rx * rz - rw * ry) * cx + 2 * (ry * rz + rw * rx) * cy + (1 - 2 * (rx * rx + ry * ry)) * cz;

          const worldCx = ex + tx;
          const worldCy = ey + ty;
          const worldCz = ez + tz;

          const t = this.rayAABB(
            ox, oy, oz, dx, dy, dz,
            worldCx - hx, worldCy - hy, worldCz - hz,
            worldCx + hx, worldCy + hy, worldCz + hz,
          );

          if (t > 0 && t < bestT) {
            bestT = t;
            bestEntityIdx = i;
            bestEntityId = entId;
            bestEntityType = type;
            bestHitX = ox + dx * t;
            bestHitY = oy + dy * t;
            bestHitZ = oz + dz * t;
            bestScale = scale;
          }
        }
      } else {
        const halfExtent = scale > 0 ? scale : 1;
        const t = this.rayAABB(
          ox, oy, oz, dx, dy, dz,
          ex - halfExtent, ey - halfExtent, ez - halfExtent,
          ex + halfExtent, ey + halfExtent, ez + halfExtent,
        );

        if (t > 0 && t < bestT) {
          bestT = t;
          bestEntityIdx = i;
          bestEntityId = entId;
          bestEntityType = type;
          bestHitX = ox + dx * t;
          bestHitY = oy + dy * t;
          bestHitZ = oz + dz * t;
          bestScale = scale;
        }
      }
    }

    if (bestEntityIdx < 0) return null;

    const slot = this.simReader.getEntitySlot(bestEntityIdx);
    if (!slot) return null;

    return {
      entityIndex: bestEntityIdx,
      entityId: bestEntityId,
      entityType: bestEntityType,
      worldX: bestHitX,
      worldY: bestHitY,
      worldZ: bestHitZ,
      distance: bestT,
      posX: slot.f32[ENT.POS_X],
      posY: slot.f32[ENT.POS_Y],
      posZ: slot.f32[ENT.POS_Z],
      scale: bestScale,
    };
  }

  private rayAABB(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): number {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (Math.abs(dx) < 1e-10) {
      if (ox < minX || ox > maxX) return -1;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dy) < 1e-10) {
      if (oy < minY || oy > maxY) return -1;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    if (Math.abs(dz) < 1e-10) {
      if (oz < minZ || oz > maxZ) return -1;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }

    if (tmax < 0) return -1;
    return tmin >= 0 ? tmin : tmax;
  }
}

// --- ILabelProvider implementation ---

export class GameLabelProvider implements ILabelProvider {
  constructor(private simReader: SimBufferReader) {}

  getLabels(): ILabelEntry[] {
    if (!this.simReader.isValid()) return [];

    const entityCount = this.simReader.getEntityCount();
    const playerCount = this.simReader.getPlayerCount();

    const plrSlot0 = this.simReader.getPlayerSlot(0);
    const refX = plrSlot0 ? plrSlot0.f32[PLR.POS_X] : 0;
    const refY = plrSlot0 ? plrSlot0.f32[PLR.POS_Y] : 0;
    const refZ = plrSlot0 ? plrSlot0.f32[PLR.POS_Z] : 0;

    const labels: ILabelEntry[] = [];

    for (let i = 0; i < entityCount; i++) {
      const entSlot = this.simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      if (entId === 0) continue;
      const type = entSlot.u32[ENT.TYPE] as EntityType;

      const ex = entSlot.f32[ENT.POS_X];
      const ey = entSlot.f32[ENT.POS_Y];
      const ez = entSlot.f32[ENT.POS_Z];
      const scale = entSlot.f32[ENT.SCALE];

      const dx = ex - refX, dy = ey - refY, dz = ez - refZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MAX_RENDER_DIST) continue;

      const typeName = EntityTypeNames[type] ?? `Type${type}`;
      const color = LABEL_COLORS[type] ?? "#dcdcaa";
      const distStr = dist < 100 ? dist.toFixed(0) : Math.round(dist / 10) * 10;

      labels.push({
        key: `ent-${entId}`,
        text: `${typeName} #${entId} (${distStr}m)`,
        color,
        x: ex,
        y: ey + scale + 1,
        z: ez,
      });
    }

    for (let i = 0; i < playerCount; i++) {
      const plrSlot = this.simReader.getPlayerSlot(i);
      if (!plrSlot) continue;
      const playerId = plrSlot.u32[PLR.PLAYER_ID];
      if (playerId === 0) continue;

      const px = plrSlot.f32[PLR.POS_X];
      const py = plrSlot.f32[PLR.POS_Y];
      const pz = plrSlot.f32[PLR.POS_Z];

      const dx = px - refX, dy = py - refY, dz = pz - refZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MAX_RENDER_DIST) continue;

      labels.push({
        key: `plr-${playerId}`,
        text: `Player #${playerId} (${Math.round(dist)}m)`,
        color: LABEL_COLORS[EntityType.Player] ?? "#4ec9b0",
        x: px,
        y: py + 2.5,
        z: pz,
      });
    }

    return labels;
  }
}

// --- ISceneSyncProvider implementation ---

export class GameSceneSyncProvider implements ISceneSyncProvider {
  constructor(private simReader: SimBufferReader) {}

  getEntitySnapshots(): ISceneEntitySnapshot[] {
    if (!this.simReader.isValid()) return [];
    const entityCount = this.simReader.getEntityCount();
    const entities: ISceneEntitySnapshot[] = [];
    for (let i = 0; i < entityCount; i++) {
      const entSlot = this.simReader.getEntitySlot(i);
      if (!entSlot) continue;
      const entId = entSlot.u32[ENT.ID];
      const type = entSlot.u32[ENT.TYPE] as EntityType;
      entities.push({
        id: entId,
        type,
        typeName: EntityTypeNames[type] ?? `Type${type}`,
        position: [entSlot.f32[ENT.POS_X], entSlot.f32[ENT.POS_Y], entSlot.f32[ENT.POS_Z]],
        rotation: [entSlot.f32[ENT.ROT_X], entSlot.f32[ENT.ROT_Y], entSlot.f32[ENT.ROT_Z], entSlot.f32[ENT.ROT_W]],
        scale: entSlot.f32[ENT.SCALE],
      });
    }
    return entities;
  }

  getPlayerCamera(): {
    position: { x: number; y: number; z: number };
    heading: number;
    pitch: number;
    cameraMode: number;
  } | null {
    if (!this.simReader.isValid()) return null;
    const playerSlot = this.simReader.getPlayerSlot(0);
    if (!playerSlot) return null;
    return {
      position: {
        x: playerSlot.f32[ENT.POS_X],
        y: playerSlot.f32[ENT.POS_Y],
        z: playerSlot.f32[ENT.POS_Z],
      },
      heading: playerSlot.f32[PLR.HEADING],
      pitch: playerSlot.f32[PLR.PITCH] ?? 0,
      cameraMode: playerSlot.u32[PLR.CAMERA_MODE] as CameraMode,
    };
  }
}

// --- Helper: compute ray origin/direction from sim reader ---

export function getRayOrigin(simReader: SimBufferReader): [number, number, number] | null {
  const playerSlot = simReader.getPlayerSlot(0);
  if (!playerSlot) return null;
  const px = playerSlot.f32[PLR.POS_X];
  const py = playerSlot.f32[PLR.POS_Y];
  const pz = playerSlot.f32[PLR.POS_Z];
  return [px, py + PLAYER_EYE_HEIGHT, pz];
}

export function getRayDirection(lookHeading: number, lookPitch: number): [number, number, number] {
  const cp = Math.cos(lookPitch);
  const sp = Math.sin(lookPitch);
  return [
    Math.sin(lookHeading) * cp,
    sp,
    -Math.cos(lookHeading) * cp,
  ];
}

export { RAY_MAX_DIST };
