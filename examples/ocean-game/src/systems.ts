// ─── Game Systems (tick order matches to-the-ocean Simulation.tick) ──

import { createLogger, Stage, system } from "@downdraft/core";
import {
    collectShoreSources,
    collectWakeSources,
    packShoreSources,
    WAKE_FLOATS,
} from "@downdraft/plugin-water";
import {
    canCraft,
    executeCraft,
    getUnlockedRecipes,
    unlockRecipesForTier,
} from "../plugins/crafting-plugin.ts";

import {
    addXP,
    animalQuery,
    Buildable,
    buildableQuery,
    debrisQuery,
    fishingQuery,
    Health,
    Island,
    islandQuery,
    petQuery,
    Pirate,
    pirateQuery,
    plantQuery,
    Player,
    playerInvQuery, playerProgQuery,
    playerQuery,
    portQuery,
    Progression,
    shipQuery, wildlifeQuery
} from "./components.ts";
import {
    ANIMAL_GROWTH_TIME,
    ANIMAL_HUNGER_DECAY,
    ANIMAL_PRODUCT_TIME,
    AnimalStage,
    BOARD_RANGE,
    CAMERA_MAX_DISTANCE,
    CAMERA_MIN_DISTANCE,
    CameraMode,
    FISH_SPEED,
    FISHING_CATCH_CHANCE,
    FISHING_MAX_WAIT,
    FISHING_MIN_WAIT,
    HOTBAR_SLOTS,
    HUNGER_DAMAGE_RATE,
    ISLAND_BEACH_LEVEL,
    ISLAND_WATER_CONFIG,
    KEY,
    MARKET_PRICE_RECOVERY,
    MOUSE_LOOK_SENSITIVITY,
    OXYGEN_DRAIN_RATE, OXYGEN_REGEN_RATE,
    PET_FOLLOW_RANGE,
    PET_FOLLOW_SPEED,
    PET_HUNGER_DECAY,
    PIRATE_ATTACK_COOLDOWN,
    PIRATE_ATTACK_DAMAGE,
    PIRATE_ATTACK_RANGE,
    PIRATE_CHASE_RANGE,
    PIRATE_HEALTH, PIRATE_LOOT_DROP,
    PIRATE_SPAWN_CHANCE,
    PIRATE_SPAWN_INTERVAL,
    PIRATE_SPAWN_MAX_DIST,
    PIRATE_SPAWN_MIN_DIST,
    PIRATE_SPEED,
    PirateState,
    PLANT_STAGE_DURATIONS, PLANT_WATER_DECAY,
    PlantStage,
    PLAYER_DIVE_SPEED,
    PLAYER_FALL_DAMAGE_RATE,
    PLAYER_FALL_DAMAGE_THRESHOLD,
    PLAYER_GRAVITY,
    PLAYER_JUMP_VELOCITY,
    PLAYER_NOCLIP_SPEED,
    PLAYER_RUN_SPEED, PLAYER_SWIM_SPEED,
    PLAYER_TEMP_MAX,
    PLAYER_TEMP_MIN,
    PLAYER_TEMP_NORM,
    PLAYER_WALK_SPEED,
    PLAYER_WATER_BUOYANCY, PLAYER_WATER_DAMPING,
    PORT_TRADE_RANGE,
    REPAIR_RATE,
    SHARK_ATTACK_COOLDOWN, SHARK_ATTACK_DAMAGE,
    SHARK_ATTACK_RANGE,
    SHARK_DESPAWN_RANGE,
    SHARK_HUNT_RANGE,
    SHIP_ACCEL,
    SHIP_DRAG,
    SHIP_MAX_SPEED,
    SHIP_TURN_RATE,
    TEMP_DAMAGE_RATE,
    TEMP_DAMAGE_THRESHOLD_HIGH,
    TEMP_DAMAGE_THRESHOLD_LOW,
    THIRST_DAMAGE_RATE,
    TOOL_GUN_DAMAGE,
    TOOL_GUN_RANGE,
    WATER_LEVEL,
    WildlifeState,
    XP_CATCH_FISH, XP_CRAFT, XP_HARVEST, XP_KILL_PIRATE
} from "./constants.ts";
import { invAdd, invCount, invRemove, islandHeightAt, isOnIsland, isOnIslandWater, spawnEntity } from "./helpers.ts";
import type { InputState } from "./input.ts";
import { consumeMouseDelta, consumeWheel, isKeyDown } from "./input.ts";
import { gameState } from "./state.ts";
import type { WaterVoxelField } from "./terrain.ts";
import {
    advanceWaterPhysicsTime,
    buoyancySystem,
    waterPhysics,
    waterShoreData,
    waterShoreProviders,
    waterShoreSources,
    waterWakeData,
    waterWakeProviders,
    waterWakeSources,
    type BuoyancyEntity,
} from "./water.ts";
import {
    weatherIsHellStorm,
    weatherIsStormy,
    weatherState
} from "./weather.ts";

const log = createLogger();

// ─── Systems ──────────────────────────────────────────────

// 1. WeatherSystem is exported from weather.ts

