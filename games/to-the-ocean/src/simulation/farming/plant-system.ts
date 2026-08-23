// ============================================================================
// Plant System — crop growth, water, seasons, mushrooms, bushes, harvesting
// ============================================================================
// Source of truth for all EntityType.Plant entities. The legacy ECS plant
// system (ecs-plant-system.ts) is NOT used to avoid double-ticking; this
// array-based system is driven explicitly from the simulation tick.
//
// Per-plant state lives in `this.plants` keyed by entity id. A compact
// projection is written into the entity's `data` Float32Array each tick so
// the renderer can pick the right procedural mesh without reading the map:
//
//   data[0] = growthStage (0..4)
//   data[1] = waterLevel (0..100)
//   data[2] = growth progress in current stage (0..1)
//   data[3] = cropId (reinterpreted as u32 via DataView)
//   data[4] = stress (0..1) — visual wilting
//   data[5] = alive flag (1 = alive, 0 = dead)
//   data[6] = bush-regrow flag (1 = bush currently regrowing fruit)
//
// Death: when stress reaches 1 the plant is killed (alive=0) and the caller
// is expected to removeEntity(). We keep the entry until removed so the
// renderer can show a dead plant briefly; removal is driven by the sim tick.

import { getCrop, type CropDef, type CropId } from "../../shared/data/crops";
import { BiomeType, EntityType } from "../../shared/types";
import type { SimEntity } from "../simulation";

/** Float32Array slots used by plants (must be <= SHIP_DATA_SLOTS=10). */
export const PLANT_DATA_SLOTS = 7;

export const PLANT_DATA = {
  STAGE: 0,
  WATER: 1,
  PROGRESS: 2,
  CROP_ID: 3,
  STRESS: 4,
  ALIVE: 5,
  REGROW: 6,
} as const;

export interface PlantData {
  cropId: CropId;
  growthStage: number;       // 0=seed,1=sprout,2=growing,3=mature,4=overripe
  growthTimer: number;       // seconds in current stage
  waterLevel: number;        // 0..100
  stress: number;            // 0..1 — reaches 1 => death
  alive: boolean;
  isWild: boolean;           // foraged specimen (not player-planted)
  planterInstanceId: number | null; // parent planter (for shelter check)
  plantedBiome: BiomeType;
  /** Bushes: when > 0, fruit is regrowing; reaches 0 => mature again. */
  regrowTimer: number;
  /** Mushrooms: cooldown after a spread attempt to avoid spamming. */
  spreadCooldown: number;
}

/** Context passed to tick() so the system can query biome + season + spawn. */
export interface PlantTickContext {
  dt: number;
  /** Returns the biome at a world position. */
  biomeAt: (x: number, z: number) => BiomeType;
  /** Cold-stress rate for a crop (0..1/s) given tolerance/biome/shelter. */
  coldStress: (coldTolerance: number, biomeIsCold: boolean, sheltered: boolean) => number;
  /** Heat-stress rate for a crop (0..1/s) given tolerance/biome/shelter. */
  heatStress: (heatTolerance: number, biomeIsHot: boolean, sheltered: boolean) => number;
  /** True if the plant's planter is sheltered (roofed / indoors). */
  isSheltered: (planterInstanceId: number | null) => boolean;
  /** Spawn a new plant entity (for mushroom spreading). Returns entity id or 0. */
  spawnPlant: (cropId: CropId, x: number, y: number, z: number, isWild: boolean) => number;
  /** Remove a dead plant entity. */
  removeEntity: (id: number) => void;
}

const DEFAULT_WATER = 100;
const WATER_DRAIN_BASE = 0.3; // per second, scaled by crop.waterNeed
const STRESS_DEATH = 1.0;
const STRESS_RECOVERY_RATE = 0.005; // per second when conditions are fine

// DataView scratch for encoding cropId (a string) into a single f32 slot.
// We hash the cropId string to a stable u32 and store it.
const CROP_ID_HASH_CACHE = new Map<CropId, number>();
function cropIdHash(id: CropId): number {
  let h = CROP_ID_HASH_CACHE.get(id);
  if (h !== undefined) return h;
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force into a positive int32 range; store as unsigned.
  h = hash >>> 0;
  CROP_ID_HASH_CACHE.set(id, h);
  return h;
}
const _dv = new DataView(new ArrayBuffer(4));
function f32FromU32(u32: number): number {
  _dv.setUint32(0, u32 >>> 0, true);
  return _dv.getFloat32(0, true);
}

export class PlantSystem {
  private plants = new Map<number, PlantData>();
  /** Entity ids that died this tick — caller may flush for removal. */
  private deadQueue: number[] = [];

