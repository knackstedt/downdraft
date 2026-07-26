// ─── Lifecycle: init, tick, dispose, and all exported data functions ──

import {
  Camera,
  createFireEmitter, createLogger, createSmokeEmitter,
  GameWorld, MeshBuilder, ParticleSystem, Scene, TelemetryCollector,
  World,
  type RenderData, type RenderEntityData
} from "@downdraft/core";
import { canCraft, CraftingPlugin, executeCraft, getUnlockedRecipes, unlockRecipesForTier } from "../plugins/crafting-plugin.ts";
import {
  createGrid, getGridStateForUI,
  GridInventory,
  InventoryPlugin,
  PLAYER_INV_HEIGHT, PLAYER_INV_WIDTH,
} from "../plugins/inventory-plugin.ts";
import { getItem } from "../plugins/items.ts";
import { CRAFTING_TIER_RECIPES } from "../plugins/recipes.ts";

import { createMcpPlugin } from "@downdraft/plugin-mcp";
import {
  addXP,
  Animal,
  animalQuery,
  Buildable,
  buildableQuery,
  Debris,
  debrisQuery,
  FishingLine,
  Health, Hunger,
  Island,
  islandQuery,
  Oxygen,
  Pet,
  petQuery,
  Pirate,
  pirateQuery,
  Plant,
  plantQuery,
  Player,
  playerQuery,
  Port,
  portQuery,
  Progression,
  Ship,
  shipQuery,
  Temperature,
  Thirst,
  Wildlife,
  wildlifeQuery
} from "./components.ts";
import {
  ANIMAL_COUNT_PER_ISLAND,
  BiomeType,
  CAMERA_FREECAM_SPEED,
  CAMERA_THIRD_PERSON_DEFAULT,
  CameraMode,
  DAY_DURATION,
  FISH_SPEED,
  GAME_DIFFICULTY_NORMAL,
  ISLAND_COUNT,
  ISLAND_MAX_HEIGHT,
  ISLAND_MAX_RADIUS,
  ISLAND_MIN_HEIGHT,
  ISLAND_MIN_RADIUS,
  ISLAND_SPAWN_RANGE,
  KEY,
  NIGHT_END_FRAC,
  NIGHT_START_FRAC,
  PetType,
  PLANT_COUNT_PER_ISLAND,
  PlantStage,
  PLAYER_MAX_HEALTH, PLAYER_MAX_HUNGER,
  PLAYER_MAX_OXYGEN,
  PLAYER_MAX_THIRST,
  PLAYER_TEMP_NORM,
  PORT_COUNT,
  SHARK_SPEED,
  WATER_LEVEL,
  WeatherType,
  WildlifeState,
  XP_CRAFT,
  XP_PER_LEVEL,
  type IPCMeshData
} from "./constants.ts";
import { islandHeightAt } from "./helpers.ts";
import type { InputState } from "./input.ts";
import { createInputState, isKeyDown, setKey } from "./input.ts";
import { gameState } from "./state.ts";
import {
  animalSystem,
  buoyancySystem_,
  craftingSystem,
  debrisCollectionSystem,
  debrisDriftSystem,
  fishingSystem,
  petSystem,
  pirateSystem,
  plantSystem,
  playerMovementSystem,
  portMarketSystem,
  progressionSystem,
  shipBoardingSystem,
  shipControlSystem,
  shipIntegritySystem,
  shipIslandCollisionSystem,
  spoilageSystem,
  survivalSystem,
  toolSystem,
  waveSourceSystem,
  wildlifeAISystem,
} from "./systems.ts";
import { extractMeshFromField, generateVoxelField } from "./terrain.ts";
import { waterBuffer, waterPhysics } from "./water.ts";
import {
  rainCollectors,
  setCurrentTimeOfDay,
  setWeatherType,
  weatherIsRaining, weatherIsStormy,
  weatherState, weatherSystem
} from "./weather.ts";

const log = createLogger();

// ─── Lifecycle: init ──────────────────────────────────────