// 2. PlayerMovementSystem
export const playerMovementSystem = system("player-movement", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<InputState>("inputState");
  playerQuery.iterate(ctx.tick, (entity, [playerRaw]) => {
    const player = playerRaw as typeof Player.defaults;
    if (player.isDead) return;

    if (player.onShip) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        player.x = ship.x;
        player.z = ship.z;
        player.y = ship.y + 1;
        player.heading = ship.heading;
      });
    }

    if (input) {
      const { dx, dy } = consumeMouseDelta(input);
      player.mouseSmoothingX += dx;
      player.mouseSmoothingY += dy;
      const applyX = player.mouseSmoothingX * 0.85;
      const applyY = player.mouseSmoothingY * 0.85;
      player.mouseSmoothingX -= applyX;
      player.mouseSmoothingY -= applyY;
      if (applyX !== 0 || applyY !== 0) {
        player.heading += applyX * MOUSE_LOOK_SENSITIVITY;
        player.pitch -= applyY * MOUSE_LOOK_SENSITIVITY;
        player.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, player.pitch));
      }

      const wheel = consumeWheel(input);
      if (wheel !== 0) {
        input.cameraZoom = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, input.cameraZoom - wheel * 0.01));
      }

      if (input.pressed.has("m")) {
        player.cameraMode = (player.cameraMode + 1) % 3;
        const modeName = player.cameraMode === CameraMode.FirstPerson ? "FirstPerson" :
          player.cameraMode === CameraMode.ThirdPerson ? "ThirdPerson" : "FreeCam";
        log.info("camera", `mode: ${modeName}`);
      }

      if (input.pressed.has("f5")) {
        player.isNoclip = !player.isNoclip;
        log.info("player", `noclip: ${player.isNoclip ? "ON" : "OFF"}`);
      }

      for (let i = 0; i < HOTBAR_SLOTS; i++) {
        const keyName = i < 9 ? String(i + 1) : "0";
        if (input.pressed.has(keyName)) {
          player.hotbarSlot = i;
          input.hotbarSlot = i;
        }
      }
    }

    const island = isOnIsland(player.x, player.z);
    const onLand = island.onLand && island.groundY > ISLAND_BEACH_LEVEL;
    const islandWater = isOnIslandWater(player.x, player.z);
    let waterH: number;
    if (islandWater.inIslandWater) {
      waterH = islandWater.height;
    } else {
      waterH = waterPhysics.sampleWaterAt(player.x, player.z);
    }
    const effectiveWaterLevel = waterH > -100 ? waterH : WATER_LEVEL;
    const inWater = !onLand && player.y < effectiveWaterLevel + 0.5;
    const isUnderwater = player.y < effectiveWaterLevel - 0.5;

    if (player.isNoclip) {
      let mx = 0, my = 0, mz = 0;
      if (input) {
        if (isKeyDown(input, KEY.W)) mz -= 1;
        if (isKeyDown(input, KEY.S)) mz += 1;
        if (isKeyDown(input, KEY.A)) mx -= 1;
        if (isKeyDown(input, KEY.D)) mx += 1;
        if (isKeyDown(input, KEY.SPACE)) my += 1;
        if (isKeyDown(input, KEY.SHIFT)) my -= 1;
      }
      const len = Math.sqrt(mx * mx + mz * mz + my * my);
      if (len > 0) { mx /= len; mz /= len; my /= len; }
      const cosH = Math.cos(player.heading), sinH = Math.sin(player.heading);
      const speed = PLAYER_NOCLIP_SPEED;
      player.vx = (mx * cosH - mz * sinH) * speed;
      player.vz = (mx * sinH + mz * cosH) * speed;
      player.vy = my * speed;
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.z += player.vz * dt;
      player.isSwimming = false;
      player.isUnderwater = false;
      player.isGrounded = false;
      return;
    }

    let mx = 0, mz = 0;
    if (input) {
      if (isKeyDown(input, KEY.W)) mz -= 1;
      if (isKeyDown(input, KEY.S)) mz += 1;
      if (isKeyDown(input, KEY.A)) mx -= 1;
      if (isKeyDown(input, KEY.D)) mx += 1;
    }

    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 0) { mx /= len; mz /= len; }

    const cosH = Math.cos(player.heading), sinH = Math.sin(player.heading);
    const worldMx = mx * cosH - mz * sinH;
    const worldMz = mx * sinH + mz * cosH;

    player.isRunning = input ? isKeyDown(input, KEY.SHIFT) : false;
    let speed: number;
    if (onLand) {
      speed = player.isRunning ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED;
    } else if (inWater) {
      speed = PLAYER_SWIM_SPEED;
    } else {
      speed = PLAYER_WALK_SPEED;
    }

    if (input && (input.gamepadAxes[0] !== 0 || input.gamepadAxes[1] !== 0)) {
      const gpx = input.gamepadAxes[0];
      const gpz = input.gamepadAxes[1];
      const gpLen = Math.sqrt(gpx * gpx + gpz * gpz);
      if (gpLen > 0.1) {
        const gpWorldMx = gpx * cosH - gpz * sinH;
        const gpWorldMz = gpx * sinH + gpz * cosH;
        player.vx = gpWorldMx * speed * Math.min(1, gpLen);
        player.vz = gpWorldMz * speed * Math.min(1, gpLen);
      } else {
        player.vx = worldMx * speed;
        player.vz = worldMz * speed;
      }
    } else {
      player.vx = worldMx * speed;
      player.vz = worldMz * speed;
    }

    if (input && isKeyDown(input, KEY.SPACE) && onLand && player.isGrounded) {
      player.vy = PLAYER_JUMP_VELOCITY;
      player.isGrounded = false;
      player.fallStartY = player.y;
    }

    if (input && isKeyDown(input, KEY.CTRL) && isKeyDown(input, KEY.SPACE) && inWater) {
      player.isDiving = true;
      player.vy = -PLAYER_DIVE_SPEED;
    } else if (inWater && input && !isKeyDown(input, KEY.CTRL)) {
      player.isDiving = false;
    }

    const newX = player.x + player.vx * dt;
    const newZ = player.z + player.vz * dt;

    const newIsland = isOnIsland(newX, newZ);
    if (newIsland.onLand && newIsland.groundY > ISLAND_BEACH_LEVEL) {
      player.x = newX;
      player.z = newZ;
      player.y = newIsland.groundY;
    } else if (!onLand) {
      player.x = newX;
      player.z = newZ;
    } else {
      player.x = newX;
      player.z = newZ;
    }

    if (mx !== 0 || mz !== 0) {
      player.bodyHeading = Math.atan2(worldMx, -worldMz);
    }

    player.isSwimming = inWater;
    player.isUnderwater = isUnderwater;

    if (onLand) {
      if (!player.isGrounded) {
        player.vy -= PLAYER_GRAVITY * dt;
        player.y += player.vy * dt;
        const groundY = island.groundY;
        if (player.y <= groundY) {
          const fallDist = player.fallStartY - player.y;
          if (fallDist > PLAYER_FALL_DAMAGE_THRESHOLD) {
            const damage = (fallDist - PLAYER_FALL_DAMAGE_THRESHOLD) * PLAYER_FALL_DAMAGE_RATE;
            playerQuery.iterate(ctx.tick, (_pe, [playerRaw, health]) => {
              const player = playerRaw as typeof Player.defaults;
              if (player.isDead) return;
              const h = health as typeof Health.defaults;
              h.current = Math.max(0, h.current - damage);
              log.info("fall", `took ${damage.toFixed(1)} fall damage (fell ${fallDist.toFixed(1)}m)`);
            });
          }
          player.y = groundY;
          player.vy = 0;
          player.isGrounded = true;
        }
      } else {
        player.vy = 0;
        player.y = island.groundY;
      }
    } else if (inWater) {
      if (player.isDiving) {
        player.vy -= PLAYER_GRAVITY * 0.3 * dt;
        player.y += player.vy * dt;
      } else {
        player.vy = PLAYER_WATER_BUOYANCY * 0.3;
        player.y += player.vy * dt;
        if (player.y > effectiveWaterLevel + 0.5) player.y = effectiveWaterLevel + 0.5;
      }
      player.vx *= PLAYER_WATER_DAMPING;
      player.vz *= PLAYER_WATER_DAMPING;
    } else {
      player.vy -= PLAYER_GRAVITY * dt;
      player.y += player.vy * dt;
      if (player.y < effectiveWaterLevel) player.y = effectiveWaterLevel;
      player.isGrounded = false;
    }
  });
}, { queries: [playerQuery] });

