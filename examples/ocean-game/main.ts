import {
  GameWorld,
  Component,
  RenderLoop,
  MaterialLibrary,
  ParticleSystem,
  createFireEmitter,
  createSmokeEmitter,
  createExplosionEmitter,
  DebugDrawQueue,
  TelemetryCollector,
  type System,
} from "@downdraft/core";

// ─── Game Components ───────────────────────────────────────

const Health = Component.register("Health", {
  current: 100,
  max: 100,
  regenRate: 1,
  [key: string]: unknown,
});

const Hunger = Component.register("Hunger", {
  current: 100,
  max: 100,
  decayRate: 0.5,
  [key: string]: unknown,
});

const Raft = Component.register("Raft", {
  size: 3,
  buoyancy: 1,
  integrity: 100,
  [key: string]: unknown,
});

const Shark = Component.register("Shark", {
  state: "patrol",
  target: -1,
  speed: 4,
  attackCooldown: 0,
  [key: string]: unknown,
});

const Player = Component.register("Player", {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  onRaft: true,
  [key: string]: unknown,
});

const Debris = Component.register("Debris", {
  type: "wood",
  x: 0,
  y: 0,
  z: 0,
  collected: false,
  [key: string]: unknown,
});

// ─── Game Systems ──────────────────────────────────────────

class PlayerMovementSystem implements System {
  name = "player-movement";
  priority = 10;

  update(world: GameWorld, dt: number): void {
    for (const [entity, player] of world.query(Player)) {
      // Simplified movement: WASD on raft
      const speed = 5;
      const input = world.getResource("input") as { keys: Set<string> } | undefined;

      if (input?.keys.has("w")) player.vz = -speed;
      else if (input?.keys.has("s")) player.vz = speed;
      else player.vz *= 0.9;

      if (input?.keys.has("a")) player.vx = -speed;
      else if (input?.keys.has("d")) player.vx = speed;
      else player.vx *= 0.9;

      player.x += player.vx * dt;
      player.z += player.vz * dt;
    }
  }
}

class HungerSystem implements System {
  name = "hunger";
  priority = 20;

  update(world: GameWorld, dt: number): void {
    for (const [entity, hunger] of world.query(Hunger)) {
      hunger.current = Math.max(0, hunger.current - hunger.decayRate * dt);

      const health = world.getComponent(entity, Health);
      if (health && hunger.current <= 0) {
        (health as typeof Health.defaults).current = Math.max(0, (health as typeof Health.defaults).current - 5 * dt);
      }
    }
  }
}

class HealthRegenSystem implements System {
  name = "health-regen";
  priority = 21;

  update(world: GameWorld, dt: number): void {
    for (const [entity, health] of world.query(Health)) {
      const hunger = world.getComponent(entity, Hunger);
      if (hunger && (hunger as typeof Hunger.defaults).current > 30) {
        health.current = Math.min(health.max, health.current + health.regenRate * dt);
      }
    }
  }
}

class SharkAISystem implements System {
  name = "shark-ai";
  priority = 30;

  update(world: GameWorld, dt: number): void {
    const players = [...world.query(Player)];
    if (players.length === 0) return;
    const [playerEntity, playerData] = players[0];

    for (const [entity, shark] of world.query(Shark)) {
      shark.attackCooldown = Math.max(0, shark.attackCooldown - dt);

      const dx = playerData.x - (shark as typeof Shark.defaults).target * 0;
      const dz = playerData.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 15 && shark.state === "patrol") {
        shark.state = "hunt";
        console.log("[shark] entering hunt mode");
      } else if (dist > 30 && shark.state === "hunt") {
        shark.state = "patrol";
        console.log("[shark] returning to patrol");
      }

      if (shark.state === "hunt") {
        const speed = shark.speed;
        const angle = Math.atan2(dx, dz);
        // Move toward player
        // (In full game, would update shark transform)
        if (dist < 2 && shark.attackCooldown <= 0) {
          shark.attackCooldown = 3;
          const health = world.getComponent(playerEntity, Health);
          if (health) {
            (health as typeof Health.defaults).current = Math.max(0, (health as typeof Health.defaults).current - 20);
            console.log("[shark] attacked player! Health:", (health as typeof Health.defaults).current);
          }
        }
      }
    }
  }
}

class DebrisCollectionSystem implements System {
  name = "debris-collection";
  priority = 40;

  update(world: GameWorld, _dt: number): void {
    const players = [...world.query(Player)];
    if (players.length === 0) return;
    const [, playerData] = players[0];

    for (const [entity, debris] of world.query(Debris)) {
      if (debris.collected) continue;

      const dx = debris.x - playerData.x;
      const dz = debris.z - playerData.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 2) {
        debris.collected = true;
        console.log(`[debris] collected ${debris.type}`);

        if (debris.type === "food") {
          const hunger = world.getComponent(players[0][0], Hunger);
          if (hunger) {
            (hunger as typeof Hunger.defaults).current = Math.min(100, (hunger as typeof Hunger.defaults).current + 25);
          }
        } else if (debris.type === "wood") {
          const raft = world.getResource("raft") as { wood: number } | undefined;
          if (raft) raft.wood += 1;
        }
      }
    }
  }
}

class RaftIntegritySystem implements System {
  name = "raft-integrity";
  priority = 50;