export function init(ctx: any) {
  log.info("ocean-survival", "╔══════════════════════════════════════════════╗");
  log.info("ocean-survival", "║   Ocean Survival — DownDraft Engine          ║");
  log.info("ocean-survival", "║   (parity with to-the-ocean game systems)    ║");
  log.info("ocean-survival", "╚══════════════════════════════════════════════╝");

  const ecsWorld = new World();
  gameState.ecsWorld = ecsWorld;
  const scene = new Scene("ocean-survival", ecsWorld);
  const gameWorld = new GameWorld(scene);
  gameState.gameWorld = gameWorld;

  const camera = new Camera();
  gameState.camera = camera;
  camera.setAspect(16, 9);
  camera.distance = 15;
  camera.orbit(0, 0.4);
  camera.setTarget(0, 1, 0);
  ecsWorld.setResource("camera", camera);

  const shipMesh = MeshBuilder.cube(2);
  ecsWorld.setResource("shipMesh", shipMesh);
  const sharkMesh = MeshBuilder.sphere(0.8, 12, 8);
  ecsWorld.setResource("sharkMesh", sharkMesh);
  const fishMesh = MeshBuilder.sphere(0.3, 8, 6);
  ecsWorld.setResource("fishMesh", fishMesh);
  const debrisMesh = MeshBuilder.cube(0.4);
  ecsWorld.setResource("debrisMesh", debrisMesh);
  const waterMesh = MeshBuilder.plane(200, 200, 1);
  ecsWorld.setResource("waterMesh", waterMesh);

  const inputState = createInputState();
  ecsWorld.setResource("inputState", inputState);
  ecsWorld.setResource("input", { keys: inputState.keys, pressed: inputState.pressed });
  ecsWorld.setResource("raft", { wood: 5 });
  ecsWorld.setResource("time", 0);
  ecsWorld.setResource("craftState", { lastRecipe: 0 });
  ecsWorld.setResource("pirateSpawnTimer", 0);
  ecsWorld.setResource("gameMode", { difficulty: GAME_DIFFICULTY_NORMAL, dayDuration: DAY_DURATION, pvp: false });

  // Spawn player
  const playerComps = new Map<number, unknown>();
  playerComps.set(Player.id, Player.create({ x: 0, y: 1, z: 0 }));
  playerComps.set(Health.id, Health.create({ current: PLAYER_MAX_HEALTH, max: PLAYER_MAX_HEALTH }));
  playerComps.set(Hunger.id, Hunger.create({ current: PLAYER_MAX_HUNGER, max: PLAYER_MAX_HUNGER }));
  playerComps.set(Thirst.id, Thirst.create({ current: PLAYER_MAX_THIRST, max: PLAYER_MAX_THIRST }));
  playerComps.set(Oxygen.id, Oxygen.create({ current: PLAYER_MAX_OXYGEN, max: PLAYER_MAX_OXYGEN }));
  playerComps.set(Temperature.id, Temperature.create({ current: PLAYER_TEMP_NORM }));
  playerComps.set(GridInventory.id, GridInventory.create({ grid: createGrid(PLAYER_INV_WIDTH, PLAYER_INV_HEIGHT) }));
  playerComps.set(Progression.id, Progression.create({ level: 1, xp: 0, craftingTier: 0, hullTier: 0, unlockedRecipes: [...(CRAFTING_TIER_RECIPES[0] ?? [])] }));
  gameState.playerEntity = ecsWorld.spawn(playerComps);

  // Spawn fishing line entity (singleton)
  const fishingComps = new Map<number, unknown>();
  fishingComps.set(FishingLine.id, FishingLine.create({ cast: false, timer: 0, waitTime: 0, hooked: false }));
  ecsWorld.spawn(fishingComps);

  // Spawn ship
  const shipComps = new Map<number, unknown>();
  shipComps.set(Ship.id, Ship.create({ x: 0, y: 0, z: 0, integrity: 100, maxIntegrity: 100 }));
  const shipEntity = ecsWorld.spawn(shipComps);
  gameState.shipEntity = shipEntity;

  // Spawn sharks
  for (let i = 0; i < 2; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 30;
    const wlComps = new Map<number, unknown>();
    wlComps.set(Wildlife.id, Wildlife.create({
      type: "shark",
      state: WildlifeState.Patrol,
      speed: SHARK_SPEED + Math.random() * 2,
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      y: WATER_LEVEL - 1,
      attackCooldown: 0,
      health: 50,
    }));
    ecsWorld.spawn(wlComps);
  }

  // Spawn fish
  for (let i = 0; i < 5; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 40;
    const wlComps = new Map<number, unknown>();
    wlComps.set(Wildlife.id, Wildlife.create({
      type: "fish",
      state: WildlifeState.Patrol,
      speed: FISH_SPEED,
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      y: WATER_LEVEL - 1,
      attackCooldown: 0,
      health: 10,
    }));
    ecsWorld.spawn(wlComps);
  }

  // Spawn islands — with overlap prevention
  gameState.playerSpawnX = 0;
  gameState.playerSpawnZ = 0;
  const placedIslands: { x: number; z: number; radius: number }[] = [];
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const radius = i === 0
      ? ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS) * 0.5
      : ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS);
    const height = ISLAND_MIN_HEIGHT + Math.random() * (ISLAND_MAX_HEIGHT - ISLAND_MIN_HEIGHT);
    const biomeRoll = Math.random();
    const biome = biomeRoll < 0.35 ? BiomeType.Tropical :
      biomeRoll < 0.60 ? BiomeType.Temperate :
      biomeRoll < 0.75 ? BiomeType.Arctic :
      biomeRoll < 0.90 ? BiomeType.Desert : BiomeType.Volcanic;

    // Find a non-overlapping position
    let angle = 0, dist = 0;
    let islandX = 0, islandZ = 0;
    if (i === 0) {
      angle = 0;
      dist = 0;
    } else {
      let attempts = 0;
      const minGap = 40; // minimum water gap between island shores
      do {
        angle = (i / ISLAND_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        dist = 150 + Math.random() * ISLAND_SPAWN_RANGE;
        islandX = Math.cos(angle) * dist;
        islandZ = Math.sin(angle) * dist;
        attempts++;
        if (attempts > 50) break;
      } while (placedIslands.some(prev => {
        const dx = islandX - prev.x;
        const dz = islandZ - prev.z;
        return Math.sqrt(dx * dx + dz * dz) < prev.radius + radius + minGap;
      }));
    }
    islandX = Math.cos(angle) * dist;
    islandZ = Math.sin(angle) * dist;
    const chunkX = Math.floor(islandX);
    const chunkZ = Math.floor(islandZ);

    log.info("terrain", `generating voxel field for island ${i + 1} (biome: ${BiomeType[biome]}, radius: ${radius.toFixed(0)}, pos: (${islandX.toFixed(0)}, ${islandZ.toFixed(0)}))...`);
    const voxelField = generateVoxelField(chunkX, chunkZ, radius, biome);
    const meshData = extractMeshFromField(voxelField, biome, 50000);
    log.info("terrain", `island ${i + 1} mesh: ${meshData.vertexCount} verts, ${meshData.indexCount} indices`);

    placedIslands.push({ x: islandX, z: islandZ, radius });

    const islandComps = new Map<number, unknown>();
    islandComps.set(Island.id, Island.create({
      x: islandX,
      z: islandZ,
      radius, height,
      hasTrees: Math.random() > 0.3,
      hasRocks: Math.random() > 0.5,
      visited: false,
      biome, chunkX, chunkZ,
      voxelField, meshData,
    }));
    const islandEntity = ecsWorld.spawn(islandComps);

    if (i === 0) {
      gameState.playerSpawnX = islandX + radius * 0.8;
      gameState.playerSpawnZ = islandZ;
    }

    if (i < PORT_COUNT) {
      const portComps = new Map<number, unknown>();
      portComps.set(Port.id, Port.create({
        x: islandX,
        z: islandZ,
        islandEntity: islandEntity as unknown as number,
        name: `Port-${i + 1}`,
        listings: [
          { item: "wood", buyPrice: 3, sellPrice: 2, supply: 100, priceModifier: 1.0 },
          { item: "raw_fish", buyPrice: 5, sellPrice: 4, supply: 50, priceModifier: 1.0 },
          { item: "planks", buyPrice: 8, sellPrice: 6, supply: 80, priceModifier: 1.0 },
          { item: "food", buyPrice: 4, sellPrice: 3, supply: 60, priceModifier: 1.0 },
        ],
      }));
      ecsWorld.spawn(portComps);
    }

    for (let a = 0; a < ANIMAL_COUNT_PER_ISLAND; a++) {
      const aAngle = Math.random() * Math.PI * 2;
      const aDist = Math.random() * radius * 0.7;
      const ax = islandX + Math.cos(aAngle) * aDist;
      const az = islandZ + Math.sin(aAngle) * aDist;
      const species = ["chicken", "goat", "sheep"][Math.floor(Math.random() * 3)];
      const productType = species === "chicken" ? "egg" : species === "goat" ? "milk" : "wool";
      const animalComps = new Map<number, unknown>();
      animalComps.set(Animal.id, Animal.create({
        x: ax, y: islandHeightAt({ x: islandX, z: islandZ, radius, height, voxelField }, ax, az),
        z: az, species, productType, islandEntity: islandEntity as unknown as number,
      }));
      ecsWorld.spawn(animalComps);
    }

    for (let p = 0; p < PLANT_COUNT_PER_ISLAND; p++) {
      const pAngle = Math.random() * Math.PI * 2;
      const pDist = Math.random() * radius * 0.7;
      const px = islandX + Math.cos(pAngle) * pDist;
      const pz = islandZ + Math.sin(pAngle) * pDist;
      const species = ["kelp", "tomato", "rice"][Math.floor(Math.random() * 3)];
      const plantComps = new Map<number, unknown>();
      plantComps.set(Plant.id, Plant.create({
        x: px, y: islandHeightAt({ x: islandX, z: islandZ, radius, height, voxelField }, px, pz),
        z: pz, species, islandEntity: islandEntity as unknown as number,
      }));
      ecsWorld.spawn(plantComps);
    }
  }

  // Move player to shore of first island
  const player = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
  if (player) {
    player.x = gameState.playerSpawnX;
    player.z = gameState.playerSpawnZ;
    player.y = 2;
    log.info("terrain", `player spawned near island at (${gameState.playerSpawnX.toFixed(1)}, ${gameState.playerSpawnZ.toFixed(1)})`);
  }

  // Reposition ship using getComponent (query doesn't work before systems are registered)
  const shipComp = ecsWorld.getComponent<typeof Ship.defaults>(shipEntity, Ship.id);
  if (shipComp) {
    shipComp.x = gameState.playerSpawnX + 5;
    shipComp.z = gameState.playerSpawnZ + 5;
  }

  // Spawn pet
  const petComps = new Map<number, unknown>();
  petComps.set(Pet.id, Pet.create({
    x: gameState.playerSpawnX + 2, y: 1, z: gameState.playerSpawnZ + 2,
    type: PetType.Cat, ownerId: 0,
  }));
  ecsWorld.spawn(petComps);

  // Spawn debris
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 20;
    const r = Math.random();
    const type = r < 0.4 ? "wood" : r < 0.7 ? "food" : "water";
    const debrisComps = new Map<number, unknown>();
    debrisComps.set(Debris.id, Debris.create({
      type,
      x: gameState.playerSpawnX + Math.cos(angle) * dist,
      y: WATER_LEVEL,
      z: gameState.playerSpawnZ + Math.sin(angle) * dist,
      collected: false,
    }));
    ecsWorld.spawn(debrisComps);
  }

  // Register plugin systems
  InventoryPlugin.register({
    registerSystem: (stage: number, fn: any) => ecsWorld.schedule.addSystem({ name: "grid-spoilage", stage, fn, queries: [] }),
    registerComponent: () => 0,
    registerResource: () => {},
    allocateSABChannel: () => new ArrayBuffer(0) as any,
    registerMigration: () => {},
    onDispose: () => {},
  } as any);
  CraftingPlugin.register({
    registerSystem: (stage: number, fn: any) => ecsWorld.schedule.addSystem({ name: "crafting-queue", stage, fn, queries: [] }),
    registerComponent: () => 0,
    registerResource: () => {},
    allocateSABChannel: () => new ArrayBuffer(0) as any,
    registerMigration: () => {},
    onDispose: () => {},
  } as any);

  ecsWorld.setResource("craftingStations", new Set<string>());
  ecsWorld.setResource("dayDuration", DAY_DURATION);
  ecsWorld.setResource("playerInventoryGrid", null);

  // Register systems in tick order
  ecsWorld.schedule.addSystem(weatherSystem);
  ecsWorld.schedule.addSystem(playerMovementSystem);
  ecsWorld.schedule.addSystem(shipControlSystem);
  ecsWorld.schedule.addSystem(waveSourceSystem);
  ecsWorld.schedule.addSystem(buoyancySystem_);
  ecsWorld.schedule.addSystem(survivalSystem);
  ecsWorld.schedule.addSystem(wildlifeAISystem);
  ecsWorld.schedule.addSystem(debrisCollectionSystem);
  ecsWorld.schedule.addSystem(shipIntegritySystem);
  ecsWorld.schedule.addSystem(shipBoardingSystem);
  ecsWorld.schedule.addSystem(fishingSystem);
  ecsWorld.schedule.addSystem(craftingSystem);
  ecsWorld.schedule.addSystem(spoilageSystem);
  ecsWorld.schedule.addSystem(shipIslandCollisionSystem);
  ecsWorld.schedule.addSystem(debrisDriftSystem);
  ecsWorld.schedule.addSystem(pirateSystem);
  ecsWorld.schedule.addSystem(portMarketSystem);
  ecsWorld.schedule.addSystem(animalSystem);
  ecsWorld.schedule.addSystem(plantSystem);
  ecsWorld.schedule.addSystem(petSystem);
  ecsWorld.schedule.addSystem(toolSystem);
  ecsWorld.schedule.addSystem(progressionSystem);

  ecsWorld.schedule.updateQueryArchetypes(ecsWorld.allArchetypes);

  // Particles
  const particles = new ParticleSystem({ maxParticlesPerEmitter: 2000 });
  gameState.particles = particles;
  particles.registerEmitter(createFireEmitter({ position: [0, 1.5, 0], emissionRate: 30 }));
  particles.registerEmitter(createSmokeEmitter({ position: [0, 2.5, 0], emissionRate: 10 }));

  // Telemetry
  gameState.telemetry = new TelemetryCollector(true);

  log.info("ocean-survival", "Player spawned at origin with full survival stats");
  log.info("ocean-survival", "Ship created (integrity: 100%)");
  log.info("ocean-survival", "2 sharks + 5 fish spawned");
  log.info("ocean-survival", "10 debris items scattered (wood/food/water)");
  log.info("ocean-survival", `${ISLAND_COUNT} islands generated in the surrounding ocean`);
  log.info("ocean-survival", `${PORT_COUNT} ports with dynamic market prices`);
  log.info("ocean-survival", `${ISLAND_COUNT * ANIMAL_COUNT_PER_ISLAND} animals (chickens, goats, sheep) on islands`);
  log.info("ocean-survival", `${ISLAND_COUNT * PLANT_COUNT_PER_ISLAND} plants (kelp, tomato, rice) on islands`);
  log.info("ocean-survival", "1 pet companion (cat) spawned near player");
  log.info("ocean-survival", "Pirates may spawn and attack your ship!");
  log.info("ocean-survival", "Fire + smoke particle emitters active");
  log.info("ocean-survival", "Weather: Clear, wind: 3 m/s");
  log.info("ocean-survival", "Controls:");
  log.info("ocean-survival", "  WASD = move (heading-based) | Mouse = look | Shift = run/throttle");
  log.info("ocean-survival", "  Space = jump | Ctrl+Space = dive underwater | Arrows = steer ship");
  log.info("ocean-survival", "  E = board/leave ship | Q = anchor | R = repair (needs wood)");
  log.info("ocean-survival", "  F = fish | C = craft (cycles recipes) | B = apply raft upgrade");
  log.info("ocean-survival", "  T = eat food | Y = trade at port");
  log.info("ocean-survival", "  G = gun (shoot pirates) | X = axe (chop trees on islands)");
  log.info("ocean-survival", "  V = shovel (dig for treasure) | H = harvest (animals/plants)");
  log.info("ocean-survival", "  J = water plant | P = feed pet");
  log.info("ocean-survival", "  M = toggle camera (1st/3rd/freecam) | F5 = noclip");
  log.info("ocean-survival", "  I = toggle inventory | 1-9,0 = hotbar slots | Scroll = zoom camera");
  log.info("ocean-survival", "  Terrain: volumetric voxel fields with marching cubes mesh extraction");
  log.info("ocean-survival", "  Biomes: Tropical, Temperate, Arctic, Desert, Volcanic");
  log.info("ocean-survival", "  Survival: manage hunger, thirst, oxygen, temperature");
  log.info("ocean-survival", "  Crafting: wood->planks->campfire->cook fish->raft upgrade");
  log.info("ocean-survival", "  Economy: sell fish at ports for coins, buy wood/supplies");
  log.info("ocean-survival", "  Progression: gain XP from fishing, crafting, harvesting, killing pirates");

  if (process.env.DOWNDRAFT_MCP === "1") {
    const mcpPlugin = createMcpPlugin({
      ecsWorld,
      scene,
      gameWorld,
      camera,
      enableTelemetry: true,
    });
    gameWorld.usePlugin(mcpPlugin);
    log.info("ocean-survival", "MCP server embedded — tools available via stdin/stdout JSON-RPC");
  }
}