// 3. ShipControlSystem
export const shipControlSystem = system("ship-control", Stage.Update, (ctx) => {
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

// 4. BuoyancySystem
export const buoyancySystem_ = system("buoyancy", Stage.Physics, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    const ent: BuoyancyEntity = {
      x: ship.x, y: ship.y, z: ship.z,
      vx: ship.vx, vy: 0, vz: ship.vz,
      heading: ship.heading,
      pitch: 0, roll: 0,
      angularVelX: 0, angularVelZ: 0,
      speed: ship.speed,
      mass: 1000,
    };
    buoyancySystem.applyBuoyancy(ent, dt);
    ship.y = ent.y;
    const islandWater = isOnIslandWater(ship.x, ship.z);
    const waterH = islandWater.inIslandWater ? islandWater.height : waterPhysics.sampleWaterAt(ship.x, ship.z);
    if (waterH > -100) {
      ship.y = waterH;
    }
  });
}, { queries: [shipQuery] });

// 4a. WaveSourceSystem
export const waveSourceSystem = system("wave-sources", Stage.Update, (ctx) => {
  waterWakeProviders.length = 0;
  shipQuery.iterate(ctx.tick, (_e, [ship]) => {
    if (ship.speed > 0.5 && !Number.isNaN(ship.x) && !Number.isNaN(ship.z)) {
      waterWakeProviders.push({
        x: ship.x, z: ship.z,
        heading: ship.heading,
        speed: ship.speed,
      });
    }
  });
  pirateQuery.iterate(ctx.tick, (_e, [pirate]) => {
    if (pirate.health > 0) {
      const pSpeed = Math.sqrt((pirate.vx || 0) ** 2 + (pirate.vz || 0) ** 2);
      if (pSpeed > 0.5 && !Number.isNaN(pirate.x) && !Number.isNaN(pirate.z)) {
        waterWakeProviders.push({
          x: pirate.x, z: pirate.z,
          heading: Math.atan2(pirate.vx || 0, pirate.vz || 1),
          speed: pSpeed,
        });
      }
    }
  });

  waterShoreProviders.length = 0;
  islandQuery.iterate(ctx.tick, (_e, [island]) => {
    waterShoreProviders.push({
      x: island.x, z: island.z,
      radius: island.radius,
      cutoutRadius: island.radius * 2.3, // cut out global ocean covering island water mesh extent
    });
  });
  portQuery.iterate(ctx.tick, (_e, [port]) => {
    waterShoreProviders.push({
      x: port.x, z: port.z,
      radius: 8,
      cutoutRadius: 0,
    });
  });

  const wakeCount = collectWakeSources(waterWakeProviders, waterWakeData);
  const shoreCount = collectShoreSources(waterShoreProviders, waterShoreSources);
  packShoreSources(waterShoreSources, shoreCount, waterShoreData);

  for (let i = 0; i < wakeCount; i++) {
    const off = i * WAKE_FLOATS;
    waterWakeSources[i].x = waterWakeData[off];
    waterWakeSources[i].z = waterWakeData[off + 1];
    waterWakeSources[i].dirX = waterWakeData[off + 2];
    waterWakeSources[i].dirZ = waterWakeData[off + 3];
    waterWakeSources[i].speed = waterWakeData[off + 4];
  }

  waterPhysics.setShoreSources(waterShoreSources, shoreCount);
  waterPhysics.setWakeSources(waterWakeSources, wakeCount);
  waterPhysics.setConfig({
    windSpeed: weatherState.windSpeed,
    windDirX: weatherState.windDirX,
    windDirZ: weatherState.windDirZ,
  });

  let px = 0, pz = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    px = player.x; pz = player.z;
  });
  waterPhysics.update(ctx.dt, px, pz);
  advanceWaterPhysicsTime(ctx.dt);
}, { queries: [shipQuery, islandQuery, portQuery, pirateQuery, playerQuery] });

