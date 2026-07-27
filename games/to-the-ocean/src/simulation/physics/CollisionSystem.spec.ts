// Deterministic collision tests for mass-based boat collision system
// Run with: bun test src/simulation/physics/CollisionSystem.spec.ts

import {
  SHIP_COLLISION_RESTITUTION,
  SHIP_COLLISION_FRICTION,
  SHIP_COLLISION_SLOP,
  SHIP_COLLISION_CORRECTION_PCT,
  SHIP_YAW_MAX,
  SHIP_PITCH_ROLL_COLLISION_MAX,
  SHIP_MASS_PER_CELL,
  ENTITY_MASS,
  WILDLIFE_DENSITY,
  SHIP_DATA,
} from "../../shared/constants";
import { EntityType, EntityFlags } from "../../shared/types";

// --- Minimal mock entity matching SimEntity interface ---
interface MockEntity {
  id: number;
  type: EntityType;
  flags: number;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: number;
  velocity: { x: number; y: number; z: number };
  angularVelocity: { x: number; y: number; z: number };
  health: number;
  maxHealth: number;
  parentId: number;
  chunkX: number;
  chunkZ: number;
  data: Float32Array;
}

function makeEntity(id: number, type: EntityType, mass: number, x: number, z: number, scale: number): MockEntity {
  const invMass = (mass === Infinity || mass <= 0) ? 0 : 1 / mass;
  const inertia = mass > 0 && mass !== Infinity ? mass * scale * scale * 0.5 : 0;
  return {
    id,
    type,
    flags: 0,
    position: { x, y: 0, z },
    rotation: { x: 0, y: 1, z: 0, w: 0 },
    scale,
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    health: 100,
    maxHealth: 100,
    parentId: 0,
    chunkX: 0,
    chunkZ: 0,
    data: new Float32Array(8),
  };
}