// ─── Lifecycle: tick ──────────────────────────────────────

export function tick(ctx: any, dt: number) {
  const ecsWorld = gameState.ecsWorld!;
  const gameWorld = gameState.gameWorld!;
  const camera = gameState.camera!;
  const particles = gameState.particles!;

  gameState.frameCount++;
  gameState.fpsAccum += dt;
  gameState.fpsFrames++;
  if (gameState.fpsAccum >= 1) {
    gameState.fps = gameState.fpsFrames;
    gameState.fpsFrames = 0;
    gameState.fpsAccum = 0;
  }

  if (ctx?.input) {
    const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
    if (inputRes) {
      inputRes.keys = ctx.input.keys;
      for (const k of ctx.input.pressed) inputRes.pressed.add(k);
    }
    const inpState = ecsWorld.getResource<InputState>("inputState");
    if (inpState) {
      inpState.keys = ctx.input.keys;
      for (const k of ctx.input.pressed) inpState.pressed.add(k);
      if (ctx.input.keys) {
        for (const keyName of ctx.input.keys) {
          const keyCode = (KEY as Record<string, number>)[keyName] ?? (KEY as Record<string, number>)[keyName.toUpperCase()];
          if (keyCode !== undefined) setKey(inpState, keyCode, true);
        }
      }
      if (ctx.input.pressed) {
        for (const keyName of ctx.input.pressed) {
          const keyCode = (KEY as Record<string, number>)[keyName] ?? (KEY as Record<string, number>)[keyName.toUpperCase()];
          if (keyCode !== undefined) setKey(inpState, keyCode, true);
        }
      }
      if (ctx.input.mouseDX !== undefined) inpState.mouseDX += ctx.input.mouseDX;
      if (ctx.input.mouseDY !== undefined) inpState.mouseDY += ctx.input.mouseDY;
      if (ctx.input.wheel !== undefined) inpState.wheel += ctx.input.wheel;
      if (ctx.input.gamepadAxes) {
        for (let i = 0; i < 8; i++) {
          if (ctx.input.gamepadAxes[i] !== undefined) inpState.gamepadAxes[i] = ctx.input.gamepadAxes[i];
        }
      }
      if (ctx.input.lookHeading !== undefined) inpState.lookHeading = ctx.input.lookHeading;
      if (ctx.input.lookPitch !== undefined) inpState.lookPitch = ctx.input.lookPitch;
    }

    if (ctx.input.pressed.has("i")) {
      toggleInventory();
    }

    const numpadWeatherMap: Record<string, WeatherType> = {
      numpad0: WeatherType.Clear,
      numpad1: WeatherType.PartlyCloudy,
      numpad2: WeatherType.Overcast,
      numpad3: WeatherType.Rain,
      numpad4: WeatherType.Storm,
      numpad5: WeatherType.Fog,
      numpad6: WeatherType.Eclipse,
      numpad7: WeatherType.FullMoon,
      numpad8: WeatherType.HellStorm,
      numpad9: WeatherType.Snow,
    };
    const numpadTimeMap: Record<string, number> = {
      numpaddivide: 0.5,
      numpadmultiply: 0.75,
      numpadsubtract: 0.0,
    };
    for (const key of ctx.input.pressed) {
      const wt = numpadWeatherMap[key];
      if (wt !== undefined) {
        setWeatherType(wt);
        log.info("weather", `forced: ${WeatherType[wt]}`);
      }
      const tod = numpadTimeMap[key];
      if (tod !== undefined) {
        gameState.timeOfDay = tod;
        log.info("weather", `time set: ${(tod * 24).toFixed(1)}h`);
      }
    }
  }

  gameState.timeOfDay += dt / DAY_DURATION;
  if (gameState.timeOfDay >= 1) gameState.timeOfDay -= 1;

  const isNight = gameState.timeOfDay > NIGHT_START_FRAC || gameState.timeOfDay < NIGHT_END_FRAC;
  ecsWorld.setResource("isNight", isNight);
  ecsWorld.setResource("timeOfDay", gameState.timeOfDay);
  setCurrentTimeOfDay(gameState.timeOfDay);

  gameWorld.step(dt);

  const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (inputRes) inputRes.pressed.clear();
  const inpState = ecsWorld.getResource<InputState>("inputState");
  if (inpState) {
    inpState.pressed.clear();
    inpState.keyBits.fill(0);
  }

  if (ctx?.device && typeof ctx.device === "object") {
    particles.update(dt);
  }

  const timeRes = ecsWorld.getResource<number>("time") ?? 0;
  ecsWorld.setResource("time", timeRes + dt);

  // Camera follow
  const playerData = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
  if (playerData) {
    const camMode = playerData.cameraMode;
    const camZoom = inpState?.cameraZoom ?? CAMERA_THIRD_PERSON_DEFAULT;

    if (camMode === CameraMode.FirstPerson) {
      const eyeY = playerData.y + 1.6;
      const dirX = Math.sin(playerData.heading) * Math.cos(playerData.pitch);
      const dirY = Math.sin(playerData.pitch);
      const dirZ = -Math.cos(playerData.heading) * Math.cos(playerData.pitch);
      camera.setTarget(playerData.x + dirX * 0.1, eyeY + dirY * 0.1, playerData.z + dirZ * 0.1);
      camera.position = [playerData.x - dirX * 0.1, eyeY - dirY * 0.1, playerData.z - dirZ * 0.1];
    } else if (camMode === CameraMode.FreeCam) {
      if (inpState) {
        const speed = CAMERA_FREECAM_SPEED * dt;
        const cosH = Math.cos(playerData.heading), sinH = Math.sin(playerData.heading);
        if (isKeyDown(inpState, KEY.W)) { camera.position[0] += sinH * speed; camera.position[2] -= cosH * speed; }
        if (isKeyDown(inpState, KEY.S)) { camera.position[0] -= sinH * speed; camera.position[2] += cosH * speed; }
        if (isKeyDown(inpState, KEY.A)) { camera.position[0] -= cosH * speed; camera.position[2] -= sinH * speed; }
        if (isKeyDown(inpState, KEY.D)) { camera.position[0] += cosH * speed; camera.position[2] += sinH * speed; }
        if (isKeyDown(inpState, KEY.SPACE)) camera.position[1] += speed;
        if (isKeyDown(inpState, KEY.SHIFT)) camera.position[1] -= speed;
        camera.setTarget(
          camera.position[0] + Math.sin(playerData.heading) * Math.cos(playerData.pitch),
          camera.position[1] + Math.sin(playerData.pitch),
          camera.position[2] - Math.cos(playerData.heading) * Math.cos(playerData.pitch),
        );
      }
    } else {
      const eyeY = playerData.y + 1.6;
      const dirX = Math.sin(playerData.heading) * Math.cos(playerData.pitch);
      const dirY = Math.sin(playerData.pitch);
      const dirZ = -Math.cos(playerData.heading) * Math.cos(playerData.pitch);
      camera.setTarget(playerData.x + dirX * 2, eyeY + dirY * 2, playerData.z + dirZ * 2);
      camera.position = [
        playerData.x - dirX * camZoom,
        eyeY - dirY * camZoom + camZoom * 0.3,
        playerData.z - dirZ * camZoom,
      ];
    }
  }

  // Periodic status log
  if (gameState.frameCount % 300 === 0) {
    const ph = ecsWorld.getComponent<typeof Health.defaults>(gameState.playerEntity, Health.id);
    const hu = ecsWorld.getComponent<typeof Hunger.defaults>(gameState.playerEntity, Hunger.id);
    const th = ecsWorld.getComponent<typeof Thirst.defaults>(gameState.playerEntity, Thirst.id);
    const ox = ecsWorld.getComponent<typeof Oxygen.defaults>(gameState.playerEntity, Oxygen.id);
    const tp = ecsWorld.getComponent<typeof Temperature.defaults>(gameState.playerEntity, Temperature.id);
    const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(gameState.playerEntity, GridInventory.id);

    if (ph && hu && th && ox && tp) {
      log.debug("frame", `FPS:${gameState.fps} | HP:${ph.current.toFixed(0)}/${ph.max} | Hunger:${hu.current.toFixed(0)} | Thirst:${th.current.toFixed(0)} | O2:${ox.current.toFixed(0)} | Temp:${tp.current.toFixed(1)}C`);
      log.debug("frame", `Weather:${WeatherType[weatherState.type]} Wind:${weatherState.windSpeed.toFixed(1)}m/s Vis:${weatherState.visibility.toFixed(2)} Temp:${weatherState.ambientTemp.toFixed(1)}C Time:${(gameState.timeOfDay * 24).toFixed(1)}h${weatherState.isRareEvent ? " [RARE]" : ""}`);

      const rainCollectorCount = rainCollectors.size;
      let rainCollectorTotal = 0;
      for (const amt of rainCollectors.values()) rainCollectorTotal += amt;
      log.debug("weather-overlay", [
        `╔════════════════════════════════════════════╗`,
        `║  WEATHER OVERLAY                            ║`,
        `╠════════════════════════════════════════════╣`,
        `║  Type:       ${WeatherType[weatherState.type].padEnd(30)}║`,
        `║  Intensity:  ${(weatherState.intensity.toFixed(2)).padEnd(30)}║`,
        `║  Wind:       ${(weatherState.windSpeed.toFixed(1) + "m/s " + (Math.atan2(weatherState.windDirZ, weatherState.windDirX) * 180 / Math.PI).toFixed(0) + "°").padEnd(30)}║`,
        `║  Visibility: ${(weatherState.visibility.toFixed(2) + " (" + (weatherState.visibility * 100).toFixed(0) + "%)").padEnd(30)}║`,
        `║  Ambient:    ${(weatherState.ambientTemp.toFixed(1) + "°C").padEnd(30)}║`,
        `║  Duration:   ${(weatherState.duration.toFixed(0) + "s remaining").padEnd(30)}║`,
        `║  Rare Event: ${(weatherState.isRareEvent ? "YES" : "no").padEnd(30)}║`,
        `║  Raining:    ${(weatherIsRaining() ? "yes" : "no").padEnd(30)}║`,
        `║  Stormy:     ${(weatherIsStormy() ? "yes" : "no").padEnd(30)}║`,
        `║  Time:       ${((gameState.timeOfDay * 24).toFixed(1) + "h " + (isNight ? "(night)" : "(day)")).padEnd(30)}║`,
        `║  Rain Coll.: ${(rainCollectorCount + " collectors, " + rainCollectorTotal.toFixed(1) + " water").padEnd(30)}║`,
        `╠════════════════════════════════════════════╣`,
        `║  Numpad 0-9: Force weather                  ║`,
        `║  Numpad /: Noon  *: Evening  -: Midnight    ║`,
        `╚════════════════════════════════════════════╝`,
      ].join("\n"));
      if (inv) {
        const gridState = getGridStateForUI(inv.grid);
        const invStr = gridState.map((s: any) => `${s.itemId}x${s.quantity}`).join(", ") || "empty";
        log.debug("frame", `Inventory: ${invStr}`);
      }

      const prog = ecsWorld.getComponent<typeof Progression.defaults>(gameState.playerEntity, Progression.id);
      if (prog) {
        log.debug("frame", `Level: ${prog.level} | XP: ${prog.xp}/${XP_PER_LEVEL * prog.level} | Crafting Tier: ${prog.craftingTier}`);
      }

      if (ph.current <= 0 && playerData && !playerData.isDead) {
        log.info("game", "Player died — game over!");
      }
    }
  }
}

