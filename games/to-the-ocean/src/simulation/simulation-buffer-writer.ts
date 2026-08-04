// SharedArrayBuffer writing — extracted from Simulation.ts

import { shoreDamping, shoreDisplacement, waterCutout, type ShoreSource } from "@downdraft/plugin-water";
import { WeatherSystem } from "@downdraft/plugin-weather";
import { ENT, PLR, PLR_FLAG, SimBufferWriter } from "../shared/sim-buffer";
import { GameMode, SimToMainMessage } from "../shared/types";
import { WATER_GRID, WaterBufferWriter } from "../shared/water-buffer";
import { BoatCellSystem } from "./boat/boat-cell-system";
import { BoatSystem } from "./boat/boat-system";
import { CameraController } from "./camera/camera-controller";
import { FishingSystem } from "./fishing/fishing-system";
import { getGridStateForUI } from "./inventory/inventory-system";
import { RapierPhysicsSystem } from "./physics/rapier-physics-system";
import { fastCos, fastSin } from "./sim-trig";
import type { SimulationEntityManagerAccess } from "./simulation-entity-manager";
import { ChunkManager } from "./world/chunk-manager";

export interface SimulationBufferWriterAccess extends SimulationEntityManagerAccess {
  simWriter: SimBufferWriter;
  waterWriter: WaterBufferWriter;
  weatherSystem: WeatherSystem;
  chunkManager: ChunkManager;
  physics: RapierPhysicsSystem | null;
  boatCellSystem: BoatCellSystem;
  boatSystem: BoatSystem;
  cameraController: CameraController;
  fishingSystem: FishingSystem;
  gamemode: GameMode;
  simTime: number;
  timeOfDay: number;
  totalTicks: number;
  seaState: number;
  buoyancyShoreSources: ShoreSource[];
  buoyancyShoreCount: number;
  buoyancySimTime: number;
  _onEvent: (msg: SimToMainMessage) => void;
}