  update(world: GameWorld, dt: number): void {
    for (const [entity, raft] of world.query(Raft)) {
      // Raft slowly degrades
      raft.integrity = Math.max(0, raft.integrity - 0.1 * dt);

      if (raft.integrity < 30) {
        console.log("[raft] integrity low:", raft.integrity.toFixed(0) + "%");
      }

      if (raft.integrity <= 0) {
        console.log("[game] raft destroyed — game over!");
      }
    }
  }
}

class ParticleEffectSystem implements System {
  name = "particle-effects";
  priority = 60;
  private particles: ParticleSystem;
  private fireEmitterId = -1;
  private smokeEmitterId = -1;
  private explosionEmitterId = -1;

  constructor(particles: ParticleSystem) {
    this.particles = particles;
  }

  start(): void {
    this.fireEmitterId = this.particles.registerEmitter(
      createFireEmitter({ position: [0, 1.5, 0], emissionRate: 30 })
    );
    this.smokeEmitterId = this.particles.registerEmitter(
      createSmokeEmitter({ position: [0, 2.5, 0], emissionRate: 10 })
    );
  }

  update(_world: GameWorld, _dt: number): void {
    // Particles updated in main loop via particles.update(dt)
  }

  triggerExplosion(x: number, y: number, z: number): void {
    this.explosionEmitterId = this.particles.registerEmitter(
      createExplosionEmitter({ position: [x, y, z], loops: 1 })
    );
  }
}

// ─── Main Entry ────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Ocean Survival — DownDraft Engine      ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");

  // Create game world
  const world = new GameWorld();

  // Register resources
  world.registerResource("input", { keys: new Set<string>() });
  world.registerResource("raft", { wood: 5 });
  world.registerResource("time", 0);

  // Spawn player
  const player = world.spawn(
    Player.create({ x: 0, y: 1, z: 0 }),
    Health.create({ current: 100, max: 100 }),
    Hunger.create({ current: 100, max: 100 }),
  );

  // Spawn raft
  world.spawn(
    Raft.create({ size: 3, integrity: 100 }),
  );

  // Spawn sharks
  for (let i = 0; i < 2; i++) {
    world.spawn(
      Shark.create({
        state: "patrol",
        speed: 3 + Math.random() * 2,
        attackCooldown: 0,
      }),
    );
  }

  // Spawn debris
  for (let i = 0; i < 10; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 20;
    world.spawn(
      Debris.create({
        type: Math.random() > 0.5 ? "wood" : "food",
        x: Math.cos(angle) * dist,
        y: 0,
        z: Math.sin(angle) * dist,
        collected: false,
      }),
    );
  }

  // Register systems
  world.registerSystem(new PlayerMovementSystem());
  world.registerSystem(new HungerSystem());
  world.registerSystem(new HealthRegenSystem());
  world.registerSystem(new SharkAISystem());
  world.registerSystem(new DebrisCollectionSystem());
  world.registerSystem(new RaftIntegritySystem());

  // Setup particles
  const particles = new ParticleSystem({ maxParticlesPerEmitter: 2000 });
  const particleSystem = new ParticleEffectSystem(particles);
  particleSystem.start();
  world.registerSystem(particleSystem);

  // Setup debug draw
  const debugDraw = new DebugDrawQueue();

  // Setup telemetry
  const telemetry = new TelemetryCollector();

  console.log("  Player spawned at origin");
  console.log("  Raft created (integrity: 100%)");
  console.log("  2 sharks patrolling");
  console.log("  10 debris items scattered");
  console.log("  Fire + smoke particle emitters active");
  console.log("");
  console.log("  Controls: WASD to move, collect debris, survive!");
  console.log("");
  console.log("  Game ready. Running simulation...");
  console.log("");

  // Game loop
  let lastTime = performance.now();
  let running = true;
  let frameCount = 0;

  while (running) {
    const now = performance.now();
    const dt = Math.min(0.033, (now - lastTime) / 1000);
    lastTime = now;

    telemetry.beginFrame();

    // Update world
    world.update(dt);

    // Update particles
    particles.update(dt);

    // Update time resource
    const timeRes = world.getResource("time") as number;
    world.registerResource("time", timeRes + dt);

    telemetry.endFrame();

    frameCount++;
    if (frameCount % 300 === 0) {
      const stats = telemetry.getStats();
      console.log(`[frame ${frameCount}] ${stats.avgFrameTime.toFixed(2)}ms | FPS: ${(1000 / stats.avgFrameTime).toFixed(1)}`);

      // Check game state
      const playerHealth = world.getComponent(player, Health);
      const playerHunger = world.getComponent(player, Hunger);
      if (playerHealth && playerHunger) {
        const h = playerHealth as typeof Health.defaults;
        const hu = playerHunger as typeof Hunger.defaults;
        console.log(`  Health: ${h.current.toFixed(0)}/${h.max} | Hunger: ${hu.current.toFixed(0)}/${hu.max}`);

        if (h.current <= 0) {
          console.log("[game] Player died — game over!");
          running = false;
        }
      }
    }
  }

  console.log("");
  console.log("  Game ended. Final stats:");
  console.log(`  Frames: ${frameCount}`);
  const stats = telemetry.getStats();
  console.log(`  Avg frame time: ${stats.avgFrameTime.toFixed(2)}ms`);
  console.log(`  Avg FPS: ${(1000 / stats.avgFrameTime).toFixed(1)}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