// ─── Lifecycle: dispose ───────────────────────────────────

export function dispose(ctx: any) {
  gameState.particles?.destroy();
  log.info("ocean-survival", "disposed");
}

// ─── Lifecycle: getWaterData ──────────────────────────────

export function getWaterData(): {
  patchSize: number;
  chunks: { originX: number; originZ: number; gridSize: number; heights: Float32Array }[];
} {
  const activeChunks = waterPhysics.getActiveChunks();
  const result = {
    patchSize: waterBuffer.getPatchSize(),
    chunks: activeChunks.map(c => ({
      originX: c.originX,
      originZ: c.originZ,
      gridSize: c.heights.length ** 0.5,
      heights: c.heights,
    })),
  };
  // Log when something looks wrong
  if (activeChunks.length === 0) {
    log.warn("water-bun", `0 active chunks!`);
  } else {
    let totalValid = 0;
    let totalCulled = 0;
    for (const c of activeChunks) {
      for (let i = 0; i < c.heights.length; i++) {
        if (c.heights[i] < -100) totalCulled++;
        else totalValid++;
      }
    }
    if (totalValid === 0) {
      log.warn("water-bun", `ALL heights culled! chunks=${activeChunks.length} culled=${totalCulled}`);
    }
  }
  return result;
}

// ─── Lifecycle: getMeshData ───────────────────────────────