// 4b. IslandWaterDiffusionSystem — boundary-driven diffusion from ocean to island water
export const islandWaterDiffusionSystem = system("island-water-diffusion", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const { springK, dampingK } = ISLAND_WATER_CONFIG;
  const maxDistSq = 400 * 400; // only run diffusion for islands within 400 units of player

  let px = 0, pz = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    px = player.x; pz = player.z;
  });

  islandQuery.iterate(ctx.tick, (_e, [islandRaw]) => {
    const island = islandRaw as typeof Island.defaults;
    const wvf = island.waterVoxelField as WaterVoxelField | null;
    if (!wvf) return;

    // Distance cull — skip diffusion for far islands
    const dx = island.x - px;
    const dz = island.z - pz;
    if (dx * dx + dz * dz > maxDistSq) return;

    const { dimX, dimZ, heights, velocities, boundaryMask, voxelSize, originX, originZ } = wvf;

    // Step 1: Set boundary columns to ocean water height
    for (let vx = 0; vx < dimX; vx++) {
      for (let vz = 0; vz < dimZ; vz++) {
        const colIdx = vx * dimZ + vz;
        if (boundaryMask[colIdx] === 1) {
          const wx = vx * voxelSize + originX + island.x;
          const wz = vz * voxelSize + originZ + island.z;
          const oceanH = waterPhysics.sampleWaterAt(wx, wz);
          heights[colIdx] = oceanH > -100 ? oceanH : 0;
          velocities[colIdx] = 0;
        }
      }
    }

    // Step 2: Spring-diffusion propagation for interior columns
    for (let vx = 0; vx < dimX; vx++) {
      for (let vz = 0; vz < dimZ; vz++) {
        const colIdx = vx * dimZ + vz;
        if (boundaryMask[colIdx] === 1) continue;

        let neighborSum = 0;
        let neighborCount = 0;
        if (vx > 0) { neighborSum += heights[(vx - 1) * dimZ + vz]; neighborCount++; }
        if (vx < dimX - 1) { neighborSum += heights[(vx + 1) * dimZ + vz]; neighborCount++; }
        if (vz > 0) { neighborSum += heights[vx * dimZ + (vz - 1)]; neighborCount++; }
        if (vz < dimZ - 1) { neighborSum += heights[vx * dimZ + (vz + 1)]; neighborCount++; }
        const neighborAvg = neighborCount > 0 ? neighborSum / neighborCount : heights[colIdx];

        const accel = springK * (neighborAvg - heights[colIdx]) - dampingK * velocities[colIdx];
        velocities[colIdx] += accel * dt;
        heights[colIdx] += velocities[colIdx] * dt;
      }
    }
  });
}, { queries: [islandQuery, playerQuery] });

// 4c. IslandWaveRunUpSystem — waves washing onto and receding from terrain
export const islandWaveRunUpSystem = system("island-wave-runup", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const { runUpAmplitude, runUpPeriod, runUpDamping } = ISLAND_WATER_CONFIG;
  const time = ctx.tick * dt;
  const maxDistSq = 400 * 400;

  let px = 0, pz = 0;
  playerQuery.iterate(ctx.tick, (_e, [player]) => {
    px = player.x; pz = player.z;
  });

  islandQuery.iterate(ctx.tick, (_e, [islandRaw]) => {
    const island = islandRaw as typeof Island.defaults;
    const wvf = island.waterVoxelField as WaterVoxelField | null;
    if (!wvf) return;

    // Distance cull
    const dx = island.x - px;
    const dz = island.z - pz;
    if (dx * dx + dz * dz > maxDistSq) return;

    const { dimX, dimZ, heights, shoreMask, data, dimY, isoLevel, voxelSize } = wvf;
    const dimYZ = dimY * dimZ;

    const runUpPhase = Math.sin(time * (2 * Math.PI / runUpPeriod));
    const runUpHeight = runUpAmplitude * (0.5 + 0.5 * runUpPhase);

    for (let vx = 0; vx < dimX; vx++) {
      for (let vz = 0; vz < dimZ; vz++) {
        const colIdx = vx * dimZ + vz;
        if (shoreMask[colIdx] !== 1) continue;

        // Sample terrain height at this column
        let terrainY = 0;
        const colBase = vx * dimYZ + vz;
        for (let vy = dimY - 1; vy >= 0; vy--) {
          if (data[colBase + vy * dimZ] > isoLevel) {
            terrainY = vy * voxelSize + wvf.originY;
            break;
          }
        }

        const heightAboveWater = Math.max(0, terrainY);
        const slopeDamping = Math.exp(-heightAboveWater * runUpDamping);
        const runUp = runUpHeight * slopeDamping;

        // Set (not accumulate) — blend toward target run-up displacement
        const target = runUp;
        heights[colIdx] = heights[colIdx] * 0.9 + target * 0.1;
      }
    }
  });
}, { queries: [islandQuery, playerQuery] });

// 5. SurvivalSystem
export const survivalSystem = system("survival", Stage.Update, (ctx) => {
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

    let targetTemp: number;
    if (player.isSwimming) {
      targetTemp = weatherState.ambientTemp - 2;
    } else {
      targetTemp = PLAYER_TEMP_NORM + (weatherState.ambientTemp - 20) * 0.1;
    }
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
      gameState.deathCause = cause;
      log.info("survival", `player died from ${cause}`);
    }
  });
}, { queries: [playerQuery] });

// 6. WildlifeAISystem
export const wildlifeAISystem = system("wildlife-ai", Stage.Update, (ctx) => {
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
              log.info("shark", `attacked player! Health: ${health.current.toFixed(0)}`);
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

// 7. DebrisCollectionSystem
export const debrisCollectionSystem = system("debris-collection", Stage.Update, (ctx) => {
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
      log.info("debris", `collected ${debris.type}`);

      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        if (debris.type === "food") {
          invAdd(inv.grid, "food", 1);
        } else if (debris.type === "water") {
          playerQuery.iterate(ctx.tick, (_pe, [, , , thirst]) => {
            thirst.current = Math.min(thirst.max, thirst.current + 30);
          });
        } else if (debris.type === "wood") {
          invAdd(inv.grid, "wood", 1);
        }
      });
    }
  });
}, { queries: [debrisQuery, playerQuery] });

