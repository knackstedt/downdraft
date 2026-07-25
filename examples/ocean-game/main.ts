import {
  Camera,
  Component,
  createFireEmitter,
  createSmokeEmitter,
  GameWorld,
  MeshBuilder,
  ParticleSystem,
  query,
  Scene,
  Stage,
  system,
  TelemetryCollector,
  World,
  type Entity,
  type RenderData,
  type RenderEntityData,
} from "@downdraft/core";

// ─── Constants (parity with to-the-ocean constants.ts) ─────

const SIM_TICK_DT = 1 / 60;
const PLAYER_MAX_HEALTH = 100;
const PLAYER_MAX_HUNGER = 100;
const PLAYER_MAX_THIRST = 100;
const PLAYER_MAX_OXYGEN = 100;
const PLAYER_TEMP_MIN = 34;
const PLAYER_TEMP_MAX = 42;
const PLAYER_TEMP_NORM = 37;
const HUNGER_DECAY_RATE = 0.15;
const THIRST_DECAY_RATE = 0.2;
const OXYGEN_DRAIN_RATE = 2.5;
const OXYGEN_REGEN_RATE = 10;
const TEMP_DAMAGE_THRESHOLD_LOW = 35;
const TEMP_DAMAGE_THRESHOLD_HIGH = 39;
const TEMP_DAMAGE_RATE = 3;
const HUNGER_DAMAGE_RATE = 2;
const THIRST_DAMAGE_RATE = 3;
const HEALTH_REGEN_RATE = 0.5;
const PLAYER_WALK_SPEED = 4.5;
const PLAYER_SWIM_SPEED = 3.0;
const PLAYER_FALL_DAMAGE_THRESHOLD = 8;
const PLAYER_FALL_DAMAGE_RATE = 5;
const SHIP_MAX_SPEED = 12;
const SHIP_ACCEL = 2.0;
const SHIP_TURN_RATE = 0.8;
const SHIP_DRAG = 0.5;
const BUOYANCY_FORCE = 9.8;
const WATER_LEVEL = 0;
const WILDLIFE_SPAWN_RADIUS = 80;
const WILDLIFE_MAX_COUNT = 15;
const WILDLIFE_DESPAWN_RADIUS = 150;
const SHARK_SPEED = 4;
const SHARK_ATTACK_RANGE = 2;
const SHARK_ATTACK_DAMAGE = 20;
const SHARK_ATTACK_COOLDOWN = 3;
const SHARK_HUNT_RANGE = 15;
const SHARK_DESPAWN_RANGE = 30;
const FISH_SPEED = 1.5;
const WEATHER_TRANSITION_INTERVAL = 120;
const DAY_DURATION = 600;
const NIGHT_START_FRAC = 0.75;
const NIGHT_END_FRAC = 0.25;

// Fishing
const FISHING_CAST_RANGE = 15;
const FISHING_MIN_WAIT = 2;
const FISHING_MAX_WAIT = 8;
const FISHING_CATCH_CHANCE = 0.7;

// Crafting
const CRAFT_PLANK_COST = 1; // 1 wood -> 2 planks
const CRAFT_CAMPFIRE_COST = 3; // 3 planks -> 1 campfire
const CRAFT_SAIL_COST = 5; // 5 planks -> 1 sail
const CRAFT_RAFT_COST = 8; // 8 planks -> raft upgrade
const COOK_FISH_TIME = 5;

// Islands
const ISLAND_COUNT = 6;
const ISLAND_MIN_RADIUS = 8;
const ISLAND_MAX_RADIUS = 25;
const ISLAND_MIN_HEIGHT = 2;
const ISLAND_MAX_HEIGHT = 8;
const ISLAND_SPAWN_RANGE = 120;
const ISLAND_BEACH_LEVEL = 0.5;

// Inventory
const INV_MAX_SLOTS = 20;
const SPOILAGE_RATE = 0.01; // per game hour

// Ship boarding
const BOARD_RANGE = 3;
const REPAIR_RATE = 10; // integrity per second
const REPAIR_WOOD_COST = 1; // wood per repair tick

enum WeatherType {
  Clear = 0,
  Cloudy = 1,
  Rain = 2,
  Storm = 3,
  Fog = 4,
}

enum WildlifeState {
  Patrol = 0,
  Hunt = 1,
  Flee = 2,
}

// ─── Game Components ───────────────────────────────────────

const Health = Component.register("Health", {
  current: PLAYER_MAX_HEALTH,
  max: PLAYER_MAX_HEALTH,
  regenRate: HEALTH_REGEN_RATE,
});

const Hunger = Component.register("Hunger", {
  current: PLAYER_MAX_HUNGER,
  max: PLAYER_MAX_HUNGER,
  decayRate: HUNGER_DECAY_RATE,
});

const Thirst = Component.register("Thirst", {
  current: PLAYER_MAX_THIRST,
  max: PLAYER_MAX_THIRST,
  decayRate: THIRST_DECAY_RATE,
});

const Oxygen = Component.register("Oxygen", {
  current: PLAYER_MAX_OXYGEN,
  max: PLAYER_MAX_OXYGEN,
});

const Temperature = Component.register("Temperature", {
  current: PLAYER_TEMP_NORM,
});

const Player = Component.register("Player", {
  x: 0, y: 1, z: 0,
  vx: 0, vy: 0, vz: 0,
  heading: 0, pitch: 0,
  onShip: false,
  isUnderwater: false,
  isSwimming: false,
  isSleeping: false,
  isDead: false,
  bodyHeading: 0,
});