export function getMeshData(): IPCMeshData[] {
  const meshes: IPCMeshData[] = [];
  const ecsWorld = gameState.ecsWorld!;

  islandQuery.updateArchetypes(ecsWorld.allArchetypes);

  islandQuery.iterate(gameState.frameCount, (_e, [islandRaw]) => {
    const island = islandRaw as typeof Island.defaults;
    if (!island.meshData || !island.meshData.verts) return;

    const indices = island.meshData.indices instanceof Uint32Array
      ? island.meshData.indices
      : new Uint32Array(island.meshData.indices);

    meshes.push({
      vertexCount: island.meshData.vertexCount,
      indexCount: island.meshData.indexCount,
      posX: island.x,
      posZ: island.z,
      verts: island.meshData.verts,
      indices,
    });
  });

  return meshes;
}

// ─── Lifecycle: getRenderData ─────────────────────────────

export function getRenderData(): RenderData {
  const entities: RenderEntityData[] = [];
  const camera = gameState.camera!;
  const fc = gameState.frameCount;

  playerQuery.iterate(fc, (_e, [playerRaw]) => {
    const player = playerRaw as typeof Player.defaults;
    if (!player.isDead) {
      entities.push({ type: 0, x: player.x, y: player.y, z: player.z, r: 0.2, g: 0.8, b: 0.2 });
    }
  });

  shipQuery.iterate(fc, (_e, [shipRaw]) => {
    const ship = shipRaw as typeof Ship.defaults;
    entities.push({ type: 1, x: ship.x, y: ship.y, z: ship.z, r: 0.6, g: 0.4, b: 0.2 });
  });

  wildlifeQuery.iterate(fc, (_e, [wlRaw]) => {
    const wl = wlRaw as typeof Wildlife.defaults;
    if (wl.type === "shark") {
      entities.push({ type: 2, x: wl.x, y: wl.y, z: wl.z, r: 0.3, g: 0.3, b: 0.5 });
    } else {
      entities.push({ type: 3, x: wl.x, y: wl.y, z: wl.z, r: 0.8, g: 0.6, b: 0.2 });
    }
  });

  debrisQuery.iterate(fc, (_e, [debrisRaw]) => {
    const debris = debrisRaw as typeof Debris.defaults;
    if (!debris.collected) {
      entities.push({
        type: 4, x: debris.x, y: debris.y, z: debris.z,
        r: debris.type === "wood" ? 0.5 : debris.type === "food" ? 0.9 : 0.3,
        g: debris.type === "wood" ? 0.3 : debris.type === "food" ? 0.7 : 0.5,
        b: debris.type === "wood" ? 0.1 : debris.type === "food" ? 0.2 : 0.9,
      });
    }
  });

  buildableQuery.iterate(fc, (_e, [bRaw]) => {
    const b = bRaw as typeof Buildable.defaults;
    entities.push({
      type: 7, x: b.x, y: b.y, z: b.z,
      r: b.type === "campfire" ? 0.9 : 0.5,
      g: b.type === "campfire" ? 0.5 : 0.4,
      b: b.type === "campfire" ? 0.1 : 0.3,
    });
  });

  pirateQuery.iterate(fc, (_e, [pirateRaw]) => {
    const pirate = pirateRaw as typeof Pirate.defaults;
    if (pirate.health > 0) {
      entities.push({ type: 8, x: pirate.x, y: pirate.y, z: pirate.z, r: 0.8, g: 0.1, b: 0.1 });
    }
  });

  portQuery.iterate(fc, (_e, [portRaw]) => {
    const port = portRaw as typeof Port.defaults;
    entities.push({ type: 9, x: port.x, y: 2, z: port.z, r: 0.9, g: 0.8, b: 0.1 });
  });

  animalQuery.iterate(fc, (_e, [animalRaw]) => {
    const animal = animalRaw as typeof Animal.defaults;
    entities.push({
      type: 10, x: animal.x, y: animal.y, z: animal.z,
      r: animal.species === "chicken" ? 0.9 : 0.6,
      g: animal.species === "chicken" ? 0.7 : 0.5,
      b: animal.species === "chicken" ? 0.2 : 0.3,
    });
  });

  plantQuery.iterate(fc, (_e, [plantRaw]) => {
    const plant = plantRaw as typeof Plant.defaults;
    const brightness = 0.3 + (plant.stage / PlantStage.Overripe) * 0.5;
    entities.push({ type: 11, x: plant.x, y: plant.y, z: plant.z, r: 0.2, g: brightness, b: 0.1 });
  });

  petQuery.iterate(fc, (_e, [petRaw]) => {
    const pet = petRaw as typeof Pet.defaults;
    entities.push({ type: 12, x: pet.x, y: pet.y, z: pet.z, r: 0.9, g: 0.5, b: 0.2 });
  });

  return {
    cameraPos: camera.position,
    cameraTarget: camera.target,
    entities,
  };
}