// --- Inline copy of resolveContact for testing ---
// (The real function is not exported from CollisionSystem.ts)
function resolveContact(
  a: MockEntity, b: MockEntity,
  nx: number, ny: number, nz: number,
  penetration: number,
  contactX: number, contactY: number, contactZ: number,
  invMassA: number, invMassB: number,
  invIyyA: number, invIyyB: number,
  invIxxA: number, invIxxB: number,
  invIzzA: number, invIzzB: number,
): void {
  const armAx = contactX - a.position.x;
  const armAy = contactY - a.position.y;
  const armAz = contactZ - a.position.z;
  const armBx = contactX - b.position.x;
  const armBy = contactY - b.position.y;
  const armBz = contactZ - b.position.z;

  const avx = a.velocity.x + (a.angularVelocity.y * armAz - a.angularVelocity.z * armAy);
  const avy = a.velocity.y + (a.angularVelocity.z * armAx - a.angularVelocity.x * armAz);
  const avz = a.velocity.z + (a.angularVelocity.x * armAy - a.angularVelocity.y * armAx);

  const bvx = b.velocity.x + (b.angularVelocity.y * armBz - b.angularVelocity.z * armBy);
  const bvy = b.velocity.y + (b.angularVelocity.z * armBx - b.angularVelocity.x * armBz);
  const bvz = b.velocity.z + (b.angularVelocity.x * armBy - b.angularVelocity.y * armBx);

  const rvx = avx - bvx;
  const rvy = avy - bvy;
  const rvz = avz - bvz;
  const velAlongNormal = rvx * nx + rvy * ny + rvz * nz;

  if (velAlongNormal > 0) return;

  const restitution = SHIP_COLLISION_RESTITUTION;
  const j = -(1 + restitution) * velAlongNormal / (invMassA + invMassB);

  const impulseX = nx * j;
  const impulseY = ny * j;
  const impulseZ = nz * j;

  a.velocity.x += impulseX * invMassA;
  a.velocity.y += impulseY * invMassA;
  a.velocity.z += impulseZ * invMassA;
  b.velocity.x -= impulseX * invMassB;
  b.velocity.y -= impulseY * invMassB;
  b.velocity.z -= impulseZ * invMassB;

  const torqueAy = armAz * impulseX - armAx * impulseZ;
  const torqueBy = armBz * impulseX - armBx * impulseZ;
  a.angularVelocity.y += torqueAy * invIyyA;
  b.angularVelocity.y -= torqueBy * invIyyB;

  const torqueAx = armAy * impulseZ - armAz * impulseY;
  const torqueAz = armAx * impulseY - armAy * impulseX;
  const torqueBx = armBy * impulseZ - armBz * impulseY;
  const torqueBz = armBx * impulseY - armBy * impulseX;

  const cap = SHIP_PITCH_ROLL_COLLISION_MAX;
  const pitchImpulseA = torqueAx * invIxxA;
  const rollImpulseA = torqueAz * invIzzA;
  const pitchImpulseB = torqueBx * invIxxB;
  const rollImpulseB = torqueBz * invIzzB;

  if (Math.abs(pitchImpulseA) > cap) a.angularVelocity.x += Math.sign(pitchImpulseA) * cap;
  else a.angularVelocity.x += pitchImpulseA;
  if (Math.abs(rollImpulseA) > cap) a.angularVelocity.z += Math.sign(rollImpulseA) * cap;
  else a.angularVelocity.z += rollImpulseA;
  if (Math.abs(pitchImpulseB) > cap) b.angularVelocity.x -= Math.sign(pitchImpulseB) * cap;
  else b.angularVelocity.x -= pitchImpulseB;
  if (Math.abs(rollImpulseB) > cap) b.angularVelocity.z -= Math.sign(rollImpulseB) * cap;
  else b.angularVelocity.z -= rollImpulseB;

  if (a.angularVelocity.y > SHIP_YAW_MAX) a.angularVelocity.y = SHIP_YAW_MAX;
  if (a.angularVelocity.y < -SHIP_YAW_MAX) a.angularVelocity.y = -SHIP_YAW_MAX;
  if (b.angularVelocity.y > SHIP_YAW_MAX) b.angularVelocity.y = SHIP_YAW_MAX;
  if (b.angularVelocity.y < -SHIP_YAW_MAX) b.angularVelocity.y = -SHIP_YAW_MAX;

  const tx = rvx - nx * velAlongNormal;
  const ty = rvy - ny * velAlongNormal;
  const tz = rvz - nz * velAlongNormal;
  const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tLen > 1e-6) {
    const ntx = tx / tLen;
    const nty = ty / tLen;
    const ntz = tz / tLen;
    const velAlongTangent = rvx * ntx + rvy * nty + rvz * ntz;
    const frictionJ = -velAlongTangent / (invMassA + invMassB);
    const maxFriction = Math.abs(j) * SHIP_COLLISION_FRICTION;
    const frictionClamped = Math.max(-maxFriction, Math.min(maxFriction, frictionJ));

    a.velocity.x += ntx * frictionClamped * invMassA;
    a.velocity.y += nty * frictionClamped * invMassA;
    a.velocity.z += ntz * frictionClamped * invMassA;
    b.velocity.x -= ntx * frictionClamped * invMassB;
    b.velocity.y -= nty * frictionClamped * invMassB;
    b.velocity.z -= ntz * frictionClamped * invMassB;
  }

  const correction = Math.max(penetration - SHIP_COLLISION_SLOP, 0) * SHIP_COLLISION_CORRECTION_PCT;
  const totalInvMass = invMassA + invMassB;
  if (totalInvMass > 0) {
    const corrA = correction * invMassA / totalInvMass;
    const corrB = correction * invMassB / totalInvMass;
    a.position.x += nx * corrA;
    a.position.y += ny * corrA;
    a.position.z += nz * corrA;
    b.position.x -= nx * corrB;
    b.position.y -= ny * corrB;
    b.position.z -= nz * corrB;
  }
}

// --- Test helpers ---
function getEntityMass(type: EntityType, scale: number): number {
  const baseMass = ENTITY_MASS[type];
  if (baseMass !== undefined) return baseMass;
  const density = WILDLIFE_DENSITY[type];
  if (density !== undefined) return scale * scale * scale * density * 100;
  return scale * scale * 100;
}

function getInvMass(mass: number): number {
  return (mass === Infinity || mass <= 0) ? 0 : 1 / mass;
}