const Ship = Component.register("Ship", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  heading: 0,
  throttle: 0,
  steering: 0,
  speed: 0,
  integrity: 100,
  maxIntegrity: 100,
  anchorX: NaN,
  anchorZ: NaN,
});

const Wildlife = Component.register("Wildlife", {
  x: 0, y: 0, z: 0,
  vx: 0, vz: 0,
  type: "shark" as string,
  state: WildlifeState.Patrol,
  speed: SHARK_SPEED,
  attackCooldown: 0,
  health: 50,
});

const Debris = Component.register("Debris", {
  type: "wood" as string,
  x: 0, y: 0, z: 0,
  collected: false,
});

const Inventory = Component.register("Inventory", {
  slots: [] as { item: string; count: number; spoil: number }[],
});

const Island = Component.register("Island", {
  x: 0, z: 0,
  radius: 10,
  height: 5,
  hasTrees: true,
  hasRocks: true,
  visited: false,
});

const Buildable = Component.register("Buildable", {
  type: "campfire" as string,
  x: 0, y: 0, z: 0,
  health: 100,
});

const FishingLine = Component.register("FishingLine", {
  cast: false,
  timer: 0,
  waitTime: 0,
  hooked: false,
});

// ─── Queries ───────────────────────────────────────────────

const playerQuery = query(Player.id, Health.id, Hunger.id, Thirst.id, Oxygen.id, Temperature.id);
const playerInvQuery = query(Player.id, Inventory.id);
const shipQuery = query(Ship.id);
const wildlifeQuery = query(Wildlife.id);
const debrisQuery = query(Debris.id);
const islandQuery = query(Island.id);
const buildableQuery = query(Buildable.id);
const fishingQuery = query(FishingLine.id);

// ─── Inventory helpers ──────────────────────────────────────

function invAdd(inv: { item: string; count: number; spoil: number }[], item: string, count: number): boolean {
  for (const s of inv) {
    if (s.item === item && s.count > 0) {
      s.count += count;
      return true;
    }
  }
  if (inv.length < INV_MAX_SLOTS) {
    inv.push({ item, count, spoil: 1.0 });
    return true;
  }
  return false;
}

function invRemove(inv: { item: string; count: number; spoil: number }[], item: string, count: number): boolean {
  for (const s of inv) {
    if (s.item === item && s.count >= count) {
      s.count -= count;
      if (s.count <= 0) {
        const idx = inv.indexOf(s);
        if (idx >= 0) inv.splice(idx, 1);
      }
      return true;
    }
  }
  return false;
}

function invCount(inv: { item: string; count: number; spoil: number }[], item: string): number {
  for (const s of inv) {
    if (s.item === item) return s.count;
  }
  return 0;
}

// ─── Island helpers ─────────────────────────────────────────

function islandHeightAt(island: { x: number; z: number; radius: number; height: number }, px: number, pz: number): number {
  const dx = px - island.x;
  const dz = pz - island.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > island.radius) return -1; // underwater / no terrain
  const t = dist / island.radius;
  // Smooth dome: height peaks at center, fades to 0 at edge
  const h = island.height * Math.max(0, 1 - t * t);
  return Math.max(0, h);
}

function isOnIsland(px: number, pz: number): { onLand: boolean; groundY: number } {
  let bestY = -1;
  islandQuery.iterate(frameCount, (_e, [island]) => {
    const h = islandHeightAt(island, px, pz);
    if (h > bestY) bestY = h;
  });
  if (bestY < 0) return { onLand: false, groundY: -1 };
  return { onLand: true, groundY: bestY };
}

// ─── Game Systems (tick order matches to-the-ocean Simulation.tick) ──

// 1. WeatherSystem — weather transitions, wind, visibility, temperature
const weatherState = {
  type: WeatherType.Clear,
  intensity: 0,
  windSpeed: 3,
  windDirX: 1,
  windDirZ: 0,
  visibility: 1.0,
  ambientTemp: 22,
  transitionTimer: 0,
};

const weatherSystem = system("weather", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  weatherState.transitionTimer += dt;
  if (weatherState.transitionTimer >= WEATHER_TRANSITION_INTERVAL) {
    weatherState.transitionTimer = 0;
    const r = Math.random();
    if (r < 0.4) weatherState.type = WeatherType.Clear;
    else if (r < 0.7) weatherState.type = WeatherType.Cloudy;
    else if (r < 0.85) weatherState.type = WeatherType.Rain;
    else if (r < 0.95) weatherState.type = WeatherType.Storm;
    else weatherState.type = WeatherType.Fog;
  }

  const targetWind = weatherState.type === WeatherType.Storm ? 25 :
    weatherState.type === WeatherType.Rain ? 12 :
    weatherState.type === WeatherType.Cloudy ? 6 : 3;
  weatherState.windSpeed += (targetWind - weatherState.windSpeed) * 0.01;

  const targetVis = weatherState.type === WeatherType.Fog ? 0.3 :
    weatherState.type === WeatherType.Storm ? 0.5 :
    weatherState.type === WeatherType.Rain ? 0.7 : 1.0;
  weatherState.visibility += (targetVis - weatherState.visibility) * 0.02;

  const targetTemp = weatherState.type === WeatherType.Storm ? 15 :
    weatherState.type === WeatherType.Rain ? 18 :
    weatherState.type === WeatherType.Clear ? 26 : 22;
  weatherState.ambientTemp += (targetTemp - weatherState.ambientTemp) * 0.005;

  const windAngle = ctx.tick * 0.001;
  weatherState.windDirX = Math.cos(windAngle);
  weatherState.windDirZ = Math.sin(windAngle);
}, { queries: [] });