// ─── Lifecycle: getGameState ──────────────────────────────

export function getGameState(): { isDead: boolean; cause: string } {
  const ecsWorld = gameState.ecsWorld!;
  const player = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
  return {
    isDead: player?.isDead ?? false,
    cause: gameState.deathCause,
  };
}

// ─── Lifecycle: respawn ───────────────────────────────────

export function respawn() {
  const ecsWorld = gameState.ecsWorld!;
  const player = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
  if (!player) return;
  player.isDead = false;
  player.x = gameState.playerSpawnX; player.y = 2; player.z = gameState.playerSpawnZ;
  player.vx = 0; player.vy = 0; player.vz = 0;
  player.heading = 0; player.pitch = 0;
  player.onShip = false;
  player.isUnderwater = false;
  player.isSwimming = false;
  player.isSleeping = false;
  player.isNoclip = false;
  player.isRunning = false;
  player.isGrounded = true;
  player.isClimbing = false;
  player.isDiving = false;

  const health = ecsWorld.getComponent<typeof Health.defaults>(gameState.playerEntity, Health.id);
  if (health) health.current = health.max;
  const hunger = ecsWorld.getComponent<typeof Hunger.defaults>(gameState.playerEntity, Hunger.id);
  if (hunger) hunger.current = hunger.max;
  const thirst = ecsWorld.getComponent<typeof Thirst.defaults>(gameState.playerEntity, Thirst.id);
  if (thirst) thirst.current = thirst.max;
  const oxygen = ecsWorld.getComponent<typeof Oxygen.defaults>(gameState.playerEntity, Oxygen.id);
  if (oxygen) oxygen.current = oxygen.max;
  const temp = ecsWorld.getComponent<typeof Temperature.defaults>(gameState.playerEntity, Temperature.id);
  if (temp) temp.current = PLAYER_TEMP_NORM;

  gameState.deathCause = "";
  log.info("respawn", "player respawned");
}

