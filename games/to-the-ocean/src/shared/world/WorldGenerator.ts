// ============================================================================
// World Generator — procedural ocean, islands, ports
// ============================================================================

import { BiomeType, SecurityLevel, PortDef, IslandDef, ChunkInfo, PortSize, PortTheme, IslandSize, PortService } from "../../shared/types";
import { PORT_SPACING, ISLAND_SPACING, CHUNK_SIZE } from "../../shared/constants";
import { PerlinNoise } from "./PerlinNoise";

// Simple seeded PRNG
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Noise scale constants (lower = larger biome regions)
const TEMP_NOISE_SCALE = 0.008;
const ELEV_NOISE_SCALE = 0.006;
const MOIST_NOISE_SCALE = 0.012;
const SPECIAL_NOISE_SCALE = 0.02;

// Latitude band strength — how much |chunkZ| affects temperature
const LATITUDE_EFFECT = 0.6;

export class WorldGenerator {
  private seed: number;
  private tempNoise: PerlinNoise;
  private elevNoise: PerlinNoise;
  private moistNoise: PerlinNoise;
  private specialNoise: PerlinNoise;
  private biomeOverrides = new Map<string, BiomeType>();
  private forcedPorts = new Set<string>();
  private forcedIslands = new Set<string>();
  private removedPorts = new Set<string>();
  private removedIslands = new Set<string>();
  private portGenerationRate = 0.015;
  private islandGenerationRate = 0.00000025;

  constructor(seed: number) {
    this.seed = seed;
    this.tempNoise = new PerlinNoise(seed ^ 0x5DEECE66D);
    this.elevNoise = new PerlinNoise(seed ^ 0x12345678);
    this.moistNoise = new PerlinNoise(seed ^ 0x9E3779B9);
    this.specialNoise = new PerlinNoise(seed ^ 0x85DCA731);
  }

  setGenerationRates(portRate: number, islandRate: number): void {
    this.portGenerationRate = portRate;
    this.islandGenerationRate = islandRate;
  }

  setBiomeOverride(chunkX: number, chunkZ: number, biome: BiomeType): void {
    this.biomeOverrides.set(`${chunkX},${chunkZ}`, biome);
  }

  forcePort(chunkX: number, chunkZ: number): void {
    this.forcedPorts.add(`${chunkX},${chunkZ}`);
    this.removedPorts.delete(`${chunkX},${chunkZ}`);
  }

  forceIsland(chunkX: number, chunkZ: number): void {
    this.forcedIslands.add(`${chunkX},${chunkZ}`);
    this.removedIslands.delete(`${chunkX},${chunkZ}`);
  }

  removePort(chunkX: number, chunkZ: number): void {
    this.removedPorts.add(`${chunkX},${chunkZ}`);
    this.forcedPorts.delete(`${chunkX},${chunkZ}`);
  }

  removeIsland(chunkX: number, chunkZ: number): void {
    this.removedIslands.add(`${chunkX},${chunkZ}`);
    this.forcedIslands.delete(`${chunkX},${chunkZ}`);
  }

  clearOverrides(): void {
    this.biomeOverrides.clear();
    this.forcedPorts.clear();
    this.forcedIslands.clear();
    this.removedPorts.clear();
    this.removedIslands.clear();
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.tempNoise = new PerlinNoise(seed ^ 0x5DEECE66D);
    this.elevNoise = new PerlinNoise(seed ^ 0x12345678);
    this.moistNoise = new PerlinNoise(seed ^ 0x9E3779B9);
    this.specialNoise = new PerlinNoise(seed ^ 0x85DCA731);
    this.clearOverrides();
  }