// 2. PlayerMovementSystem — WASD, swimming, buoyancy, island collision, ship following
const playerMovementSystem = system("player-movement", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string> }>("input");
  playerQuery.iterate(ctx.tick, (entity, [player, health, hunger, thirst, oxygen, temp]) => {
    if (player.isDead) return;

    // If on ship, follow ship position
    if (player.onShip) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        player.x = ship.x;
        player.z = ship.z;
        player.y = ship.y + 1;
        player.heading = ship.heading;
      });
    }

    const island = isOnIsland(player.x, player.z);
    const onLand = island.onLand && island.groundY > ISLAND_BEACH_LEVEL;
    const inWater = !onLand && player.y < WATER_LEVEL + 0.5;
    const speed = onLand ? PLAYER_WALK_SPEED : inWater ? PLAYER_SWIM_SPEED : PLAYER_WALK_SPEED;

    let mx = 0, mz = 0;
    if (input?.keys.has("w")) mz -= 1;
    if (input?.keys.has("s")) mz += 1;
    if (input?.keys.has("a")) mx -= 1;
    if (input?.keys.has("d")) mx += 1;

    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) { mx /= len; mz /= len; }

    player.vx = mx * speed;
    player.vz = mz * speed;

    const newX = player.x + player.vx * dt;
    const newZ = player.z + player.vz * dt;

    // Check island collision at new position
    const newIsland = isOnIsland(newX, newZ);
    if (newIsland.onLand && newIsland.groundY > ISLAND_BEACH_LEVEL) {
      player.x = newX;
      player.z = newZ;
      player.y = newIsland.groundY;
    } else if (!onLand) {
      // In water — allow movement
      player.x = newX;
      player.z = newZ;
    } else {
      // Trying to walk off island into water — allow it
      player.x = newX;
      player.z = newZ;
    }

    if (mx !== 0 || mz !== 0) {
      player.heading = Math.atan2(mx, -mz);
      player.bodyHeading = player.heading;
    }

    player.isSwimming = inWater;
    player.isUnderwater = player.y < WATER_LEVEL - 0.5;

    // Vertical movement: on land = ground height, in water = buoyancy
    if (onLand) {
      player.vy = 0;
      player.y = island.groundY;
    } else if (inWater) {
      player.vy = BUOYANCY_FORCE * 0.3;
      player.y += player.vy * dt;
      if (player.y > WATER_LEVEL + 0.5) player.y = WATER_LEVEL + 0.5;
    } else {
      player.vy -= BUOYANCY_FORCE * dt;
      player.y += player.vy * dt;
      if (player.y < WATER_LEVEL) player.y = WATER_LEVEL;
    }
  });
}, { queries: [playerQuery] });

// 3. ShipControlSystem — throttle, steering, drag (parity with BoatSystem.controlTick)
const shipControlSystem = system("ship-control", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string> }>("input");
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (input?.keys.has("shift")) ship.throttle = Math.min(1, ship.throttle + dt * 0.5);
    else ship.throttle = Math.max(0, ship.throttle - dt * 0.3);

    if (input?.keys.has("arrowleft")) ship.steering = -1;
    else if (input?.keys.has("arrowright")) ship.steering = 1;
    else ship.steering *= 0.8;

    const targetSpeed = ship.throttle * SHIP_MAX_SPEED;
    ship.speed += (targetSpeed - ship.speed) * SHIP_ACCEL * dt;
    ship.speed *= (1 - SHIP_DRAG * dt);

    ship.heading += ship.steering * SHIP_TURN_RATE * dt * (ship.speed / SHIP_MAX_SPEED);

    ship.vx = Math.sin(ship.heading) * ship.speed;
    ship.vz = Math.cos(ship.heading) * ship.speed;
    ship.x += ship.vx * dt;
    ship.z += ship.vz * dt;

    if (!isNaN(ship.anchorX)) {
      const adx = ship.anchorX - ship.x;
      const adz = ship.anchorZ - ship.z;
      ship.x += adx * 0.5 * dt;
      ship.z += adz * 0.5 * dt;
    }
  });
}, { queries: [shipQuery] });

// 4. BuoyancySystem — ship buoyancy + gravity (parity with BuoyancySystem.tick)
const buoyancySystem = system("buoyancy", Stage.Physics, (ctx) => {
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    ship.y = WATER_LEVEL + Math.sin(ctx.tick * 0.05) * 0.2;
  });
}, { queries: [shipQuery] });