// ─── Lifecycle: getInventoryState ─────────────────────────

export function getInventoryState(): string {
  const ecsWorld = gameState.ecsWorld!;
  const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(gameState.playerEntity, GridInventory.id);
  if (!inv) return JSON.stringify({ visible: gameState.inventoryVisible, width: 10, height: 6, slots: [], recipes: [], itemCounts: {} });

  const grid = inv.grid;
  const slots: { x: number; y: number; itemId: string; quantity: number; spoilPercent?: number; name?: string; category?: string; stackLimit?: number }[] = [];
  const itemCounts: Record<string, number> = {};
  const seen = new Set<unknown>();

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const stack = grid.slots[y][x];
      if (!stack) continue;
      if (seen.has(stack)) continue;
      seen.add(stack);

      const def = getItem(stack.itemId);
      const slot: any = {
        x, y,
        itemId: stack.itemId,
        quantity: stack.quantity,
        name: def?.name ?? stack.itemId,
        category: def?.category,
        stackLimit: def?.maxStack,
      };
      if (def?.spoilRate && def.spoilRate > 0) {
        slot.spoilPercent = stack.spoilProgress !== undefined
          ? (1 - stack.spoilProgress) * 100
          : 100;
      }
      slots.push(slot);
      itemCounts[stack.itemId] = (itemCounts[stack.itemId] ?? 0) + stack.quantity;
    }
  }

  const prog = ecsWorld.getComponent<typeof Progression.defaults>(gameState.playerEntity, Progression.id);
  const unlockedSet = new Set<string>(prog?.unlockedRecipes ?? []);
  if (prog) unlockRecipesForTier(prog.craftingTier, unlockedSet);
  const availableRecipes = getUnlockedRecipes(unlockedSet);

  const recipes = availableRecipes.map(r => ({
    id: r.id,
    name: r.name,
    inputs: r.inputs,
    output: r.output,
    needsFire: (r as any).needsFire ?? false,
  }));

  return JSON.stringify({
    visible: gameState.inventoryVisible,
    width: grid.width,
    height: grid.height,
    slots,
    recipes,
    itemCounts,
  });
}