// 8. ShipIntegritySystem
export const shipIntegritySystem = system("ship-integrity", Stage.PostUpdate, (ctx) => {
  const dt = ctx.dt;
  shipQuery.iterate(ctx.tick, (entity, [ship]) => {
    if (weatherIsHellStorm()) {
      ship.integrity = Math.max(0, ship.integrity - 2.0 * dt);
    } else if (weatherIsStormy()) {
      ship.integrity = Math.max(0, ship.integrity - 0.5 * dt);
    } else {
      ship.integrity = Math.max(0, ship.integrity - 0.05 * dt);
    }

    if (ship.integrity < 30 && ctx.tick % 300 === 0) {
      log.info("ship", `integrity low: ${ship.integrity.toFixed(0)}%`);
    }
    if (ship.integrity <= 0 && !gameState.shipDestroyedLogged) {
      gameState.shipDestroyedLogged = true;
      log.info("ship", "destroyed — game over!");
    }
  });
}, { queries: [shipQuery] });

// 9. ShipBoardingSystem
export const shipBoardingSystem = system("ship-boarding", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    shipQuery.iterate(ctx.tick, (_se, [ship]) => {
      if (input.pressed.has("e")) {
        if (!player.onShip) {
          const dx = ship.x - player.x;
          const dz = ship.z - player.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < BOARD_RANGE) {
            player.onShip = true;
            log.info("ship", "boarded ship — WASD to steer, Shift to throttle");
          }
        } else {
          player.onShip = false;
          player.x = ship.x + 2;
          player.z = ship.z + 2;
          log.info("ship", "left ship");
        }
      }

      if (input.pressed.has("q") && player.onShip) {
        if (isNaN(ship.anchorX)) {
          ship.anchorX = ship.x;
          ship.anchorZ = ship.z;
          log.info("ship", "anchor dropped");
        } else {
          ship.anchorX = NaN;
          ship.anchorZ = NaN;
          log.info("ship", "anchor raised");
        }
      }

      if (input.keys.has("r") && player.onShip && ship.integrity < ship.maxIntegrity) {
        if (invRemove(inv.grid, "wood", 1)) {
          ship.integrity = Math.min(ship.maxIntegrity, ship.integrity + REPAIR_RATE * dt);
          if (ctx.tick % 60 === 0) {
            log.info("ship", `repaired to ${ship.integrity.toFixed(0)}%`);
          }
        }
      }
    });
  });
}, { queries: [playerInvQuery, shipQuery] });

// 10. FishingSystem
export const fishingSystem = system("fishing", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [player, inv]) => {
    fishingQuery.iterate(ctx.tick, (_fe, [line]) => {
      if (input.pressed.has("f")) {
        if (!line.cast) {
          const inWater = player.y < WATER_LEVEL + 1 || player.onShip;
          if (inWater) {
            line.cast = true;
            line.hooked = false;
            line.timer = 0;
            line.waitTime = FISHING_MIN_WAIT + Math.random() * (FISHING_MAX_WAIT - FISHING_MIN_WAIT);
            log.info("fishing", "line cast...");
          }
        } else {
          if (line.hooked) {
            if (Math.random() < FISHING_CATCH_CHANCE) {
              invAdd(inv.grid, "raw_fish", 1);
              log.info("fishing", "caught a fish!");
              playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CATCH_FISH));
            } else {
              log.info("fishing", "the fish got away...");
            }
          } else {
            log.info("fishing", "reeled in empty");
          }
          line.cast = false;
          line.hooked = false;
        }
      }

      if (line.cast && !line.hooked) {
        line.timer += dt;
        if (line.timer >= line.waitTime) {
          line.hooked = true;
          log.info("fishing", "something hooked! Press F to reel in");
        }
      }
    });
  });
}, { queries: [playerInvQuery, fishingQuery, playerProgQuery] });