export function writeToBuffer(sim: SimulationBufferWriterAccess): void {
  // Write header
  sim.simWriter.setTimeOfDay(sim.timeOfDay);
  const weather = sim.weatherSystem.getState();
  sim.simWriter.setWeather(weather.type, weather.intensity);
  sim.simWriter.setWind(weather.windSpeed, weather.windDirection.x, weather.windDirection.z);
  sim.simWriter.setVisibility(weather.visibility);
  sim.simWriter.setAmbientTemp(weather.temperature);
  sim.simWriter.setEntityCount(sim.entityCount);
  sim.simWriter.setPlayerCount(sim.playerCount);
  sim.simWriter.setGamemode(Object.values(GameMode).indexOf(sim.gamemode));

  // Physics stats
  const physStats = sim.physics?.getStats();
  sim.simWriter.setPhysicsInitialized(physStats?.initialized ? 1 : 0);
  sim.simWriter.setPhysicsFailed(physStats?.failed ? 1 : 0);
  sim.simWriter.setPhysicsBodyCount(physStats?.bodyCount ?? 0);
  sim.simWriter.setPhysicsTickCount(physStats?.tickCount ?? 0);

  // Chunk stats
  sim.simWriter.setChunkCount(sim.chunkManager.getLoadedChunkCount());

  // Write player active bitmask
  let activeMask = 0;
  for (let i = 0; i < sim.playerCount; i++) {
    if (sim.players[i].active) activeMask |= (1 << i);
  }
  sim.simWriter.setActivePlayers(activeMask);

  // Sync player entities with player positions
  for (let i = 0; i < sim.playerCount; i++) {
    const p = sim.players[i];
    if (!p) continue;
    // Use the entityIndex directly for lookups
    const entry = sim.entityIndex.get(p.entityId);
    if (entry !== undefined && sim.generations[entry.slot] === entry.gen) {
      const ent = sim.entities[entry.slot];
      if (ent) {
        ent.position.x = p.position.x;
        ent.position.y = p.position.y;
        ent.position.z = p.position.z;
        ent.rotation.x = 0;
        ent.rotation.y = Math.sin((-p.bodyHeading + Math.PI) / 2);
        ent.rotation.z = 0;
        ent.rotation.w = Math.cos((-p.bodyHeading + Math.PI) / 2);
      }
    }
  }

  // Write entity data
  for (let i = 0; i < sim.entityCount; i++) {
    const ent = sim.entities[i];
    if (!ent) continue;
    const f32 = sim.simWriter.getEntityF32(i);
    const u32 = sim.simWriter.getEntityU32(i);

    f32[ENT.POS_X] = Number.isFinite(ent.position.x) ? ent.position.x : 0;
    f32[ENT.POS_Y] = Number.isFinite(ent.position.y) ? ent.position.y : 0;
    f32[ENT.POS_Z] = Number.isFinite(ent.position.z) ? ent.position.z : 0;
    f32[ENT.SCALE] = Number.isFinite(ent.scale) ? ent.scale : 1;
    f32[ENT.ROT_X] = Number.isFinite(ent.rotation.x) ? ent.rotation.x : 0;
    f32[ENT.ROT_Y] = Number.isFinite(ent.rotation.y) ? ent.rotation.y : 0;
    f32[ENT.ROT_Z] = Number.isFinite(ent.rotation.z) ? ent.rotation.z : 0;
    f32[ENT.ROT_W] = Number.isFinite(ent.rotation.w) ? ent.rotation.w : 1;
    f32[ENT.VEL_X] = Number.isFinite(ent.velocity.x) ? ent.velocity.x : 0;
    f32[ENT.VEL_Y] = Number.isFinite(ent.velocity.y) ? ent.velocity.y : 0;
    f32[ENT.VEL_Z] = Number.isFinite(ent.velocity.z) ? ent.velocity.z : 0;
    f32[ENT.HEALTH] = Number.isFinite(ent.health) ? ent.health : 0;
    f32[ENT.MAX_HEALTH] = Number.isFinite(ent.maxHealth) ? ent.maxHealth : 0;
    u32[ENT.TYPE] = ent.type;
    u32[ENT.FLAGS] = ent.flags;
    u32[ENT.ID] = ent.id;
    u32[ENT.PARENT_ID] = ent.parentId;
    u32[ENT.CHUNK_X] = ent.chunkX;
    u32[ENT.CHUNK_Z] = ent.chunkZ;

    // Type-specific data (data[0..9] — slots 8-9 use reserved space for anchor XZ)
    if (ent.data) {
      for (let j = 0; j < Math.min(10, ent.data.length); j++) {
        f32[ENT.DATA + j] = ent.data[j];
      }
    }
  }

  // Write player data
  for (let i = 0; i < sim.playerCount; i++) {
    const p = sim.players[i];
    if (!p) continue;
    const f32 = sim.simWriter.getPlayerF32(i);
    const u32 = sim.simWriter.getPlayerU32(i);

    f32[PLR.POS_X] = Number.isFinite(p.position.x) ? p.position.x : 0;
    f32[PLR.POS_Y] = Number.isFinite(p.position.y) ? p.position.y : 0;
    f32[PLR.POS_Z] = Number.isFinite(p.position.z) ? p.position.z : 0;
    f32[PLR.HEADING] = Number.isFinite(p.heading) ? p.heading : 0;
    f32[PLR.PITCH] = Number.isFinite(p.pitch) ? p.pitch : 0;
    f32[PLR.HEALTH] = Number.isFinite(p.health) ? p.health : 0;
    f32[PLR.MAX_HEALTH] = Number.isFinite(p.maxHealth) ? p.maxHealth : 0;
    f32[PLR.HUNGER] = Number.isFinite(p.hunger) ? p.hunger : 0;
    f32[PLR.THIRST] = Number.isFinite(p.thirst) ? p.thirst : 0;
    f32[PLR.OXYGEN] = Number.isFinite(p.oxygen) ? p.oxygen : 0;
    f32[PLR.MAX_OXYGEN] = Number.isFinite(p.maxOxygen) ? p.maxOxygen : 0;
    f32[PLR.TEMPERATURE] = Number.isFinite(p.temperature) ? p.temperature : 0;
    u32[PLR.CAMERA_MODE] = p.cameraMode;
    u32[PLR.ACTIVE_SLOT] = p.activeSlot;
    u32[PLR.FLAGS] = p.flags;
    u32[PLR.ENTITY_ID] = p.entityId;
    u32[PLR.PLAYER_ID] = p.playerId;
    f32[PLR.VIEWPORT_X] = p.viewport.x;
    f32[PLR.VIEWPORT_Y] = p.viewport.y;
    f32[PLR.VIEWPORT_W] = p.viewport.w;
    f32[PLR.VIEWPORT_H] = p.viewport.h;
    f32[PLR.THIRD_PERSON_DISTANCE] = p.thirdPersonDistance;
    f32[PLR.GOLD] = p.gold;

    // Write fishing state
    const fishState = sim.fishingSystem.getMinigameState(i);
    f32[PLR.FISHING_TENSION] = fishState ? fishState.tension : 0;
    f32[PLR.FISHING_PROGRESS] = fishState ? fishState.progress : 0;

    // Write freecam data
    const freecamPos = sim.cameraController.getFreecamPosition(p.playerId);
    const freecamAngles = sim.cameraController.getFreecamAngles(p.playerId);
    if (freecamPos) {
      f32[PLR.FREECAM_X] = freecamPos.x;
      f32[PLR.FREECAM_Y] = freecamPos.y;
      f32[PLR.FREECAM_Z] = freecamPos.z;
    } else {
      f32[PLR.FREECAM_X] = p.position.x;
      f32[PLR.FREECAM_Y] = p.position.y + 5;
      f32[PLR.FREECAM_Z] = p.position.z;
    }
    if (freecamAngles) {
      f32[PLR.FREECAM_PITCH] = freecamAngles.pitch;
      f32[PLR.FREECAM_YAW] = freecamAngles.yaw;
    } else {
      f32[PLR.FREECAM_PITCH] = 0;
      f32[PLR.FREECAM_YAW] = p.heading;
    }
  }

  sim.simWriter.incrementTick();
}