export function toggleInventory() {
  gameState.inventoryVisible = !gameState.inventoryVisible;
}

export function craftByRecipeId(recipeId: string): void {
  const ecsWorld = gameState.ecsWorld!;
  const inv = ecsWorld.getComponent<typeof GridInventory.defaults>(gameState.playerEntity, GridInventory.id);
  if (!inv) return;
  const prog = ecsWorld.getComponent<typeof Progression.defaults>(gameState.playerEntity, Progression.id);
  if (!prog) return;

  const unlockedSet = new Set<string>(prog.unlockedRecipes);
  unlockRecipesForTier(prog.craftingTier, unlockedSet);
  const availableRecipes = getUnlockedRecipes(unlockedSet);
  const recipe = availableRecipes.find(r => r.id === recipeId);
  if (!recipe) {
    log.info("craft", `unknown recipe: ${recipeId}`);
    return;
  }

  let nearFire = false;
  if (recipe.needsFire) {
    buildableQuery.iterate(gameState.frameCount, (_be, [bRaw]) => {
      const b = bRaw as typeof Buildable.defaults;
      const player = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
      if (!player) return;
      const dx = b.x - player.x;
      const dz = b.z - player.z;
      if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
    });
  }

  const stations = ecsWorld.getResource<Set<string>>("craftingStations") ?? new Set<string>();
  if (recipe.station && !stations.has(recipe.station)) {
    log.info("craft", `cannot craft ${recipe.name} — needs ${recipe.station}`);
    return;
  }

  if (!canCraft(recipe, inv.grid)) {
    log.info("craft", `cannot craft ${recipe.name} — missing resources${recipe.needsFire && !nearFire ? " or need campfire nearby" : ""}`);
    return;
  }

  if (recipe.needsFire && !nearFire) {
    log.info("craft", `cannot craft ${recipe.name} — need campfire nearby`);
    return;
  }

  executeCraft(recipe, inv.grid);
  log.info("craft", `crafted ${recipe.output.quantity}x ${recipe.output.itemId}`);
  addXP(ecsWorld, gameState.playerEntity, XP_CRAFT);

  if (recipe.output.itemId === "campfire") {
    const player = ecsWorld.getComponent<typeof Player.defaults>(gameState.playerEntity, Player.id);
    if (player) {
      const comps = new Map<number, unknown>();
      comps.set(Buildable.id, Buildable.create({
        type: "campfire",
        x: player.x + 1, y: player.y, z: player.z + 1,
        health: 100,
      }));
      ecsWorld.spawn(comps);
      log.info("craft", "campfire placed near player");
    }
  }
}

// Re-export getWeatherVisual from weather.ts
export { getWeatherVisual } from "./weather.ts";