  getOverrides(): { biomes: [number, number, number][]; ports: [number, number][]; islands: [number, number][] } {
    const biomes: [number, number, number][] = [];
    this.biomeOverrides.forEach((biome, key) => {
      const parts = key.split(",");
      biomes.push([parseInt(parts[0], 10), parseInt(parts[1], 10), biome]);
    });
    const ports: [number, number][] = [];
    this.forcedPorts.forEach((key) => {
      const parts = key.split(",");
      ports.push([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
    });
    const islands: [number, number][] = [];
    this.forcedIslands.forEach((key) => {
      const parts = key.split(",");
      islands.push([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
    });
    return { biomes, ports, islands };
  }

  getChunkInfo(chunkX: number, chunkZ: number): ChunkInfo {
    const rng = mulberry32(this.seed + chunkX * 73856093 + chunkZ * 19349663);

    // Biome determination using Perlin noise fields
    const distFromOrigin = Math.sqrt(chunkX * chunkX + chunkZ * chunkZ);
    let biome: BiomeType;

    const overrideKey = `${chunkX},${chunkZ}`;
    if (this.biomeOverrides.has(overrideKey)) {
      biome = this.biomeOverrides.get(overrideKey)!;
    } else if (distFromOrigin < 3) {
      biome = BiomeType.Ocean; // start area is ocean
    } else {
      // Sample noise fields at chunk coordinates (in chunk units)
      // fBm returns approximately [-1, 1], normalize to [0, 1]
      const tempRaw = this.tempNoise.fbm(chunkX * TEMP_NOISE_SCALE, chunkZ * TEMP_NOISE_SCALE, 4, 0.5, 2.0);
      const elevRaw = this.elevNoise.fbm(chunkX * ELEV_NOISE_SCALE, chunkZ * ELEV_NOISE_SCALE, 4, 0.5, 2.0);
      const moistRaw = this.moistNoise.fbm(chunkX * MOIST_NOISE_SCALE, chunkZ * MOIST_NOISE_SCALE, 3, 0.5, 2.0);
      const specialRaw = this.specialNoise.fbm(chunkX * SPECIAL_NOISE_SCALE, chunkZ * SPECIAL_NOISE_SCALE, 3, 0.5, 2.0);

      let temp = (tempRaw + 1) * 0.5; // 0 = cold, 1 = hot
      const elev = (elevRaw + 1) * 0.5; // 0 = deep, 1 = high
      const moist = (moistRaw + 1) * 0.5; // 0 = dry, 1 = wet
      const special = (specialRaw + 1) * 0.5; // 0..1, high = rare biome chance

      // Latitude effect: |chunkZ| pushes temperature toward cold extremes
      const latitude = Math.min(1, Math.abs(chunkZ) / 80);
      temp = Math.max(0, Math.min(1, temp - latitude * LATITUDE_EFFECT));

      // Distance from origin: further out = more extreme temperature swings
      if (distFromOrigin > 20) {
        const extremity = Math.min(1, (distFromOrigin - 20) / 60);
        temp = temp < 0.5
          ? Math.max(0, temp - extremity * 0.2)
          : Math.min(1, temp + extremity * 0.2);
      }

      biome = this.mapNoiseToBiome(elev, temp, moist, special, distFromOrigin);
    }

    // Security level: increases with distance (larger zones)
    let securityLevel: SecurityLevel;
    const secRoll = rng();
    if (distFromOrigin < 24) {
      securityLevel = secRoll < 0.7 ? SecurityLevel.Safe : SecurityLevel.Moderate;
    } else if (distFromOrigin < 60) {
      securityLevel = secRoll < 0.3 ? SecurityLevel.Safe : secRoll < 0.7 ? SecurityLevel.Moderate : SecurityLevel.High;
    } else {
      securityLevel = secRoll < 0.1 ? SecurityLevel.Moderate : secRoll < 0.4 ? SecurityLevel.High : SecurityLevel.Extreme;
    }

    // Check for port — force one in chunk (1,0) near spawn
    const portRoll = rng();
    const islandRoll = rng();
    const isStartPort = chunkX === 1 && chunkZ === 0;
    const isStartIsland = chunkX === 0 && chunkZ === 1;
    const portKey = `${chunkX},${chunkZ}`;
    let hasPort = (isStartPort || portRoll < this.portGenerationRate) && (chunkX !== 0 || chunkZ !== 0);
    let hasIsland = isStartIsland || islandRoll < this.islandGenerationRate;
    if (this.forcedPorts.has(portKey)) hasPort = true;
    if (this.removedPorts.has(portKey)) hasPort = false;
    if (this.forcedIslands.has(portKey)) hasIsland = true;
    if (this.removedIslands.has(portKey)) hasIsland = false;

    // Water depth based on biome
    let waterDepth = 50;
    if (biome === BiomeType.DeepOcean) waterDepth = 500;
    else if (biome === BiomeType.Ocean) waterDepth = 100;
    else if (biome === BiomeType.Lake || biome === BiomeType.Freshwater) waterDepth = 20;
    else if (biome === BiomeType.Arctic) waterDepth = 80;
    else if (biome === BiomeType.Volcanic || biome === BiomeType.Hell) waterDepth = 200;

    return {
      x: chunkX,
      z: chunkZ,
      biome,
      securityLevel,
      hasPort,
      hasIsland,
      waterDepth,
    };
  }

  private mapNoiseToBiome(
    elev: number,
    temp: number,
    moist: number,
    special: number,
    distFromOrigin: number,
  ): BiomeType {
    // Special biomes — rare noise-driven regions, more likely far from origin
    const farBoost = Math.min(0.1, (distFromOrigin - 20) / 400);
    if (special > 0.85 - farBoost && temp > 0.75) {
      return temp > 0.9 ? BiomeType.Hell : BiomeType.Volcanic;
    }
    if (special > 0.82 - farBoost && temp < 0.35 && elev < 0.45) {
      return BiomeType.GarbagePatch;
    }

    // Standard biome mapping: elevation × temperature matrix
    // Elevation bands: deep (<0.25), low (0.25-0.45), mid (0.45-0.65), high (0.65-0.82), peak (>0.82)
    // Temperature bands: arctic (<0.2), cold (0.2-0.4), temperate (0.4-0.6), warm (0.6-0.8), hot (>0.8)

    if (elev < 0.25) {
      // Deep waters
      if (temp < 0.2) return BiomeType.DeepOcean;
      return BiomeType.DeepOcean;
    } else if (elev < 0.45) {
      // Shallow waters
      if (temp < 0.2) return BiomeType.Arctic;
      if (temp < 0.4) return moist > 0.5 ? BiomeType.KelpForest : BiomeType.Ocean;
      if (temp < 0.7) return moist > 0.5 ? BiomeType.KelpForest : BiomeType.Ocean;
      return BiomeType.CoralReef;
    } else if (elev < 0.65) {
      // Coastal / surface waters
      if (temp < 0.2) return BiomeType.Arctic;
      if (temp < 0.4) return moist > 0.6 ? BiomeType.Freshwater : BiomeType.Ocean;
      if (temp < 0.6) return moist > 0.6 ? BiomeType.Lake : BiomeType.Ocean;
      if (temp < 0.8) return BiomeType.SubTropical;
      return BiomeType.Tropical;
    } else if (elev < 0.82) {
      // Land-ish zones
      if (temp < 0.2) return BiomeType.Arctic;
      if (temp < 0.4) return BiomeType.BorealForest;
      if (temp < 0.6) return moist > 0.5 ? BiomeType.SubTropical : BiomeType.BorealForest;
      if (temp < 0.8) return BiomeType.Tropical;
      return moist < 0.35 ? BiomeType.Desert : BiomeType.Tropical;
    } else {
      // Peaks / extreme elevation
      if (temp < 0.2) return BiomeType.Arctic;
      if (temp < 0.4) return BiomeType.BorealForest;
      if (temp < 0.6) return BiomeType.SubTropical;
      if (temp < 0.8) return moist < 0.3 ? BiomeType.Desert : BiomeType.Tropical;
      return BiomeType.Desert;
    }
  }

  generatePort(chunkX: number, chunkZ: number, biome: BiomeType, security: SecurityLevel): PortDef {
    const rng = mulberry32(this.seed + chunkX * 83492791 + chunkZ * 26515163);

    // Port size: closer to origin = bigger
    const distFromOrigin = Math.sqrt(chunkX * chunkX + chunkZ * chunkZ);
    let size: PortSize;
    const sizeRoll = rng();
    if (distFromOrigin < 10) {
      size = sizeRoll < 0.5 ? PortSize.Large : PortSize.Medium;
    } else if (distFromOrigin < 25) {
      size = sizeRoll < 0.3 ? PortSize.Large : sizeRoll < 0.7 ? PortSize.Medium : PortSize.Small;
    } else {
      size = sizeRoll < 0.6 ? PortSize.Small : PortSize.Medium;
    }

    // Theme based on biome and security
    const themes: PortTheme[] = this.getThemesForBiome(biome, security);
    const theme = themes[Math.floor(rng() * themes.length)];

    // Port name
    const namePrefixes = ["Port", "Cape", "Bay", "Harbor", "Cove", "Landing", "Refuge", "Anchorage"];
    const nameSuffixes = ["Azure", "Coral", "Driftwood", "Salt", "Storm", "Pearl", "Tide", "Reef", "Deep", "Sunken", "Golden", "Silver", "Iron", "Bone"];
    const name = `${namePrefixes[Math.floor(rng() * namePrefixes.length)]} ${nameSuffixes[Math.floor(rng() * nameSuffixes.length)]}`;

    return {
      id: `port_${chunkX}_${chunkZ}`,
      name,
      size,
      theme,
      position: {
        x: chunkX * CHUNK_SIZE + rng() * CHUNK_SIZE,
        y: 0,
        z: chunkZ * CHUNK_SIZE + rng() * CHUNK_SIZE,
      },
      securityLevel: security,
      biome,
      marketSpecialties: this.getMarketSpecialties(biome, rng),
      services: this.getServices(size),
    };
  }

  generateIsland(chunkX: number, chunkZ: number, biome: BiomeType, security: SecurityLevel): IslandDef {
    const rng = mulberry32(this.seed + chunkX * 92837111 + chunkZ * 72635341);

    const distFromOrigin = Math.sqrt(chunkX * chunkX + chunkZ * chunkZ);
    let size: IslandSize;
    const sizeRoll = rng();
    if (distFromOrigin < 15) {
      size = sizeRoll < 0.4 ? IslandSize.Large : sizeRoll < 0.7 ? IslandSize.Medium : IslandSize.Small;
    } else {
      size = sizeRoll < 0.5 ? IslandSize.Small : sizeRoll < 0.8 ? IslandSize.Medium : IslandSize.Large;
    }

    const radius = size === IslandSize.Small ? 60 + rng() * 60 :
                   size === IslandSize.Medium ? 120 + rng() * 120 :
                   240 + rng() * 240;

    const namePrefixes = ["Isla", "Rock", "Key", "Atoll", "Isle", "Shoal", "Skerry"];
    const nameSuffixes = ["Verde", "Perdida", "Grande", "Negra", "Blanca", "Dorada", "Oscuro", "Mystic", "Forgotten", "Hidden"];
    const name = `${namePrefixes[Math.floor(rng() * namePrefixes.length)]} ${nameSuffixes[Math.floor(rng() * nameSuffixes.length)]}`;

    const resourceCount = size === IslandSize.Small ? 3 + Math.floor(rng() * 3) :
                          size === IslandSize.Medium ? 8 + Math.floor(rng() * 8) :
                          20 + Math.floor(rng() * 15);

    const resourceNodes = [];
    for (let i = 0; i < resourceCount; i++) {
      resourceNodes.push({
        type: this.getResourceType(biome, rng),
        position: {
          x: (rng() - 0.5) * radius * 1.5,
          y: 0,
          z: (rng() - 0.5) * radius * 1.5,
        },
        amount: 5 + Math.floor(rng() * 20),
        respawnTime: 300 + rng() * 600,
      });
    }

    return {
      id: `island_${chunkX}_${chunkZ}`,
      name,
      size,
      position: {
        x: chunkX * CHUNK_SIZE + rng() * CHUNK_SIZE,
        y: 0,
        z: chunkZ * CHUNK_SIZE + rng() * CHUNK_SIZE,
      },
      radius,
      biome,
      securityLevel: security,
      hasCoves: size === IslandSize.Large && rng() < 0.6,
      hasCaves: size === IslandSize.Large && rng() < 0.4,
      resourceNodes,
      craftingStations: size !== IslandSize.Small && rng() < 0.5 ? ["workbench"] : [],
      storageAreas: size === IslandSize.Large ? Math.floor(rng() * 3) : 0,
    };
  }

  private getThemesForBiome(biome: BiomeType, security: SecurityLevel): PortTheme[] {
    const themes: PortTheme[] = [];
    if (security >= SecurityLevel.High) {
      themes.push(PortTheme.Pirate, PortTheme.Mafia, PortTheme.Salvage);
    } else if (security === SecurityLevel.Moderate) {
      themes.push(PortTheme.Trading, PortTheme.Fishing, PortTheme.Salvage, PortTheme.Pirate);
    } else {
      themes.push(PortTheme.Tropical, PortTheme.Resort, PortTheme.Fishing, PortTheme.Trading, PortTheme.Research);
    }
    if (biome === BiomeType.Arctic) themes.push(PortTheme.Arctic);
    if (biome === BiomeType.Volcanic || biome === BiomeType.Hell) themes.push(PortTheme.Volcanic);
    if (biome === BiomeType.GarbagePatch) themes.push(PortTheme.Salvage);
    return themes.length > 0 ? themes : [PortTheme.Trading];
  }

  private getMarketSpecialties(biome: BiomeType, rng: () => number): string[] {
    const specialties: string[] = [];
    switch (biome) {
      case BiomeType.Tropical:
      case BiomeType.SubTropical:
        specialties.push("tropical_fish", "coconut", "tropical_wood");
        break;
      case BiomeType.Arctic:
        specialties.push("ice_fish", "blubber", "ice_crystal");
        break;
      case BiomeType.Volcanic:
      case BiomeType.Hell:
        specialties.push("volcanic_ore", "obsidian", "lava_fish");
        break;
      case BiomeType.CoralReef:
        specialties.push("coral_fish", "pearl", "coral_fragment");
        break;
      case BiomeType.GarbagePatch:
        specialties.push("scrap_metal", "rare_junk", "plastic");
        break;
      case BiomeType.DeepOcean:
        specialties.push("deep_sea_fish", "abyssal_pearl", "rare_ore");
        break;
      default:
        specialties.push("common_fish", "wood", "metal_scrap");
    }
    return specialties;
  }

  private getServices(size: PortSize): PortService[] {
    const services: PortService[] = [PortService.Trading, PortService.Inn];
    if (size >= PortSize.Small) {
      services.push(PortService.Fishing, PortService.Supplies, PortService.Licenses);
    }
    if (size >= PortSize.Medium) {
      services.push(PortService.Shipyard, PortService.HullModification, PortService.Storage);
    }
    return services;
  }

  private getResourceType(biome: BiomeType, rng: () => number): string {
    const resources: Record<BiomeType, string[]> = {
      [BiomeType.Lake]: ["freshwater_fish", "reed", "clay"],
      [BiomeType.Arctic]: ["ice", "blubber", "arctic_fish"],
      [BiomeType.Desert]: ["sand", "cactus", "desert_ore"],
      [BiomeType.BorealForest]: ["wood", "pine_cone", "berry"],
      [BiomeType.Tropical]: ["tropical_wood", "coconut", "tropical_fish"],
      [BiomeType.SubTropical]: ["wood", "fruit", "fish"],
      [BiomeType.Freshwater]: ["freshwater_fish", "reed", "clay"],
      [BiomeType.Ocean]: ["saltwater_fish", "seaweed", "shellfish"],
      [BiomeType.DeepOcean]: ["deep_sea_fish", "abyssal_ore", "pearl"],
      [BiomeType.CoralReef]: ["coral_fragment", "reef_fish", "pearl"],
      [BiomeType.KelpForest]: ["kelp", "kelp_fish", "sea_urchin"],
      [BiomeType.Volcanic]: ["obsidian", "volcanic_ore", "lava_fish"],
      [BiomeType.GarbagePatch]: ["scrap_metal", "plastic", "rare_junk"],
      [BiomeType.Hell]: ["hellstone", "demon_scale", "lava_fish"],
    };
    const pool = resources[biome] ?? ["wood", "fish"];
    return pool[Math.floor(rng() * pool.length)];
  }
}