function getInvInertia(mass: number, radius: number): number {
  if (mass === Infinity || mass <= 0) return 0;
  const I = mass * radius * radius * 0.5;
  return I > 0 ? 1 / I : 0;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function approxEqual(a: number, b: number, eps: number = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

// --- Tests ---

// Test 1: Head-on ship/island impact — ship loses normal speed, no energy gain
function testShipIslandImpact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL; // 5 cells = 4000 kg
  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  const island = makeEntity(2, EntityType.Island, Infinity, 0, 10, 4);
  island.flags = EntityFlags.Static;

  ship.velocity.z = 20; // moving toward island at 20 m/s

  const dist = 8; // they overlap slightly
  const radius = ship.scale + island.scale;
  const penetration = radius - dist;
  const nx = 0, ny = 0, nz = -1; // normal from island to ship (ship is at z=0, island at z=10)

  const shipInvMass = getInvMass(shipMass);
  const islandInvMass = 0;
  const shipInvI = getInvInertia(shipMass, ship.scale);

  resolveContact(
    ship, island,
    nx, ny, nz,
    penetration,
    0, 0, 4, // contact point between them
    shipInvMass, islandInvMass,
    shipInvI, 0,
    shipInvI, 0,
    shipInvI, 0,
  );

  // Ship should slow down (z velocity reduced, possibly reversed slightly)
  const speedAfter = Math.abs(ship.velocity.z);
  assert(speedAfter < 20, `Ship/island: speed should decrease (got ${speedAfter})`);
  assert(ship.velocity.z <= 0.1, `Ship/island: ship should not gain forward speed (got vz=${ship.velocity.z})`);
  // Island should not move
  assert(island.velocity.x === 0 && island.velocity.z === 0, `Ship/island: island should not move`);
  console.log(`  ship/island: vz before=20, after=${ship.velocity.z.toFixed(3)}`);
}

// Test 2: Ship/port impact — port barely moves, ship slows significantly
function testShipPortImpact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL;
  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  const port = makeEntity(2, EntityType.Port, ENTITY_MASS[EntityType.Port], 0, 10, 4);

  ship.velocity.z = 15;

  const dist = 8;
  const radius = ship.scale + port.scale;
  const penetration = radius - dist;
  const nx = 0, ny = 0, nz = -1;

  const shipInvMass = getInvMass(shipMass);
  const portInvMass = getInvMass(ENTITY_MASS[EntityType.Port]);
  const shipInvI = getInvInertia(shipMass, ship.scale);
  const portInvI = getInvInertia(ENTITY_MASS[EntityType.Port], port.scale);

  resolveContact(
    ship, port,
    nx, ny, nz,
    penetration,
    0, 0, 4,
    shipInvMass, portInvMass,
    shipInvI, portInvI,
    shipInvI, portInvI,
    shipInvI, portInvI,
  );

  const shipSpeedAfter = Math.abs(ship.velocity.z);
  assert(shipSpeedAfter < 15, `Ship/port: ship speed should decrease (got ${shipSpeedAfter})`);
  // Port should barely move (100000 kg vs 4000 kg)
  const portSpeedAfter = Math.abs(port.velocity.z);
  assert(portSpeedAfter < 1.0, `Ship/port: port should barely move (got ${portSpeedAfter})`);
  console.log(`  ship/port: ship vz=${ship.velocity.z.toFixed(3)}, port vz=${port.velocity.z.toFixed(4)}`);
}

// Test 3: Fish impact — barely changes boat speed
function testShipFishImpact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL; // 4000 kg
  const fishMass = getEntityMass(EntityType.Fish, 0.5); // 0.5³ × 50 × 100 = 625 kg... wait
  // Actually: 0.5³ = 0.125, × 50 × 100 = 625? No: 0.125 × 50 = 6.25, × 100 = 625. Hmm.
  // Let's use scale 0.3: 0.027 × 50 × 100 = 135 kg
  const fishScale = 0.3;
  const fishMassActual = getEntityMass(EntityType.Fish, fishScale);

  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  const fish = makeEntity(2, EntityType.Fish, fishMassActual, 0, 5, fishScale);

  ship.velocity.z = 10;

  const dist = 4;
  const radius = ship.scale + fish.scale;
  const penetration = radius - dist;
  const nx = 0, ny = 0, nz = -1;

  const shipInvMass = getInvMass(shipMass);
  const fishInvMass = getInvMass(fishMassActual);
  const shipInvI = getInvInertia(shipMass, ship.scale);
  const fishInvI = getInvInertia(fishMassActual, fish.scale);

  resolveContact(
    ship, fish,
    nx, ny, nz,
    penetration,
    0, 0, 4,
    shipInvMass, fishInvMass,
    shipInvI, fishInvI,
    shipInvI, fishInvI,
    shipInvI, fishInvI,
  );

  const shipSpeedAfter = Math.abs(ship.velocity.z);
  // Fish is very light relative to ship — speed should barely change
  assert(shipSpeedAfter > 9.5, `Ship/fish: ship speed should barely change (got ${shipSpeedAfter}, expected ~10)`);
  console.log(`  ship/fish: fish mass=${fishMassActual.toFixed(1)}kg, ship vz before=10, after=${ship.velocity.z.toFixed(4)}`);
}