// 11. CraftingSystem
export const craftingSystem = system("crafting", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  playerInvQuery.iterate(ctx.tick, (_e, [playerRaw, invRaw]) => {
    const player = playerRaw as typeof Player.defaults;
    const inv = invRaw as typeof import("../plugins/inventory-plugin.ts").GridInventory.defaults;

    let unlockedSet = new Set<string>();
    playerProgQuery.iterate(ctx.tick, (_pe, [_pe2, progRaw]) => {
      const prog = progRaw as typeof Progression.defaults;
      unlockedSet = new Set<string>(prog.unlockedRecipes);
      unlockRecipesForTier(prog.craftingTier, unlockedSet);
      prog.unlockedRecipes = [...unlockedSet];
    });

    if (input.pressed.has("c")) {
      const craftRes = ctx.world.getResource<{ lastRecipe: number }>("craftState") ?? { lastRecipe: 0 };
      const availableRecipes = getUnlockedRecipes(unlockedSet);

      if (availableRecipes.length === 0) {
        log.info("craft", "no recipes unlocked yet");
        return;
      }

      const recipe = availableRecipes[craftRes.lastRecipe % availableRecipes.length];
      craftRes.lastRecipe = (craftRes.lastRecipe + 1) % availableRecipes.length;
      ctx.world.setResource("craftState", craftRes);

      let nearFire = false;
      if (recipe.needsFire) {
        buildableQuery.iterate(ctx.tick, (_be, [b]) => {
          const dx = b.x - player.x;
          const dz = b.z - player.z;
          if (Math.sqrt(dx * dx + dz * dz) < 3 && b.type === "campfire") nearFire = true;
        });
      }

      const stations = ctx.world.getResource<Set<string>>("craftingStations") ?? new Set<string>();
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
      playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_CRAFT));

      if (recipe.output.itemId === "campfire") {
        const comps = new Map<number, unknown>();
        comps.set(Buildable.id, Buildable.create({
          type: "campfire",
          x: player.x + 1,
          y: player.y,
          z: player.z + 1,
          health: 100,
        }));
        ctx.world.spawn(comps);
        log.info("craft", "campfire placed near player");
      }

      if (recipe.output.itemId === "workbench_basic") {
        const comps = new Map<number, unknown>();
        comps.set(Buildable.id, Buildable.create({
          type: "workbench_basic",
          x: player.x + 1,
          y: player.y,
          z: player.z + 1,
          health: 100,
        }));
        ctx.world.spawn(comps);
        const st = ctx.world.getResource<Set<string>>("craftingStations") ?? new Set<string>();
        st.add("workbench_basic");
        ctx.world.setResource("craftingStations", st);
        log.info("craft", "workbench placed near player — tier 1+ recipes unlocked");
      }
    }

    if (input.pressed.has("b") && invCount(inv.grid, "raft_upgrade") > 0) {
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        const dx = ship.x - player.x;
        const dz = ship.z - player.z;
        if (Math.sqrt(dx * dx + dz * dz) < BOARD_RANGE + 2) {
          invRemove(inv.grid, "raft_upgrade", 1);
          ship.maxIntegrity += 50;
          ship.integrity = ship.maxIntegrity;
          log.info("craft", `raft upgraded! Ship integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
        }
      });
    }

    if (input.pressed.has("t")) {
      if (invRemove(inv.grid, "cooked_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 35);
        });
        log.info("food", "ate cooked fish (+35 hunger)");
      } else if (invRemove(inv.grid, "raw_fish", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 15);
        });
        log.info("food", "ate raw fish (+15 hunger)");
      } else if (invRemove(inv.grid, "food", 1)) {
        playerQuery.iterate(ctx.tick, (_pe, [, , hunger]) => {
          hunger.current = Math.min(hunger.max, hunger.current + 25);
        });
        log.info("food", "ate food (+25 hunger)");
      }
    }
  });
}, { queries: [playerInvQuery, playerProgQuery, shipQuery, buildableQuery] });

// 12. SpoilageSystem (no-op — handled by InventoryPlugin)
export const spoilageSystem = system("spoilage", Stage.Update, (_ctx) => {
}, { queries: [] });

// 13. ShipIslandCollisionSystem
export const shipIslandCollisionSystem = system("ship-island-collision", Stage.Update, (ctx) => {
  shipQuery.iterate(ctx.tick, (_e, [ship]) => {
    const island = isOnIsland(ship.x, ship.z);
    if (island.onLand && island.groundY > ISLAND_BEACH_LEVEL) {
      let pushX = 0, pushZ = 0;
      islandQuery.iterate(ctx.tick, (_ie, [islRaw]) => {
        const isl = islRaw as typeof Island.defaults;
        const dx = ship.x - isl.x;
        const dz = ship.z - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < isl.radius && islandHeightAt(isl, ship.x, ship.z) > ISLAND_BEACH_LEVEL) {
          const safeDist = Math.max(dist, 0.001);
          const push = (isl.radius - dist) / isl.radius;
          pushX += (dx / safeDist) * push * 2;
          pushZ += (dz / safeDist) * push * 2;
        }
      });
      ship.x += pushX;
      ship.z += pushZ;
      if (Number.isNaN(ship.x) || Number.isNaN(ship.z)) {
        log.error("ship-collision", `NaN after push! pushX=${pushX} pushZ=${pushZ}`);
        ship.x = 0;
        ship.z = 0;
      }
      ship.speed *= 0.3;
    }
  });
}, { queries: [shipQuery] });

// 14. DebrisDriftSystem
export const debrisDriftSystem = system("debris-drift", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  debrisQuery.iterate(ctx.tick, (_e, [debris]) => {
    if (debris.collected) return;
    debris.x += weatherState.windDirX * weatherState.windSpeed * 0.02 * dt;
    debris.z += weatherState.windDirZ * weatherState.windSpeed * 0.02 * dt;
    const debrisWaterH = waterPhysics.sampleWaterAt(debris.x, debris.z);
    debris.y = (debrisWaterH > -100 ? debrisWaterH : WATER_LEVEL) + Math.sin(ctx.tick * 0.05 + debris.x) * 0.15;
  });
}, { queries: [debrisQuery] });

// 15. PirateSystem
export const pirateSystem = system("pirates", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  const spawnTimer = ctx.world.getResource<number>("pirateSpawnTimer") ?? 0;
  const newTimer = spawnTimer + dt;
  ctx.world.setResource("pirateSpawnTimer", newTimer);

  if (newTimer > PIRATE_SPAWN_INTERVAL) {
    ctx.world.setResource("pirateSpawnTimer", 0);
    if (Math.random() < PIRATE_SPAWN_CHANCE) {
      playerQuery.iterate(ctx.tick, (pe, [player]) => {
        const angle = Math.random() * Math.PI * 2;
        const dist = PIRATE_SPAWN_MIN_DIST + Math.random() * (PIRATE_SPAWN_MAX_DIST - PIRATE_SPAWN_MIN_DIST);
        const px = player.x + Math.cos(angle) * dist;
        const pz = player.z + Math.sin(angle) * dist;
        const diff = 1 + Math.random();
        const comps = new Map<number, unknown>();
        comps.set(Pirate.id, Pirate.create({
          x: px, y: 0, z: pz,
          heading: Math.atan2(player.z - pz, player.x - px),
          state: PirateState.Patrol,
          health: PIRATE_HEALTH * diff,
          maxHealth: PIRATE_HEALTH * diff,
          difficulty: diff,
        }));
        spawnEntity(ctx.world, comps);
        log.info("pirate", `spawned at (${px.toFixed(0)}, ${pz.toFixed(0)}) difficulty ${diff.toFixed(1)}`);
      });
    }
  }

  let playerX = 0, playerZ = 0, shipX = 0, shipZ = 0;
  playerQuery.iterate(ctx.tick, (_e, [p]) => { playerX = p.x; playerZ = p.z; });
  shipQuery.iterate(ctx.tick, (_e, [s]) => { shipX = s.x; shipZ = s.z; });

  pirateQuery.iterate(ctx.tick, (entity, [pirate]) => {
    if (pirate.health <= 0) return;
    pirate.stateTimer += dt;
    if (pirate.attackCooldown > 0) pirate.attackCooldown -= dt;

    const dx = shipX - pirate.x;
    const dz = shipZ - pirate.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < PIRATE_ATTACK_RANGE) {
      pirate.state = PirateState.Attack;
    } else if (dist < PIRATE_CHASE_RANGE) {
      pirate.state = PirateState.Chase;
    } else {
      pirate.state = PirateState.Patrol;
    }

    if (pirate.state === PirateState.Chase || pirate.state === PirateState.Attack) {
      pirate.heading = Math.atan2(dz, dx);
      pirate.vx = Math.cos(pirate.heading) * PIRATE_SPEED;
      pirate.vz = Math.sin(pirate.heading) * PIRATE_SPEED;
    } else {
      if (pirate.stateTimer > 5) {
        pirate.stateTimer = 0;
        pirate.heading = Math.random() * Math.PI * 2;
      }
      pirate.vx = Math.cos(pirate.heading) * PIRATE_SPEED * 0.3;
      pirate.vz = Math.sin(pirate.heading) * PIRATE_SPEED * 0.3;
    }

    pirate.x += pirate.vx * dt;
    pirate.z += pirate.vz * dt;

    if (pirate.state === PirateState.Attack && pirate.attackCooldown <= 0) {
      pirate.attackCooldown = PIRATE_ATTACK_COOLDOWN;
      shipQuery.iterate(ctx.tick, (_se, [ship]) => {
        ship.integrity = Math.max(0, ship.integrity - PIRATE_ATTACK_DAMAGE * pirate.difficulty);
        log.info("pirate", `attacked ship! integrity: ${ship.integrity.toFixed(0)}/${ship.maxIntegrity}`);
      });
    }

    if (pirate.health < pirate.maxHealth * 0.2) {
      pirate.state = PirateState.Flee;
      pirate.vx = -Math.cos(pirate.heading) * PIRATE_SPEED;
      pirate.vz = -Math.sin(pirate.heading) * PIRATE_SPEED;
    }

    if (input?.pressed.has("g")) {
      const pdx = pirate.x - playerX;
      const pdz = pirate.z - playerZ;
      const pdist = Math.sqrt(pdx * pdx + pdz * pdz);
      if (pdist < TOOL_GUN_RANGE) {
        pirate.health -= TOOL_GUN_DAMAGE;
        log.info("gun", `hit pirate for ${TOOL_GUN_DAMAGE} (health: ${pirate.health.toFixed(0)})`);
        if (pirate.health <= 0) {
          log.info("pirate", "defeated! Dropping loot...");
          playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
            for (let i = 0; i < PIRATE_LOOT_DROP; i++) {
              const loot = ["wood", "food", "planks"][Math.floor(Math.random() * 3)];
              invAdd(inv.grid, loot, 1);
            }
          });
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => {
            addXP(ctx.world, pe, XP_KILL_PIRATE);
          });
          pirate.health = 0;
        }
      }
    }
  });
}, { queries: [pirateQuery, playerQuery, shipQuery, playerInvQuery, playerProgQuery] });

// 16. PortMarketSystem
export const portMarketSystem = system("port-market", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  portQuery.iterate(ctx.tick, (_e, [port]) => {
    for (const listing of port.listings) {
      if (listing.priceModifier < 1.0) {
        listing.priceModifier = Math.min(1.0, listing.priceModifier + MARKET_PRICE_RECOVERY * dt);
      } else if (listing.priceModifier > 1.0) {
        listing.priceModifier = Math.max(1.0, listing.priceModifier - MARKET_PRICE_RECOVERY * dt);
      }
    }
  });

  if (input?.pressed.has("y")) {
    let playerX = 0, playerZ = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { playerX = p.x; playerZ = p.z; });

    portQuery.iterate(ctx.tick, (_e, [port]) => {
      const dx = port.x - playerX;
      const dz = port.z - playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < PORT_TRADE_RANGE) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          const fishCount = invCount(inv.grid, "raw_fish");
          if (fishCount > 0) {
            invRemove(inv.grid, "raw_fish", fishCount);
            const price = Math.floor(5 * (port.listings.find(l => l.item === "raw_fish")?.priceModifier ?? 1));
            log.info("port", `Sold ${fishCount} raw_fish for ${price * fishCount} coins`);
            invAdd(inv.grid, "coin", price * fishCount);
          }
          const coins = invCount(inv.grid, "coin");
          const woodPrice = Math.floor(3 * (port.listings.find(l => l.item === "wood")?.priceModifier ?? 1));
          if (coins >= woodPrice) {
            invRemove(inv.grid, "coin", woodPrice);
            invAdd(inv.grid, "wood", 1);
            log.info("port", `Bought 1 wood for ${woodPrice} coins`);
          }
        });
      }
    });
  }
}, { queries: [portQuery, playerQuery, playerInvQuery] });

// 17. AnimalSystem
export const animalSystem = system("animals", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  animalQuery.iterate(ctx.tick, (entity, [animal]) => {
    animal.age += dt;
    if (animal.stage < AnimalStage.Adult && animal.age > (animal.stage + 1) * ANIMAL_GROWTH_TIME) {
      animal.stage++;
      log.info("animal", `${animal.species} grew to stage ${animal.stage}`);
    }
    animal.hunger = Math.max(0, animal.hunger - ANIMAL_HUNGER_DECAY * dt);

    if (Math.random() < 0.01) {
      animal.vx = (Math.random() - 0.5) * 2;
      animal.vz = (Math.random() - 0.5) * 2;
    }
    animal.x += animal.vx * dt;
    animal.z += animal.vz * dt;
    animal.vx *= 0.95;
    animal.vz *= 0.95;

    if (animal.stage >= AnimalStage.Adult && animal.hunger > 20) {
      animal.productTimer -= dt;
      if (animal.productTimer <= 0) {
        animal.productTimer = ANIMAL_PRODUCT_TIME;
        log.info("animal", `${animal.species} produced ${animal.productType}`);
      }
    }

    if (input?.pressed.has("h") && animal.stage >= AnimalStage.Adult && animal.productTimer < ANIMAL_PRODUCT_TIME - 5) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((animal.x - px) ** 2 + (animal.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.grid, animal.productType, 1);
          animal.productTimer = ANIMAL_PRODUCT_TIME;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          log.info("animal", `harvested ${animal.productType}`);
        });
      }
    }
  });
}, { queries: [animalQuery, playerQuery, playerInvQuery, playerProgQuery] });

// 18. PlantSystem
export const plantSystem = system("plants", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  plantQuery.iterate(ctx.tick, (entity, [plant]) => {
    plant.waterLevel = Math.max(0, plant.waterLevel - PLANT_WATER_DECAY * dt);

    if (plant.waterLevel > 10 && plant.stage < PlantStage.Overripe) {
      plant.growthTimer += dt;
      const duration = PLANT_STAGE_DURATIONS[plant.stage] ?? 300;
      if (plant.growthTimer >= duration) {
        plant.stage++;
        plant.growthTimer = 0;
        log.info("plant", `${plant.species} grew to stage ${plant.stage}`);
      }
    }

    if (input?.pressed.has("h") && plant.stage >= PlantStage.Mature) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((plant.x - px) ** 2 + (plant.z - pz) ** 2);
      if (d < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          invAdd(inv.grid, plant.species, plant.yield);
          plant.stage = PlantStage.Seed;
          plant.growthTimer = 0;
          plant.waterLevel = 100;
          playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
          log.info("plant", `harvested ${plant.yield} ${plant.species}`);
        });
      }
    }

    if (input?.pressed.has("j")) {
      let px = 0, pz = 0;
      playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
      const d = Math.sqrt((plant.x - px) ** 2 + (plant.z - pz) ** 2);
      if (d < 3) {
        plant.waterLevel = 100;
        log.info("plant", `watered ${plant.species}`);
      }
    }
  });
}, { queries: [plantQuery, playerQuery, playerInvQuery, playerProgQuery] });

// 19. PetSystem
export const petSystem = system("pets", Stage.Update, (ctx) => {
  const dt = ctx.dt;
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");

  petQuery.iterate(ctx.tick, (entity, [pet]) => {
    pet.hunger = Math.max(0, pet.hunger - PET_HUNGER_DECAY * dt);
    if (pet.cooldown > 0) pet.cooldown -= dt;

    let px = 0, py = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; py = p.y; pz = p.z; });

    const dx = px - pet.x;
    const dz = pz - pet.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist > PET_FOLLOW_RANGE) {
      pet.vx = (dx / dist) * PET_FOLLOW_SPEED;
      pet.vz = (dz / dist) * PET_FOLLOW_SPEED;
    } else {
      pet.vx *= 0.8;
      pet.vz *= 0.8;
      pet.happiness = Math.min(100, pet.happiness + 0.5 * dt);
    }

    pet.x += pet.vx * dt;
    pet.z += pet.vz * dt;

    const island = isOnIsland(pet.x, pet.z);
    pet.y = island.onLand ? island.groundY : WATER_LEVEL;

    if (input?.pressed.has("p")) {
      const pd = Math.sqrt((pet.x - px) ** 2 + (pet.z - pz) ** 2);
      if (pd < 3) {
        playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
          if (invRemove(inv.grid, "food", 1) || invRemove(inv.grid, "raw_fish", 1)) {
            pet.hunger = Math.min(100, pet.hunger + 30);
            pet.happiness = Math.min(100, pet.happiness + 10);
            log.info("pet", `fed pet (hunger: ${pet.hunger.toFixed(0)}, happiness: ${pet.happiness.toFixed(0)})`);
          }
        });
      }
    }
  });
}, { queries: [petQuery, playerQuery, playerInvQuery] });

// 20. ToolSystem
export const toolSystem = system("tools", Stage.Update, (ctx) => {
  const input = ctx.world.getResource<{ keys: Set<string>; pressed: Set<string> }>("input");
  if (!input) return;

  if (input.pressed.has("x")) {
    let px = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
    const island = isOnIsland(px, pz);
    if (island.onLand) {
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        const wood = 1 + Math.floor(Math.random() * 2);
        invAdd(inv.grid, "wood", wood);
        playerProgQuery.iterate(ctx.tick, (_pe, [pe, _]) => addXP(ctx.world, pe, XP_HARVEST));
        log.info("axe", `chopped tree, got ${wood} wood`);
      });
    } else {
      log.info("axe", "no trees here — need to be on an island");
    }
  }

  if (input.pressed.has("v")) {
    let px = 0, pz = 0;
    playerQuery.iterate(ctx.tick, (_e, [p]) => { px = p.x; pz = p.z; });
    const island = isOnIsland(px, pz);
    if (island.onLand) {
      playerInvQuery.iterate(ctx.tick, (_ie, [_, inv]) => {
        const find = Math.random();
        if (find < 0.3) {
          invAdd(inv.grid, "coin", 1 + Math.floor(Math.random() * 3));
          log.info("shovel", "dug up coins!");
        } else if (find < 0.5) {
          invAdd(inv.grid, "wood", 1);
          log.info("shovel", "dug up buried wood");
        } else if (find < 0.6) {
          invAdd(inv.grid, "food", 1);
          log.info("shovel", "dug up food");
        } else {
          log.info("shovel", "nothing here...");
        }
      });
    }
  }
}, { queries: [playerQuery, playerInvQuery, playerProgQuery] });

// 21. ProgressionSystem
export const progressionSystem = system("progression", Stage.Update, (ctx) => {
  playerProgQuery.iterate(ctx.tick, (_e, [_player, progRaw]) => {
    const prog = progRaw as typeof Progression.defaults;
    if (prog.level === 1 && prog.xp === 0 && prog.unlockedRecipes.length === 0) {
      const unlocked = new Set<string>();
      unlockRecipesForTier(0, unlocked);
      prog.unlockedRecipes = [...unlocked];
    }
  });
}, { queries: [playerProgQuery] });