  /** Plant a seed/spore. Returns true if accepted. */
  plant(entityId: number, cropId: CropId, opts: {
    isWild?: boolean;
    planterInstanceId?: number | null;
    biome?: BiomeType;
    /** Initial growth stage (default 0=seed). Wild plants use 3=mature. */
    initialStage?: number;
  } = {}): boolean {
    const crop = getCrop(cropId);
    if (!crop) return false;
    this.plants.set(entityId, {
      cropId,
      growthStage: opts.initialStage ?? 0,
      growthTimer: 0,
      waterLevel: DEFAULT_WATER,
      stress: 0,
      alive: true,
      isWild: opts.isWild ?? false,
      planterInstanceId: opts.planterInstanceId ?? null,
      plantedBiome: opts.biome ?? BiomeType.Ocean,
      regrowTimer: 0,
      spreadCooldown: 0,
    });
    return true;
  }

  water(entityId: number): boolean {
    const p = this.plants.get(entityId);
    if (!p || !p.alive) return false;
    p.waterLevel = DEFAULT_WATER;
    return true;
  }

  /** Harvest a mature plant. Returns the crop item id + quantity, or null. */
  harvest(entityId: number): { cropItemId: string; quantity: number } | null {
    const p = this.plants.get(entityId);
    if (!p || !p.alive) return null;
    const crop = getCrop(p.cropId);
    if (!crop) return null;

    // Bushes: only harvest when mature AND not currently regrowing.
    if (crop.isBush) {
      if (p.growthStage < 3 || p.regrowTimer > 0) return null;
      const qty = this.rollYield(crop);
      // Start regrow; bush stays alive at stage 3 but fruit is gone.
      p.regrowTimer = crop.regrowTime;
      return { cropItemId: crop.cropItemId, quantity: qty };
    }

    // Non-bushes: require mature (stage 3). Overripe (4) still harvestable but lower yield.
    if (p.growthStage < 3) return null;
    let qty = this.rollYield(crop);
    if (p.growthStage >= 4) qty = Math.max(1, Math.floor(qty * 0.5));
    // Reset to seed for a new cycle (keeps the planter occupied).
    p.growthStage = 0;
    p.growthTimer = 0;
    p.waterLevel = DEFAULT_WATER;
    p.stress = 0;
    return { cropItemId: crop.cropItemId, quantity: qty };
  }

  removePlant(entityId: number): void {
    this.plants.delete(entityId);
  }

  getPlantData(entityId: number): PlantData | null {
    return this.plants.get(entityId) ?? null;
  }

  /** Number of tracked plants (alive or recently dead). */
  get count(): number {
    return this.plants.size;
  }