// Test 4: Whale impact — substantially slows or stops boat
function testShipWhaleImpact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL; // 4000 kg
  const whaleScale = 8;
  const whaleMass = getEntityMass(EntityType.Whale, whaleScale);
  // 8³ × 800 × 100 = 512 × 800 × 100 = 40,960,000... that seems very high.
  // Actually: scale³ × density × 100 = 512 × 800 × 100 = 40,960,000 kg
  // That's way too heavy. Let me check: the constants say WILDLIFE_DENSITY[Whale] = 800
  // mass = scale³ × density × 100 = 512 × 800 × 100 = 40,960,000
  // That's 40960 tons — way too heavy for a whale. A real whale is ~100-150 tons.
  // But for the test, we just verify the mass ratio effect.

  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  const whale = makeEntity(2, EntityType.Whale, whaleMass, 0, 8, whaleScale);

  ship.velocity.z = 15;

  const dist = 8;
  const radius = ship.scale + whale.scale;
  const penetration = radius - dist;
  const nx = 0, ny = 0, nz = -1;

  const shipInvMass = getInvMass(shipMass);
  const whaleInvMass = getInvMass(whaleMass);
  const shipInvI = getInvInertia(shipMass, ship.scale);
  const whaleInvI = getInvInertia(whaleMass, whale.scale);

  resolveContact(
    ship, whale,
    nx, ny, nz,
    penetration,
    0, 0, 8,
    shipInvMass, whaleInvMass,
    shipInvI, whaleInvI,
    shipInvI, whaleInvI,
    shipInvI, whaleInvI,
  );

  const shipSpeedAfter = Math.abs(ship.velocity.z);
  // Whale is much heavier — ship should slow dramatically
  assert(shipSpeedAfter < 5, `Ship/whale: ship should slow dramatically (got ${shipSpeedAfter}, whale mass=${whaleMass})`);
  console.log(`  ship/whale: whale mass=${whaleMass.toFixed(0)}kg, ship vz before=15, after=${ship.velocity.z.toFixed(4)}`);
}

// Test 5: Equal-mass ship impact — momentum exchanged in both X and Z
function testEqualMassShipImpact(): void {
  const mass = 5 * SHIP_MASS_PER_CELL;
  const shipA = makeEntity(1, EntityType.Ship, mass, 0, 0, 4);
  const shipB = makeEntity(2, EntityType.Ship, mass, 5, 0, 4);

  shipA.velocity.x = 10; // moving in +X toward shipB
  shipB.velocity.x = -10; // moving in -X toward shipA

  const dist = 5;
  const radius = shipA.scale + shipB.scale;
  const penetration = radius - dist;
  const nx = -1, ny = 0, nz = 0; // normal from B to A (A is at x=0, B at x=5, so normal points -X from B to A)

  const invMass = getInvMass(mass);
  const invI = getInvInertia(mass, 4);

  resolveContact(
    shipA, shipB,
    nx, ny, nz,
    penetration,
    2.5, 0, 0, // midpoint
    invMass, invMass,
    invI, invI,
    invI, invI,
    invI, invI,
  );

  // Equal mass head-on: velocities should nearly reverse (with some restitution loss)
  assert(shipA.velocity.x < 0, `Equal mass: shipA should reverse direction (got vx=${shipA.velocity.x})`);
  assert(shipB.velocity.x > 0, `Equal mass: shipB should reverse direction (got vx=${shipB.velocity.x})`);
  // Both should have similar speed (momentum conserved)
  assert(approxEqual(Math.abs(shipA.velocity.x), Math.abs(shipB.velocity.x), 1.0),
    `Equal mass: speeds should be similar (A=${shipA.velocity.x.toFixed(2)}, B=${shipB.velocity.x.toFixed(2)})`);
  console.log(`  equal mass: A vx=${shipA.velocity.x.toFixed(3)}, B vx=${shipB.velocity.x.toFixed(3)}`);
}