// 5. SurvivalSystem — hunger, thirst, oxygen, temperature, damage (parity with SurvivalSystem.tick)
const survivalSystem = system("survival", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  playerQuery.iterate(ctx.tick, (entity, [player, health, hunger, thirst, oxygen, temp]) => {
    if (player.isDead) return;

    hunger.current = Math.max(0, hunger.current - hunger.decayRate * dt);
    thirst.current = Math.max(0, thirst.current - thirst.decayRate * dt);

    if (player.isUnderwater) {
      oxygen.current = Math.max(0, oxygen.current - OXYGEN_DRAIN_RATE * dt);
    } else {
      oxygen.current = Math.min(oxygen.max, oxygen.current + OXYGEN_REGEN_RATE * dt);
    }

    const targetTemp = weatherState.ambientTemp + (player.isSwimming ? -2 : 0);
    temp.current += (targetTemp - temp.current) * 0.01 * dt;
    temp.current = Math.max(PLAYER_TEMP_MIN, Math.min(PLAYER_TEMP_MAX, temp.current));

    let damage = 0;
    if (hunger.current <= 0) damage += HUNGER_DAMAGE_RATE * dt;
    if (thirst.current <= 0) damage += THIRST_DAMAGE_RATE * dt;
    if (oxygen.current <= 0) damage += 10 * dt;
    if (temp.current < TEMP_DAMAGE_THRESHOLD_LOW) damage += TEMP_DAMAGE_RATE * dt;
    if (temp.current > TEMP_DAMAGE_THRESHOLD_HIGH) damage += TEMP_DAMAGE_RATE * dt;

    if (damage > 0) {
      health.current = Math.max(0, health.current - damage);
    } else if (hunger.current > 30 && thirst.current > 30 && !player.isUnderwater) {
      health.current = Math.min(health.max, health.current + health.regenRate * dt);
    }

    if (health.current <= 0 && !player.isDead) {
      player.isDead = true;
      const cause = oxygen.current <= 0 ? "drowning" :
        hunger.current <= 0 ? "starvation" :
        thirst.current <= 0 ? "dehydration" :
        temp.current < TEMP_DAMAGE_THRESHOLD_LOW ? "hypothermia" :
        temp.current > TEMP_DAMAGE_THRESHOLD_HIGH ? "hyperthermia" : "unknown";
      console.log(`[survival] player died from ${cause}`);
    }
  });
}, { queries: [playerQuery] });

// 6. WildlifeAISystem — shark/fish AI (parity with WildlifeManager.tick)
const wildlifeAISystem = system("wildlife-ai", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  let playerX = 0, playerZ = 0, playerAlive = false;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    playerX = player.x; playerZ = player.z; playerAlive = !player.isDead;
  });

  wildlifeQuery.iterate(ctx.tick, (entity, [wl]) => {
    wl.attackCooldown = Math.max(0, wl.attackCooldown - dt);

    const dx = playerX - wl.x;
    const dz = playerZ - wl.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (wl.type === "shark") {
      if (playerAlive && dist < SHARK_HUNT_RANGE && wl.state === WildlifeState.Patrol) {
        wl.state = WildlifeState.Hunt;
      } else if (dist > SHARK_DESPAWN_RANGE && wl.state === WildlifeState.Hunt) {
        wl.state = WildlifeState.Patrol;
      }

      if (wl.state === WildlifeState.Hunt && playerAlive) {
        const angle = Math.atan2(dx, dz);
        wl.vx = Math.sin(angle) * wl.speed;
        wl.vz = Math.cos(angle) * wl.speed;
        wl.x += wl.vx * dt;
        wl.z += wl.vz * dt;

        if (dist < SHARK_ATTACK_RANGE && wl.attackCooldown <= 0) {
          wl.attackCooldown = SHARK_ATTACK_COOLDOWN;
          playerQuery.iterate(ctx.tick, (pe, [player, health]) => {
            if (!player.isDead) {
              health.current = Math.max(0, health.current - SHARK_ATTACK_DAMAGE);
              console.log(`[shark] attacked player! Health: ${health.current.toFixed(0)}`);
            }
          });
        }
      } else {
        wl.vx *= 0.95;
        wl.vz *= 0.95;
        wl.x += wl.vx * dt;
        wl.z += wl.vz * dt;
      }
    } else if (wl.type === "fish") {
      wl.vx = Math.sin(ctx.tick * 0.02 + wl.x) * FISH_SPEED;
      wl.vz = Math.cos(ctx.tick * 0.02 + wl.z) * FISH_SPEED;
      wl.x += wl.vx * dt;
      wl.z += wl.vz * dt;
    }

    wl.y = WATER_LEVEL - 1 + Math.sin(ctx.tick * 0.03 + wl.x) * 0.3;
  });
}, { queries: [wildlifeQuery, playerQuery] });

// 7. DebrisCollectionSystem — collect floating debris
const debrisCollectionSystem = system("debris-collection", Stage.Update, (ctx) => {
  let playerX = 0, playerZ = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    playerX = player.x; playerZ = player.z;
  });

  debrisQuery.iterate(ctx.tick, (entity, [debris]) => {
    if (debris.collected) return;
    const dx = debris.x - playerX;
    const dz = debris.z - playerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 2) {
      debris.collected = true;
      console.log(`[debris] collected ${debris.type}`);

      // Add to player inventory
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        if (debris.type === "food") {
          invAdd(inv.slots, "food", 1);
        } else if (debris.type === "water") {
          // Water is consumed immediately
          playerQuery.iterate(ctx.tick, (_pe, [, , , thirst]) => {
            thirst.current = Math.min(thirst.max, thirst.current + 30);
          });
        } else if (debris.type === "wood") {
          invAdd(inv.slots, "wood", 1);
        }
      });
    }
  });
}, { queries: [debrisQuery, playerQuery] });

// 8. ShipIntegritySystem — ship degradation (parity with structureIntegrity)
const shipIntegritySystem = system("ship-integrity", Stage.PostUpdate, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (weatherState.type === WeatherType.Storm) {
      ship.integrity = Math.max(0, ship.integrity - 0.5 * dt);
    } else {
      ship.integrity = Math.max(0, ship.integrity - 0.05 * dt);
    }

    if (ship.integrity < 30 && ctx.tick % 300 === 0) {
      console.log(`[ship] integrity low: ${ship.integrity.toFixed(0)}%`);
    }
    if (ship.integrity <= 0) {
      console.log("[ship] destroyed — game over!");
    }
  });
}, { queries: [shipQuery] });