  /**
   * Advance all plants. Iterates the sim entity array for EntityType.Plant
   * so we can read position (for biome + mushroom spreading) and write data.
   */
  tick(ctx: PlantTickContext, entities: SimEntity[], count: number): void {
    // Note: we do NOT clear deadQueue here — deaths accumulate across ticks
    // until the caller drains them via drainDead(). This avoids losing death
    // events when a plant dies on one tick and no further deaths occur before
    // the caller checks.
    for (let i = 0; i < count; i++) {
      const ent = entities[i];
      if (!ent || ent.type !== EntityType.Plant) continue;

      let p = this.plants.get(ent.id);
      if (!p) {
        // Unknown plant entity (e.g. loaded from save without a PlantData row).
        // Skip — it will be hydrated via plant() on load.
        continue;
      }
      if (!p.alive) continue;

      const crop = getCrop(p.cropId);
      if (!crop) continue;

      const dt = ctx.dt;
      const biome = ctx.biomeAt(ent.position.x, ent.position.z);
      const sheltered = ctx.isSheltered(p.planterInstanceId);
      const biomeIsCold = isColdBiome(biome);
      const biomeIsHot = isHotBiome(biome);

      // --- Water ---
      p.waterLevel = Math.max(0, p.waterLevel - WATER_DRAIN_BASE * crop.waterNeed * dt);

      // --- Stress from season/biome mismatch ---
      const cold = ctx.coldStress(crop.coldTolerance, biomeIsCold, sheltered);
      const heat = ctx.heatStress(crop.heatTolerance, biomeIsHot, sheltered);
      const stressRate = Math.max(cold, heat);
      if (stressRate > 0) {
        p.stress = Math.min(STRESS_DEATH, p.stress + stressRate * dt);
      } else if (p.stress > 0) {
        p.stress = Math.max(0, p.stress - STRESS_RECOVERY_RATE * dt);
      }

      // --- Death ---
      if (p.stress >= STRESS_DEATH) {
        p.alive = false;
        this.deadQueue.push(ent.id);
        this.writeData(ent, p);
        continue;
      }

      // --- Bush fruit regrow (independent of water — bush stays alive, just
      // regrows fruit over time). ---
      if (crop.isBush && p.regrowTimer > 0 && p.alive) {
        p.regrowTimer = Math.max(0, p.regrowTimer - dt);
      }

      // --- Growth (only when watered and not dead) ---
      const canGrow = p.waterLevel > crop.minWaterToGrow && p.stress < 0.5;
      if (canGrow) {
        if (crop.isBush && p.regrowTimer > 0) {
          // Bush regrowing fruit: handled above (water-independent).
        } else if (p.growthStage < 3) {
          p.growthTimer += dt;
          // Advance through as many stages as the elapsed time warrants (a
          // single tick with large dt can span multiple short stages).
          let guard = 0;
          while (p.growthStage < 3 && p.growthTimer >= crop.stageDurations[p.growthStage] && guard++ < 8) {
            p.growthTimer -= crop.stageDurations[p.growthStage];
            p.growthStage++;
          }
          if (p.growthStage >= 3) p.growthTimer = 0;
        } else if (p.growthStage === 3 && !crop.isBush) {
          // Non-bush: progress toward overripe (stage 4) after mature duration.
          p.growthTimer += dt;
          if (p.growthTimer >= crop.stageDurations[3]) {
            p.growthStage = 4;
            p.growthTimer = 0;
          }
        }
      }

      // --- Mushroom spreading ---
      if (crop.isMushroom && p.growthStage >= 3 && p.alive) {
        p.spreadCooldown = Math.max(0, p.spreadCooldown - dt);
        if (p.spreadCooldown <= 0) {
          // Per-second probability: spreadChance is per-tick-ish; scale by dt.
          if (Math.random() < crop.spreadChance * dt * 60) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 1 + Math.random() * crop.spreadRange;
            const nx = ent.position.x + Math.cos(angle) * dist;
            const nz = ent.position.z + Math.sin(angle) * dist;
            const ny = ent.position.y;
            const newId = ctx.spawnPlant(p.cropId, nx, ny, nz, true);
            if (newId) {
              this.plant(newId, p.cropId, { isWild: true, planterInstanceId: null, biome: ctx.biomeAt(nx, nz) });
            }
          }
          p.spreadCooldown = 5; // seconds between attempts
        }
      }

      this.writeData(ent, p);
    }
  }

  /** Returns entity ids that died this tick (caller removes them). */
  drainDead(): number[] {
    const d = this.deadQueue;
    this.deadQueue = [];
    return d;
  }

  /** Serialize for save. */
  serialize(): { id: number; data: PlantData }[] {
    const out: { id: number; data: PlantData }[] = [];
    for (const [id, p] of this.plants) {
      out.push({ id, data: { ...p } });
    }
    return out;
  }

  /** Hydrate from save. */
  deserialize(rows: { id: number; data: PlantData }[]): void {
    this.plants.clear();
    for (const row of rows) {
      this.plants.set(row.id, { ...row.data });
    }
  }

  // --- internals ---

  private rollYield(crop: CropDef): number {
    const v = crop.yieldVariance;
    return Math.max(1, crop.baseYield + Math.floor((Math.random() * 2 - 1) * v));
  }

  private writeData(ent: SimEntity, p: PlantData): void {
    if (!ent.data || ent.data.length < PLANT_DATA_SLOTS) return;
    ent.data[PLANT_DATA.STAGE] = p.growthStage;
    ent.data[PLANT_DATA.WATER] = p.waterLevel;
    const crop = getCrop(p.cropId);
    const dur = crop ? crop.stageDurations[Math.min(p.growthStage, 3)] : 1;
    ent.data[PLANT_DATA.PROGRESS] = dur > 0 ? Math.min(1, p.growthTimer / dur) : 0;
    ent.data[PLANT_DATA.CROP_ID] = f32FromU32(cropIdHash(p.cropId));
    ent.data[PLANT_DATA.STRESS] = p.stress;
    ent.data[PLANT_DATA.ALIVE] = p.alive ? 1 : 0;
    ent.data[PLANT_DATA.REGROW] = p.regrowTimer > 0 ? 1 : 0;
  }
}

// --- biome helpers (mirror BiomeSystem thresholds) ---
function isColdBiome(b: BiomeType): boolean {
  return b === BiomeType.Arctic || b === BiomeType.BorealForest || b === BiomeType.DeepOcean;
}
function isHotBiome(b: BiomeType): boolean {
  return b === BiomeType.Desert || b === BiomeType.Volcanic || b === BiomeType.Hell;
}