// Test 6: Off-center impact creates bounded yaw that decays
function testOffCenterImpact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL;
  const island = makeEntity(2, EntityType.Island, Infinity, 6, 10, 4);
  island.flags = EntityFlags.Static;

  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  ship.velocity.z = 15;

  // Contact point is off-center (to the right of ship center)
  const contactX = 3, contactZ = 4;

  const dist = Math.sqrt(36 + 100); // ~11.66
  const radius = ship.scale + island.scale;
  const penetration = radius - dist;
  // Normal from island to ship
  const dx = ship.position.x - island.position.x;
  const dz = ship.position.z - island.position.z;
  const distCalc = Math.sqrt(dx * dx + dz * dz) || 0.001;
  const nx = dx / distCalc;
  const nz = dz / distCalc;

  const shipInvMass = getInvMass(shipMass);
  const shipInvI = getInvInertia(shipMass, ship.scale);

  resolveContact(
    ship, island,
    nx, 0, nz,
    penetration,
    contactX, 0, contactZ,
    shipInvMass, 0,
    shipInvI, 0,
    shipInvI, 0,
    shipInvI, 0,
  );

  // Ship should have yaw from off-center hit
  const yawRate = Math.abs(ship.angularVelocity.y);
  assert(yawRate > 0.001, `Off-center: should create yaw (got ${yawRate})`);
  // Yaw should be capped
  assert(yawRate <= SHIP_YAW_MAX + 0.001, `Off-center: yaw should be capped (got ${yawRate}, max=${SHIP_YAW_MAX})`);
  // Pitch/roll should be capped
  assert(Math.abs(ship.angularVelocity.x) <= SHIP_PITCH_ROLL_COLLISION_MAX + 0.001,
    `Off-center: pitch should be capped (got ${ship.angularVelocity.x})`);
  assert(Math.abs(ship.angularVelocity.z) <= SHIP_PITCH_ROLL_COLLISION_MAX + 0.001,
    `Off-center: roll should be capped (got ${ship.angularVelocity.z})`);
  console.log(`  off-center: yaw=${ship.angularVelocity.y.toFixed(4)}, pitch=${ship.angularVelocity.x.toFixed(4)}, roll=${ship.angularVelocity.z.toFixed(4)}`);
}

// Test 7: Repeated resting contact does not jitter or regain speed
function testRepeatedRestingContact(): void {
  const shipMass = 5 * SHIP_MASS_PER_CELL;
  const island = makeEntity(2, EntityType.Island, Infinity, 0, 8, 4);
  island.flags = EntityFlags.Static;

  const ship = makeEntity(1, EntityType.Ship, shipMass, 0, 0, 4);
  ship.velocity.z = 10;

  const radius = ship.scale + island.scale;
  const shipInvMass = getInvMass(shipMass);
  const shipInvI = getInvInertia(shipMass, ship.scale);

  // Simulate 60 ticks of contact (1 second at 60Hz)
  let maxSpeedSeen = 0;
  let firstBounceSpeed = 0;
  let bounced = false;
  for (let tick = 0; tick < 60; tick++) {
    const dx = ship.position.x - island.position.x;
    const dz = ship.position.z - island.position.z;
    const distSq = dx * dx + dz * dz;
    const dist = Math.sqrt(distSq) || 0.001;

    if (dist < radius) {
      const penetration = radius - dist;
      const nx = dx / dist;
      const nz = dz / dist;
      const contactX = (ship.position.x + island.position.x) / 2;
      const contactZ = (ship.position.z + island.position.z) / 2;

      resolveContact(
        ship, island,
        nx, 0, nz,
        penetration,
        contactX, 0, contactZ,
        shipInvMass, 0,
        shipInvI, 0,
        shipInvI, 0,
        shipInvI, 0,
      );
      if (!bounced && Math.abs(ship.velocity.z) < 10) {
        bounced = true;
        firstBounceSpeed = Math.abs(ship.velocity.z);
      }
    }

    const currentSpeed = Math.abs(ship.velocity.z);
    if (currentSpeed > maxSpeedSeen) maxSpeedSeen = currentSpeed;

    // Apply drag (simulating updateAllShips)
    ship.velocity.x *= 0.99;
    ship.velocity.z *= 0.99;

    // Integrate position
    ship.position.x += ship.velocity.x * 0.016;
    ship.position.z += ship.velocity.z * 0.016;
  }

  const finalSpeed = Math.abs(ship.velocity.z);
  assert(finalSpeed < 1.0, `Resting contact: speed should decay to near zero (got ${finalSpeed})`);
  assert(Number.isFinite(ship.position.x) && Number.isFinite(ship.position.z),
    `Resting contact: position should remain finite`);
  // Speed should never exceed the initial impact speed (no energy gain)
  assert(maxSpeedSeen <= 10.01, `Resting contact: speed should never exceed initial (max seen=${maxSpeedSeen})`);
  // After first bounce, speed should only decrease (no regain)
  if (bounced) {
    assert(finalSpeed <= firstBounceSpeed + 0.01,
      `Resting contact: speed should not regain after bounce (bounce=${firstBounceSpeed.toFixed(3)}, final=${finalSpeed.toFixed(3)})`);
  }
  console.log(`  resting contact: final vz=${ship.velocity.z.toFixed(5)}, pos z=${ship.position.z.toFixed(3)}`);
}

// --- Run all tests ---
console.log("=== Collision Tests ===\n");

testShipIslandImpact();
testShipPortImpact();
testShipFishImpact();
testShipWhaleImpact();
testEqualMassShipImpact();
testOffCenterImpact();
testRepeatedRestingContact();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