// 9. ShipBoardingSystem — board/leave ship, anchor, repair
const shipBoardingSystem = system("ship-boarding", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    shipQuery.iterate(ctx.tick, (_se, [ship]) => {
      // Board/leave ship with E
      if (input.pressed.has("e")) {
        if (!player.onShip) {
          const dx = ship.x - player.x;
          const dz = ship.z - player.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < BOARD_RANGE) {
            player.onShip = true;
            console.log("[ship] boarded ship — WASD to steer, Shift to throttle");
          }
        } else {
          player.onShip = false;
          player.x = ship.x + 2;
          player.z = ship.z + 2;
          console.log("[ship] left ship");
        }
      }

      // Anchor with Q
      if (input.pressed.has("q") && player.onShip) {
        if (isNaN(ship.anchorX)) {
          ship.anchorX = ship.x;
          ship.anchorZ = ship.z;
          console.log("[ship] anchor dropped");
        } else {
          ship.anchorX = NaN;
          ship.anchorZ = NaN;
          console.log("[ship] anchor raised");
        }
      }

      // Repair with R
      if (input.keys.has("r") && player.onShip && ship.integrity < ship.maxIntegrity) {
        if (invRemove(inv.slots, "wood", 1)) {
          ship.integrity = Math.min(ship.maxIntegrity, ship.integrity + REPAIR_RATE * dt);
          if (ctx.tick % 60 === 0) {
            console.log(`[ship] repaired to ${ship.integrity.toFixed(0)}%`);
          }
        }
      }
    });
  });
}, { queries: [playerInvQuery, shipQuery] });

// 10. FishingSystem — cast line, wait, catch fish
const fishingSystem = system("fishing", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    fishingQuery.iterate(ctx.tick, (_fe, [line]) => {
      // Cast/reel with F
      if (input.pressed.has("f")) {
        if (!line.cast) {
          // Cast line — must be in water or on ship
          const inWater = player.y < WATER_LEVEL + 1 || player.onShip;
          if (inWater) {
            line.cast = true;
            line.hooked = false;
            line.timer = 0;
            line.waitTime = FISHING_MIN_WAIT + Math.random() * (FISHING_MAX_WAIT - FISHING_MIN_WAIT);
            console.log("[fishing] line cast...");
          }
        } else {
          // Reel in
          if (line.hooked) {
            if (Math.random() < FISHING_CATCH_CHANCE) {
              invAdd(inv.slots, "raw_fish", 1);
              console.log("[fishing] caught a fish!");
            } else {
              console.log("[fishing] the fish got away...");
            }
          } else {
            console.log("[fishing] reeled in empty");
          }
          line.cast = false;
          line.hooked = false;
        }
      }

      // Update fishing timer
      if (line.cast && !line.hooked) {
        line.timer += dt;
        if (line.timer >= line.waitTime) {
          line.hooked = true;
          console.log("[fishing] something hooked! Press F to reel in");
        }
      }
    });
  });
}, { queries: [playerInvQuery, fishingQuery] });