export function updateWaterBuffer(sim: SimulationBufferWriterAccess): void {
  const gridSize = 256;
  const time = sim.simTime;

  // --- Wind-driven sea state ---
  const windSpeed = sim.weatherSystem.getWindSpeed();
  const targetSeaState = Math.min(1.0, Math.max(0.0, (windSpeed - 2.0) / 23.0));
  sim.seaState += (targetSeaState - sim.seaState) * 0.00083;
  const ss = sim.seaState;

  const ampScale = 0.5 + ss * 2.0;
  const speedScale = 1.0 + ss * 0.5;

  const windDir = sim.weatherSystem.getWindDirection();
  const swellK = 3.0;
  const swellAmp = 0.4 * ss;

  const TWO_PI = 2 * Math.PI;
  const invGrid = TWO_PI / gridSize;
  const p0 = time * 0.8 * speedScale;
  const p1 = time * 1.0 * speedScale;
  const p2 = time * 0.5 * speedScale;
  const p3 = time * 1.5 * speedScale;
  const p4 = time * 1.2 * speedScale;
  const p5 = time * 0.9 * speedScale;
  const p6 = time * 0.6 * speedScale;

  const wxArr = new Float64Array(gridSize);
  for (let x = 0; x < gridSize; x++) wxArr[x] = x * invGrid;

  const heights = sim.waterWriter.heights;
  const windDirX = windDir.x;
  const windDirZ = windDir.z;

  for (let z = 0; z < gridSize; z++) {
    const wz = z * invGrid;
    const rowBase = z * gridSize;
    for (let x = 0; x < gridSize; x++) {
      const wx = wxArr[x];
      const h =
        (fastSin(wx * 8 + p0) * 0.6 +
         fastSin(wz * 10 + p1) * 0.4 +
         fastSin((wx + wz) * 6 + p2) * 0.3 +
         fastSin(wx * 20 - p3) * 0.15 +
         fastCos(wz * 18 + p4) * 0.12 +
         fastSin((wx * 3 + wz * 4) * 5 + p5) * 0.2) * ampScale +
          fastSin((wx * windDirX + wz * windDirZ) * swellK + p6) * swellAmp;
      heights[rowBase + x] = h;
    }
  }

  sim.waterWriter.incrementSequence();
}

export function broadcastShipHoldUpdate(sim: SimulationBufferWriterAccess): void {
  for (let i = 0; i < sim.playerCount; i++) {
    const p = sim.players[i];
    if (!p?.active) continue;
    const isOnboard = (p.flags & PLR_FLAG.ONBOARD) !== 0;
    if (!isOnboard) {
      sim._onEvent({
        kind: "ship_hold_update",
        data: { playerId: p.playerId, isOnboard: false, shipEntityId: 0, shipName: "", holdItems: [], playerItems: getGridStateForUI(p.inventory) },
      } as SimToMainMessage);
      continue;
    }
    const shipEntityId = sim.boatSystem.getOnboardShipId(p.playerId);
    if (!shipEntityId) {
      sim._onEvent({
        kind: "ship_hold_update",
        data: { playerId: p.playerId, isOnboard: false, shipEntityId: 0, shipName: "", holdItems: [], playerItems: getGridStateForUI(p.inventory) },
      } as SimToMainMessage);
      continue;
    }
    const holdGrid = sim.shipInventories.get(shipEntityId);
    const design = sim.boatDesignSystem.getDesign(shipEntityId);
    const shipName = design?.metadata?.name ?? "Ship";
    sim._onEvent({
      kind: "ship_hold_update",
      data: {
        playerId: p.playerId,
        isOnboard: true,
        shipEntityId,
        shipName,
        holdItems: holdGrid ? getGridStateForUI(holdGrid) : [],
        playerItems: getGridStateForUI(p.inventory),
      },
    } as SimToMainMessage);
  }
}

export function sampleWaterForBuoyancy(sim: SimulationBufferWriterAccess, x: number, z: number): number {
  if (waterCutout(x, z, sim.buoyancyShoreSources, sim.buoyancyShoreCount)) return -1000;
  const patchSize = sim.waterWriter.getPatchSize() || 4;
  const origin = sim.waterWriter.getOrigin();
  const gx = ((x - origin.x) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
  const gz = ((z - origin.z) / patchSize % WATER_GRID + WATER_GRID) % WATER_GRID;
  const rawH = sim.waterWriter.sampleHeight(gx, gz);
  const damping = shoreDamping(x, z, sim.buoyancyShoreSources, sim.buoyancyShoreCount);
  const shore = shoreDisplacement(x, z, sim.buoyancySimTime, sim.buoyancyShoreSources, sim.buoyancyShoreCount);
  return rawH * damping + shore;
}