// 11. CraftingSystem — craft items from resources
const craftingSystem = system("crafting", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    // C = craft menu (cycles through recipes)
    if (input.pressed.has("c")) {
      const craftState = ctx.world.getResource<{ lastRecipe: number }>("craftState") ?? { lastRecipe: 0 };
      const recipes = [
        { name: "planks", input: { wood: CRAFT_PLANK_COST }, output: { item: "planks", count: 2 } },
        { name: "campfire", input: { planks: CRAFT_CAMPFIRE_COST }, output: { item: "campfire", count: 1 } },
        { name: "sail", input: { planks: CRAFT_SAIL_COST }, output: { item: "sail", count: 1 } },
        { name: "cooked_fish", input: { raw_fish: 1 }, output: { item: "cooked_fish", count: 1 }, needsFire: true },
        { name: "raft_upgrade", input: { planks: CRAFT_RAFT_COST }, output: { item: "raft_upgrade", count: 1 } },
      ];
      const recipe = recipes[craftState.lastRecipe % recipes.length];
      craftState.lastRecipe = (craftState.lastRecipe + 1) % recipes.length;
      ctx.world.setResource("craftState", craftState);

      // Check if near campfire for cooking
      let nearFire = false;
      if (recipe.needsFire) {
        buildableQuery.iterate(ctx.tick, (_be, [b]) => {
          const dx = b.x - player.x;
          const dz = b.z - player.z;
          if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
        });
      }

      // Check ingredients
      let canCraft = true;
      for (const [item, count] of Object.entries(recipe.input)) {
        if (invCount(inv.slots, item) < count) canCraft = false;
      }
      if (recipe.needsFire && !nearFire) canCraft = false;

      if (canCraft) {
        for (const [item, count] of Object.entries(recipe.input)) {
          invRemove(inv.slots, item, count);
        }
        invAdd(inv.slots, recipe.output.item, recipe.output.count);
        console.log(`[craft] crafted ${recipe.output.count}x ${recipe.output.item}`);

        // Place campfire in world
        if (recipe.output.item === "campfire") {
          const comps = new Map<number, unknown>();
          comps.set(Buildable.id, Buildable.create({
            type: "campfire",
            x: player.x + 1,
            y: player.y,
            z: player.z + 1,
            health: 100,
          }));
          ecsWorld.spawn(comps);
          console.log("[craft] campfire placed near player");
        }
      } else {
        console.log(`[craft] cannot craft ${recipe.name} — missing resources${recipe.needsFire && !nearFire ? " or need campfire nearby" : ""}`);
      }
    }

    // Place raft upgrade (improves ship speed)
    if (input.pressed.has("b") && invCount(inv.slots, "raft_upgrade") > 0) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        const dx = ship.x - player.x;
        const dz = ship.z - player.z;
        if (Math.sqrt(dx * dx + dz * dz) < BOARD_RANGE + 2) {
          invRemove(inv.slots, "raft_upgrade", 1);
          ship.maxIntegrity += 50;
          ship.integrity = ship.maxIntegrity;
          console.log(`[craft] raft upgraded! Ship integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
        }
      });
    }

    // Eat food
    if (input.pressed.has("t")) {
      if (invRemove(inv.slots, "cooked_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 35);
        });
        console.log("[food] ate cooked fish (+35 hunger)");
      } else if (invRemove(inv.slots, "raw_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 15);
        });
        console.log("[food] ate raw fish (+15 hunger)");
      } else if (invRemove(inv.slots, "food", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 25);
        });
        console.log("[food] ate food (+25 hunger)");
      }
    }
  });
}, { queries: [playerInvQuery] });

// 12. InventorySpoilageSystem — food spoils over time
const spoilageSystem = system("spoilage", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const gameHoursPerSecond = 24 / DAY_DURATION;
  const spoilThisTick = SPOILAGE_RATE * gameHoursPerSecond * dt;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    for (let i = inv.slots.length - 1; i >= 0; i--) {
      const s = inv.slots[i];
      if (s.item === "raw_fish" || s.item === "food" || s.item === "cooked_fish") {
        s.spoil -= spoilThisTick;
        if (s.spoil <= 0) {
          console.log(`[spoilage] ${s.item} spoiled!`);
          inv.slots.splice(i, 1);
        }
      }
    }
  });
}, { queries: [playerInvQuery] });

// 13. ShipIslandCollisionSystem — prevent ship from sailing through islands
const shipIslandCollisionSystem = system("ship-island-collision", Stage.Update, (ctx) => {
  shipQuery.iterate(ctx.tick, (_e, [ship]) => {
    const island = isOnIsland(ship.x, ship.z);
    if (island.onLand && island.groundY > ISLAND_BEACH_LEVEL) {
      // Push ship away from island center
      let pushX = 0, pushZ = 0;
      islandQuery.iterate(ctx.tick, (_ie, [isl]) => {
        const dx = ship.x - isl.x;
        const dz = ship.z - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < isl.radius && islandHeightAt(isl, ship.x, ship.z) > ISLAND_BEACH_LEVEL) {
          const push = (isl.radius - dist) / isl.radius;
          pushX += (dx / dist) * push * 2;
          pushZ += (dz / dist) * push * 2;
        }
      });
      ship.x += pushX;
      ship.z += pushZ;
      ship.speed *= 0.3;
    }
  });
}, { queries: [shipQuery] });

// 14. DebrisDriftSystem — debris floats with wind/current
const debrisDriftSystem = system("debris-drift", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  debrisQuery.iterate(ctx.tick, (_e, [debris]) => {
    if (debris.collected) return;
    debris.x += weatherState.windDirX * weatherState.windSpeed * 0.02 * dt;
    debris.z += weatherState.windDirZ * weatherState.windSpeed * 0.02 * dt;
    debris.y = WATER_LEVEL + Math.sin(ctx.tick * 0.05 + debris.x) * 0.15;
  });
}, { queries: [debrisQuery] });

let ecsWorld: World;
let gameWorld: GameWorld;
let camera: Camera;
let particles: ParticleSystem;
let telemetry: TelemetryCollector;
let playerEntity: Entity;
let frameCount = 0;
let timeOfDay = 0.3;
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

// ─── Helper: spawn entity with multiple components ─────────

function spawnEntity(world: World, components: Map<number, unknown>) {
  return world.spawn(components);
}

// ─── Lifecycle: init ───────────────────────────────────────

export function init(ctx: any) {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Ocean Survival — DownDraft Engine          ║");
  console.log("║   (parity with to-the-ocean game systems)    ║");
  console.log("╚══════════════════════════════════════════════╝");

  ecsWorld = new World();
  const scene = new Scene("ocean-survival", ecsWorld);
  gameWorld = new GameWorld(scene);

  // Camera — third-person view following player
  camera = new Camera();
  camera.setAspect(16, 9);
  camera.distance = 15;
  camera.orbit(0, 0.4);
  camera.setTarget(0, 1, 0);
  ecsWorld.setResource("camera", camera);

  // Meshes for rendering
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

  // Input + game resources
  ecsWorld.setResource("input", { keys: new Set<string>(), pressed: new Set<string>() });
  ecsWorld.setResource("raft", { wood: 5 });
  ecsWorld.setResource("time", 0);
  ecsWorld.setResource("craftState", { lastRecipe: 0 });

  // Spawn player
  const playerComps = new Map<number, unknown>();
  playerComps.set(Player.id, Player.create({ x: 0, y: 1, z: 0 }));
  playerComps.set(Health.id, Health.create({ current: PLAYER_MAX_HEALTH, max: PLAYER_MAX_HEALTH }));
  playerComps.set(Hunger.id, Hunger.create({ current: PLAYER_MAX_HUNGER, max: PLAYER_MAX_HUNGER }));
  playerComps.set(Thirst.id, Thirst.create({ current: PLAYER_MAX_THIRST, max: PLAYER_MAX_THIRST }));
  playerComps.set(Oxygen.id, Oxygen.create({ current: PLAYER_MAX_OXYGEN, max: PLAYER_MAX_OXYGEN }));
  playerComps.set(Temperature.id, Temperature.create({ current: PLAYER_TEMP_NORM }));
  playerComps.set(Inventory.id, Inventory.create({ slots: [] }));
  playerEntity = spawnEntity(ecsWorld, playerComps);

  // Spawn fishing line entity (singleton)
  const fishingComps = new Map<number, unknown>();
  fishingComps.set(FishingLine.id, FishingLine.create({ cast: false, timer: 0, waitTime: 0, hooked: false }));
  spawnEntity(ecsWorld, fishingComps);

  // Spawn ship
  const shipComps = new Map<number, unknown>();
  shipComps.set(Ship.id, Ship.create({ x: 0, y: 0, z: 0, integrity: 100, maxIntegrity: 100 }));
  spawnEntity(ecsWorld, shipComps);

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
    spawnEntity(ecsWorld, wlComps);
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
    spawnEntity(ecsWorld, wlComps);
  }

  // Spawn islands
  for (let i = 0; i < ISLAND_COUNT; i++) {
    const angle = (i / ISLAND_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 40 + Math.random() * ISLAND_SPAWN_RANGE;
    const radius = ISLAND_MIN_RADIUS + Math.random() * (ISLAND_MAX_RADIUS - ISLAND_MIN_RADIUS);
    const height = ISLAND_MIN_HEIGHT + Math.random() * (ISLAND_MAX_HEIGHT - ISLAND_MIN_HEIGHT);
    const islandComps = new Map<number, unknown>();
    islandComps.set(Island.id, Island.create({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius,
      height,
      hasTrees: Math.random() > 0.3,
      hasRocks: Math.random() > 0.5,
      visited: false,
    }));
    spawnEntity(ecsWorld, islandComps);
  }

  // Spawn debris
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 20;
    const r = Math.random();
    const type = r < 0.4 ? "wood" : r < 0.7 ? "food" : "water";
    const debrisComps = new Map<number, unknown>();
    debrisComps.set(Debris.id, Debris.create({
      type,
      x: Math.cos(angle) * dist,
      y: WATER_LEVEL,
      z: Math.sin(angle) * dist,
      collected: false,
    }));
    spawnEntity(ecsWorld, debrisComps);
  }

  // Register systems in tick order (matching to-the-ocean Simulation.tick)
  ecsWorld.schedule.addSystem(weatherSystem);
  ecsWorld.schedule.addSystem(playerMovementSystem);
  ecsWorld.schedule.addSystem(shipControlSystem);
  ecsWorld.schedule.addSystem(buoyancySystem);
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

  // Update query archetypes now that systems are registered
  ecsWorld.schedule.updateQueryArchetypes(ecsWorld.allArchetypes);

  // Particles
  particles = new ParticleSystem({ maxParticlesPerEmitter: 2000 });
  particles.registerEmitter(createFireEmitter({ position: [0, 1.5, 0], emissionRate: 30 }));
  particles.registerEmitter(createSmokeEmitter({ position: [0, 2.5, 0], emissionRate: 10 }));

  // Telemetry
  telemetry = new TelemetryCollector(true);

  console.log("  Player spawned at origin with full survival stats");
  console.log("  Ship created (integrity: 100%)");
  console.log("  2 sharks + 5 fish spawned");
  console.log("  10 debris items scattered (wood/food/water)");
  console.log(`  ${ISLAND_COUNT} islands generated in the surrounding ocean`);
  console.log("  Fire + smoke particle emitters active");
  console.log("  Weather: Clear, wind: 3 m/s");
  console.log("");
  console.log("  Controls:");
  console.log("    WASD = move | Shift = throttle | Arrows = steer ship");
  console.log("    E = board/leave ship | Q = anchor | R = repair (needs wood)");
  console.log("    F = fish | C = craft (cycles recipes) | B = apply raft upgrade");
  console.log("    T = eat food");
  console.log("  Survival: manage hunger, thirst, oxygen, temperature");
  console.log("  Crafting: wood->planks->campfire->cook fish->raft upgrade");
}

// ─── Lifecycle: tick ───────────────────────────────────────

export function tick(ctx: any, dt: number) {
  frameCount++;
  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 1) {
    fps = fpsFrames;
    fpsFrames = 0;
    fpsAccum = 0;
  }

  // Apply keyboard input from renderer
  if (ctx?.input) {
    const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
    if (inputRes) {
      inputRes.keys = ctx.input.keys;
      // Merge pressed keys (don't overwrite — might have been set by previous tick)
      for (const k of ctx.input.pressed) inputRes.pressed.add(k);
    }
  }

  // Update time of day
  timeOfDay += dt / DAY_DURATION;
  if (timeOfDay >= 1) timeOfDay -= 1;

  const isNight = timeOfDay > NIGHT_START_FRAC || timeOfDay < NIGHT_END_FRAC;
  ecsWorld.setResource("isNight", isNight);
  ecsWorld.setResource("timeOfDay", timeOfDay);

  // Step the ECS world (runs all registered systems)
  gameWorld.step(dt);

  // Clear pressed keys after tick (one-shot inputs)
  const inputRes = ecsWorld.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (inputRes) inputRes.pressed.clear();

  // Update particles (only with a real GPU device)
  if (ctx?.device && typeof ctx.device === "object") {
    particles.update(dt);
  }

  // Update time resource
  const timeRes = ecsWorld.getResource<number>("time") ?? 0;
  ecsWorld.setResource("time", timeRes + dt);

  // Follow player with camera
  const playerData = ecsWorld.getComponent<typeof Player.defaults>(playerEntity, Player.id);
  if (playerData) {
    camera.setTarget(playerData.x, playerData.y + 1, playerData.z);
  }

  // Periodic status log
  if (frameCount % 300 === 0) {
    const ph = ecsWorld.getComponent<typeof Health.defaults>(playerEntity, Health.id);
    const hu = ecsWorld.getComponent<typeof Hunger.defaults>(playerEntity, Hunger.id);
    const th = ecsWorld.getComponent<typeof Thirst.defaults>(playerEntity, Thirst.id);
    const ox = ecsWorld.getComponent<typeof Oxygen.defaults>(playerEntity, Oxygen.id);
    const tp = ecsWorld.getComponent<typeof Temperature.defaults>(playerEntity, Temperature.id);
    const inv = ecsWorld.getComponent<typeof Inventory.defaults>(playerEntity, Inventory.id);
    const ship = ecsWorld.getComponent<typeof Ship.defaults>(ecsWorld.allArchetypes[0]?.entities?.[0] ?? 0, Ship.id);

    if (ph && hu && th && ox && tp) {
      console.log(
        `[frame ${frameCount}] FPS:${fps} | HP:${ph.current.toFixed(0)}/${ph.max} | Hunger:${hu.current.toFixed(0)} | Thirst:${th.current.toFixed(0)} | O2:${ox.current.toFixed(0)} | Temp:${tp.current.toFixed(1)}C`
      );
      console.log(
        `  Weather:${WeatherType[weatherState.type]} Wind:${weatherState.windSpeed.toFixed(1)}m/s Vis:${weatherState.visibility.toFixed(2)} Time:${(timeOfDay * 24).toFixed(1)}h`
      );
      if (inv) {
        const invStr = inv.slots.map((s: any) => `${s.item}x${s.count}`).join(", ") || "empty";
        console.log(`  Inventory: ${invStr}`);
      }

      if (ph.current <= 0) {
        console.log("[game] Player died — game over!");
      }
    }
  }
}

// ─── Lifecycle: dispose ────────────────────────────────────

export function dispose(ctx: any) {
  particles.destroy();
  console.log("[ocean-survival] disposed");
}

// ─── Lifecycle: getRenderData ──────────────────────────────

export function getRenderData(): RenderData {
  const entities: RenderEntityData[] = [];

  // Player entity
  playerQuery.iterate(frameCount, (_e, [player]) => {
    if (!player.isDead) {
      entities.push({
        type: 0, // Player
        x: player.x, y: player.y, z: player.z,
        r: 0.2, g: 0.8, b: 0.2,
      });
    }
  });

  // Ship entities
  shipQuery.iterate(frameCount, (_e, [ship]) => {
    entities.push({
      type: 1, // Ship
      x: ship.x, y: ship.y, z: ship.z,
      r: 0.6, g: 0.4, b: 0.2,
    });
  });

  // Wildlife entities
  wildlifeQuery.iterate(frameCount, (_e, [wl]) => {
    if (wl.type === "shark") {
      entities.push({
        type: 2, // Shark
        x: wl.x, y: wl.y, z: wl.z,
        r: 0.3, g: 0.3, b: 0.5,
      });
    } else {
      entities.push({
        type: 3, // Fish
        x: wl.x, y: wl.y, z: wl.z,
        r: 0.8, g: 0.6, b: 0.2,
      });
    }
  });

  // Debris entities
  debrisQuery.iterate(frameCount, (_e, [debris]) => {
    if (!debris.collected) {
      entities.push({
        type: 4, // Debris
        x: debris.x, y: debris.y, z: debris.z,
        r: debris.type === "wood" ? 0.5 : debris.type === "food" ? 0.9 : 0.3,
        g: debris.type === "wood" ? 0.3 : debris.type === "food" ? 0.7 : 0.5,
        b: debris.type === "wood" ? 0.1 : debris.type === "food" ? 0.2 : 0.9,
      });
    }
  });

  // Island entities — render as large green/brown domes
  islandQuery.iterate(frameCount, (_e, [island]) => {
    entities.push({
      type: 6, // Island
      x: island.x, y: island.height * 0.5, z: island.z,
      r: 0.3, g: 0.5, b: 0.2,
    });
  });

  // Buildable entities — campfires, etc.
  buildableQuery.iterate(frameCount, (_e, [b]) => {
    entities.push({
      type: 7, // Buildable
      x: b.x, y: b.y, z: b.z,
      r: b.type === "campfire" ? 0.9 : 0.5,
      g: b.type === "campfire" ? 0.5 : 0.4,
      b: b.type === "campfire" ? 0.1 : 0.3,
    });
  });

  return {
    cameraPos: camera.position,
    cameraTarget: camera.target,
    entities,
  };
}

// ─── Self-executing entry point (for `bun run examples/ocean-game/main.ts`) ─

if (import.meta.main) {
  init({});

  let lastTime = performance.now();
  let running = true;

  const onSignal = () => { running = false; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  (async () => {
    while (running) {
      const now = performance.now();
      let dt = (now - lastTime) / 1000;
      if (dt < SIM_TICK_DT) {
        await Bun.sleep(SIM_TICK_DT * 1000 - dt * 1000);
        dt = SIM_TICK_DT;
      }
      dt = Math.min(SIM_TICK_DT, dt);
      lastTime = performance.now();

      tick({}, dt);

      const ph = ecsWorld.getComponent<typeof Health.defaults>(playerEntity, Health.id);
      if (ph && ph.current <= 0) {
        console.log("\n  Game over! Player died.");
        running = false;
      }
    }
    dispose({});
  })();
}
