// Deterministic buoyancy regression tests for heading-invariant pitch/roll recovery
// Run with: bun test src/simulation/physics/BuoyancySystem.spec.ts

import {
    BOAT_CELL_WORLD_SIZE,
    BOAT_LAYER_HEIGHT,
    BoatCellType,
    isHullShellCell,
    SHIP_MASS_PER_CELL
} from "../../shared/constants";

// --- Physics constants (must match BuoyancySystem.ts) ---
const GRAVITY = 9.8;
const WATER_DENSITY = 1000;
const MAX_TILT = Math.PI / 6;
const RESTORING_STIFFNESS = 20.0;
const VERTICAL_DAMPING = 5.0;
const ANGULAR_DAMPING = 4.0;
const ANGULAR_DEADZONE = 0.008;
const TILT_SETTLE_THRESHOLD = 0.009;
const DT = 1 / 60;
const FLAT_WATER_HEIGHT = 0;

// --- Boat cell layout ---
interface TestCell {
  type: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

// Monohull: 3×3 grid of HULL cells at layer 0
function makeMonohullCells(): TestCell[] {
  const cells: TestCell[] = [];
  for (let gx = -1; gx <= 1; gx++) {
    for (let gz = -1; gz <= 1; gz++) {
      cells.push({ type: BoatCellType.HULL, gridX: gx, gridY: 0, gridZ: gz, sizeX: 1, sizeY: 1, sizeZ: 1 });
    }
  }
  return cells;
}

// Catamaran: two 3-cell pontoons at x=±3, plus bridge deck on top
function makeCatamaranCells(): TestCell[] {
  const cells: TestCell[] = [];
  for (let gz = 0; gz <= 2; gz++) {
    cells.push({ type: BoatCellType.PONTOON, gridX: -3, gridY: 0, gridZ: gz, sizeX: 1, sizeY: 1, sizeZ: 1 });
    cells.push({ type: BoatCellType.PONTOON, gridX: 3, gridY: 0, gridZ: gz, sizeX: 1, sizeY: 1, sizeZ: 1 });
  }
  // Bridge deck on top (adds mass, but is NOT a hull shell cell — no buoyancy)
  for (let gx = -3; gx <= 3; gx++) {
    cells.push({ type: BoatCellType.BRIDGE, gridX: gx, gridY: 1, gridZ: 1, sizeX: 1, sizeY: 1, sizeZ: 1 });
  }
  return cells;
}

// --- Mass properties computation (inlined from BoatCellSystem.getMassProperties) ---
interface MassProps {
  mass: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  Ixx: number;
  Izz: number;
}

function computeMassProperties(cells: TestCell[]): MassProps {
  let totalMass = 0;
  let sumMx = 0, sumMy = 0, sumMz = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cellVolume = cell.sizeX * cell.sizeY * cell.sizeZ;
    const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const ly = cell.gridY * BOAT_LAYER_HEIGHT + cell.sizeY * BOAT_LAYER_HEIGHT / 2;
    const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2;
    const m = SHIP_MASS_PER_CELL * cellVolume;
    totalMass += m;
    sumMx += lx * m;
    sumMy += ly * m;
    sumMz += lz * m;
  }

  const cx = sumMx / totalMass;
  const cy = sumMy / totalMass;
  const cz = sumMz / totalMass;

  let Ixx = 0, Izz = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const cellVolume = cell.sizeX * cell.sizeY * cell.sizeZ;
    const lx = cell.gridX * BOAT_CELL_WORLD_SIZE + (cell.sizeX - 1) * BOAT_CELL_WORLD_SIZE / 2 - cx;
    const ly = cell.gridY * BOAT_LAYER_HEIGHT + cell.sizeY * BOAT_LAYER_HEIGHT / 2 - cy;
    const lz = cell.gridZ * BOAT_CELL_WORLD_SIZE + (cell.sizeZ - 1) * BOAT_CELL_WORLD_SIZE / 2 - cz;
    const m = SHIP_MASS_PER_CELL * cellVolume;
    Ixx += m * (lz * lz + ly * ly);
    Izz += m * (lx * lx + ly * ly);
  }

  return { mass: totalMass, centerX: cx, centerY: cy, centerZ: cz, Ixx, Izz };
}

// --- Buoyancy state ---
interface BuoyState {
  y: number;
  vy: number;
  pitch: number;
  roll: number;
  angVelX: number;
  angVelZ: number;
}

// --- Inlined buoyancy tick (matches BuoyancySystem.applyCellBuoyancy + integrateBuoyancy) ---
// Uses flat water at FLAT_WATER_HEIGHT for deterministic testing.
function buoyancyTick(
  state: BuoyState,
  heading: number,
  cells: TestCell[],
  mp: MassProps,
): void {
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  const cosP = Math.cos(state.pitch);
  const sinP = Math.sin(state.pitch);
  const cosR = Math.cos(state.roll);
  const sinR = Math.sin(state.roll);

  const cellArea = BOAT_CELL_WORLD_SIZE * BOAT_CELL_WORLD_SIZE;
  const cellHeight = BOAT_LAYER_HEIGHT;

  let totalForceY = 0;
  let totalTorqueX = 0;
  let totalTorqueZ = 0;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!isHullShellCell(cell.type)) continue;

    const localX = cell.gridX * BOAT_CELL_WORLD_SIZE;
    const localY = cell.gridY * BOAT_LAYER_HEIGHT + BOAT_LAYER_HEIGHT / 2;
    const localZ = cell.gridZ * BOAT_CELL_WORLD_SIZE;

    const armX = localX - mp.centerX;
    const armY = localY - mp.centerY;
    const armZ = localZ - mp.centerZ;

    // Yaw-only horizontal position for water sampling
    const yawX = armX * cosH + armZ * sinH;
    const yawZ = -armX * sinH + armZ * cosH;
    const sampleX = yawX; // ship at origin
    const sampleZ = yawZ;

    // Full rotation for vertical position
    const pY = armY * cosP - armZ * sinP;
    const rY = armX * sinR + pY * cosR;
    const worldY = state.y + rY;

    // Flat water — no wave variation
    const waterHeight = FLAT_WATER_HEIGHT;

    const cellBottom = worldY - cellHeight / 2;
    if (waterHeight <= cellBottom) continue;

    const submersionDepth = Math.min(waterHeight - cellBottom, cellHeight);
    const submergedVolume = cellArea * submersionDepth;
    const buoyancyForce = WATER_DENSITY * submergedVolume * GRAVITY;

    totalForceY += buoyancyForce;

    // LOCAL-frame torque (the fix): use armX/armZ, not yawX/yawZ
    totalTorqueX += -armZ * buoyancyForce;
    totalTorqueZ += armX * buoyancyForce;
  }

  // --- integrateBuoyancy ---
  const gravityForce = mp.mass * GRAVITY;
  const netForceY = totalForceY - gravityForce;
  state.vy += (netForceY / mp.mass) * DT;
  state.vy *= Math.max(0, 1 - VERTICAL_DAMPING * DT);

  if (mp.Ixx > 0) state.angVelX += (totalTorqueX / mp.Ixx) * DT;
  if (mp.Izz > 0) state.angVelZ += (totalTorqueZ / mp.Izz) * DT;

  // Restoring torque
  state.angVelX -= state.pitch * RESTORING_STIFFNESS * DT;
  state.angVelZ -= state.roll * RESTORING_STIFFNESS * DT;

  // Angular damping
  state.angVelX *= Math.max(0, 1 - ANGULAR_DAMPING * DT);
  state.angVelZ *= Math.max(0, 1 - ANGULAR_DAMPING * DT);

  // NaN guard
  if (!Number.isFinite(state.angVelX)) state.angVelX = 0;
  if (!Number.isFinite(state.angVelZ)) state.angVelZ = 0;

  // Integrate
  let newPitch = state.pitch + state.angVelX * DT;
  let newRoll = state.roll + state.angVelZ * DT;

  if (!Number.isFinite(newPitch)) newPitch = 0;
  if (!Number.isFinite(newRoll)) newRoll = 0;

  // Clamp
  if (newPitch > MAX_TILT) { newPitch = MAX_TILT; state.angVelX = 0; }
  else if (newPitch < -MAX_TILT) { newPitch = -MAX_TILT; state.angVelX = 0; }
  if (newRoll > MAX_TILT) { newRoll = MAX_TILT; state.angVelZ = 0; }
  else if (newRoll < -MAX_TILT) { newRoll = -MAX_TILT; state.angVelZ = 0; }

  state.pitch = newPitch;
  state.roll = newRoll;

  // Integrate vertical position
  state.y += state.vy * DT;
}

// --- Test helpers ---
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

function approxEqual(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) < eps;
}

// --- Run a simulation and record pitch/roll over time ---
interface SimResult {
  pitchHistory: number[];
  rollHistory: number[];
  angVelXHistory: number[];
  angVelZHistory: number[];
  settleTick: number; // first tick where |pitch| and |roll| are both < TILT_SETTLE_THRESHOLD and stay there
  finalPitch: number;
  finalRoll: number;
  maxPitch: number;
  maxRoll: number;
  finite: boolean;
}

function simulate(
  cells: TestCell[],
  heading: number,
  initialPitch: number,
  initialRoll: number,
  initialAngVelX: number,
  initialAngVelZ: number,
  totalTicks: number,
): SimResult {
  const mp = computeMassProperties(cells);
  const state: BuoyState = {
    y: 0,
    vy: 0,
    pitch: initialPitch,
    roll: initialRoll,
    angVelX: initialAngVelX,
    angVelZ: initialAngVelZ,
  };

  const pitchHistory: number[] = new Array(totalTicks);
  const rollHistory: number[] = new Array(totalTicks);
  const angVelXHistory: number[] = new Array(totalTicks);
  const angVelZHistory: number[] = new Array(totalTicks);

  let maxPitch = Math.abs(initialPitch);
  let maxRoll = Math.abs(initialRoll);
  let finite = true;
  let settleTick = -1;
  let consecutiveSettled = 0;

  for (let t = 0; t < totalTicks; t++) {
    buoyancyTick(state, heading, cells, mp);
    pitchHistory[t] = state.pitch;
    rollHistory[t] = state.roll;
    angVelXHistory[t] = state.angVelX;
    angVelZHistory[t] = state.angVelZ;

    if (!Number.isFinite(state.pitch) || !Number.isFinite(state.roll) ||
        !Number.isFinite(state.angVelX) || !Number.isFinite(state.angVelZ) ||
        !Number.isFinite(state.y)) {
      finite = false;
      break;
    }

    const absP = Math.abs(state.pitch);
    const absR = Math.abs(state.roll);
    if (absP > maxPitch) maxPitch = absP;
    if (absR > maxRoll) maxRoll = absR;

    // Check for settling: both pitch and roll stay below threshold for 30 consecutive ticks (0.5s)
    if (settleTick < 0 && absP < TILT_SETTLE_THRESHOLD && absR < TILT_SETTLE_THRESHOLD) {
      consecutiveSettled++;
      if (consecutiveSettled >= 30) {
        settleTick = t - 29;
      }
    } else {
      consecutiveSettled = 0;
    }
  }

  return {
    pitchHistory,
    rollHistory,
    angVelXHistory,
    angVelZHistory,
    settleTick,
    finalPitch: state.pitch,
    finalRoll: state.roll,
    maxPitch,
    maxRoll,
    finite,
  };
}

// Compute oscillation envelope maxima for decay checking
function findEnvelopePeaks(history: number[]): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < history.length - 1; i++) {
    const prev = Math.abs(history[i - 1]);
    const curr = Math.abs(history[i]);
    const next = Math.abs(history[i + 1]);
    if (curr >= prev && curr >= next && curr > 0.001) {
      peaks.push(curr);
    }
  }
  return peaks;
}

// --- Test scenarios ---

const HEADINGS = [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 3];
const HEADING_NAMES = ["0", "π/4", "π/2", "π", "-π/3"];
const SETTLE_TICK_LIMIT = 360; // 6 seconds at 60Hz
const SIM_TICKS = 600; // 10 seconds

// Test 1: Heading invariance — same disturbance produces same local pitch/roll at every heading
function testHeadingInvariance(
  name: string,
  cells: TestCell[],
  initialPitch: number,
  initialRoll: number,
  initialAngVelX: number,
  initialAngVelZ: number,
): void {
  const results: SimResult[] = [];
  for (let h = 0; h < HEADINGS.length; h++) {
    results.push(simulate(cells, HEADINGS[h], initialPitch, initialRoll, initialAngVelX, initialAngVelZ, SIM_TICKS));
  }

  // All runs must be finite
  for (let h = 0; h < results.length; h++) {
    assert(results[h].finite, `${name} heading=${HEADING_NAMES[h]}: state must remain finite`);
  }

  // Compare pitch/roll histories — they should be nearly identical across headings
  const eps = 0.001; // 0.001 rad tolerance
  for (let h = 1; h < results.length; h++) {
    for (let t = 0; t < SIM_TICKS; t++) {
      assert(
        approxEqual(results[0].pitchHistory[t], results[h].pitchHistory[t], eps),
        `${name} heading=${HEADING_NAMES[h]}: pitch at tick ${t} should match heading=0 (got ${results[h].pitchHistory[t].toFixed(6)}, expected ${results[0].pitchHistory[t].toFixed(6)})`,
      );
      assert(
        approxEqual(results[0].rollHistory[t], results[h].rollHistory[t], eps),
        `${name} heading=${HEADING_NAMES[h]}: roll at tick ${t} should match heading=0 (got ${results[h].rollHistory[t].toFixed(6)}, expected ${results[0].rollHistory[t].toFixed(6)})`,
      );
    }
  }

  console.log(`  ${name}: heading invariance OK (compared ${HEADINGS.length} headings, ${SIM_TICKS} ticks each)`);
}

// Test 2: Settling — boat settles within 4-6 seconds
function testSettling(
  name: string,
  cells: TestCell[],
  initialPitch: number,
  initialRoll: number,
  initialAngVelX: number,
  initialAngVelZ: number,
): void {
  const result = simulate(cells, 0, initialPitch, initialRoll, initialAngVelX, initialAngVelZ, SIM_TICKS);

  assert(result.finite, `${name}: state must remain finite`);

  // Must settle within 6 seconds (360 ticks)
  assert(
    result.settleTick >= 0 && result.settleTick <= SETTLE_TICK_LIMIT,
    `${name}: should settle within ${SETTLE_TICK_LIMIT} ticks (6s), got settleTick=${result.settleTick}`,
  );

  // After settling, should stay settled (with small tolerance for minor oscillation without snap)
  if (result.settleTick >= 0) {
    for (let t = result.settleTick; t < SIM_TICKS; t++) {
      assert(
        Math.abs(result.pitchHistory[t]) < TILT_SETTLE_THRESHOLD * 2,
        `${name}: pitch should stay settled after tick ${result.settleTick} (tick ${t}: ${result.pitchHistory[t]})`,
      );
    }
  }

  const settleTime = result.settleTick >= 0 ? (result.settleTick * DT).toFixed(2) : "never";
  console.log(`  ${name}: settled at tick ${result.settleTick} (${settleTime}s), final pitch=${result.finalPitch.toFixed(6)}, roll=${result.finalRoll.toFixed(6)}`);
}

// Test 3: Decaying oscillation envelope
function testDecayingEnvelope(
  name: string,
  cells: TestCell[],
  initialPitch: number,
  initialRoll: number,
): void {
  const result = simulate(cells, 0, initialPitch, initialRoll, 0, 0, SIM_TICKS);
  assert(result.finite, `${name}: state must remain finite`);

  // Check pitch envelope if pitch disturbance was applied
  if (Math.abs(initialPitch) > 0.01) {
    const pitchPeaks = findEnvelopePeaks(result.pitchHistory);
    if (pitchPeaks.length >= 2) {
      for (let i = 1; i < pitchPeaks.length; i++) {
        assert(
          pitchPeaks[i] <= pitchPeaks[i - 1] + 0.001,
          `${name}: pitch envelope should be non-increasing (peak ${i}: ${pitchPeaks[i].toFixed(6)} > prev ${pitchPeaks[i - 1].toFixed(6)})`,
        );
      }
    }
    console.log(`  ${name}: pitch peaks: ${pitchPeaks.map(p => p.toFixed(4)).join(" → ")}`);
  }

  // Check roll envelope if roll disturbance was applied
  if (Math.abs(initialRoll) > 0.01) {
    const rollPeaks = findEnvelopePeaks(result.rollHistory);
    if (rollPeaks.length >= 2) {
      for (let i = 1; i < rollPeaks.length; i++) {
        assert(
          rollPeaks[i] <= rollPeaks[i - 1] + 0.001,
          `${name}: roll envelope should be non-increasing (peak ${i}: ${rollPeaks[i].toFixed(6)} > prev ${rollPeaks[i - 1].toFixed(6)})`,
        );
      }
    }
    console.log(`  ${name}: roll peaks: ${rollPeaks.map(p => p.toFixed(4)).join(" → ")}`);
  }
}

// Test 4: No cross-axis energy growth
function testNoCrossAxisGrowth(
  name: string,
  cells: TestCell[],
  initialPitch: number,
  initialRoll: number,
): void {
  const result = simulate(cells, 0, initialPitch, initialRoll, 0, 0, SIM_TICKS);
  assert(result.finite, `${name}: state must remain finite`);

  // If we start with pure pitch (no roll), roll should stay near zero
  if (Math.abs(initialPitch) > 0.01 && Math.abs(initialRoll) < 0.001) {
    let maxRollDev = 0;
    for (let t = 0; t < SIM_TICKS; t++) {
      const dev = Math.abs(result.rollHistory[t]);
      if (dev > maxRollDev) maxRollDev = dev;
    }
    assert(
      maxRollDev < 0.01,
      `${name}: pure pitch should not induce significant roll (max roll dev=${maxRollDev.toFixed(6)})`,
    );
    console.log(`  ${name}: max roll deviation from pure pitch = ${maxRollDev.toFixed(6)}`);
  }

  // If we start with pure roll (no pitch), pitch should stay near zero
  if (Math.abs(initialRoll) > 0.01 && Math.abs(initialPitch) < 0.001) {
    let maxPitchDev = 0;
    for (let t = 0; t < SIM_TICKS; t++) {
      const dev = Math.abs(result.pitchHistory[t]);
      if (dev > maxPitchDev) maxPitchDev = dev;
    }
    assert(
      maxPitchDev < 0.01,
      `${name}: pure roll should not induce significant pitch (max pitch dev=${maxPitchDev.toFixed(6)})`,
    );
    console.log(`  ${name}: max pitch deviation from pure roll = ${maxPitchDev.toFixed(6)}`);
  }
}

// Test 5: Bounded state — all values within MAX_TILT
function testBoundedState(
  name: string,
  cells: TestCell[],
  initialPitch: number,
  initialRoll: number,
  initialAngVelX: number,
  initialAngVelZ: number,
): void {
  const result = simulate(cells, 0, initialPitch, initialRoll, initialAngVelX, initialAngVelZ, SIM_TICKS);
  assert(result.finite, `${name}: state must remain finite`);

  assert(
    result.maxPitch <= MAX_TILT + 0.001,
    `${name}: pitch should stay within MAX_TILT (max=${result.maxPitch.toFixed(6)}, limit=${MAX_TILT})`,
  );
  assert(
    result.maxRoll <= MAX_TILT + 0.001,
    `${name}: roll should stay within MAX_TILT (max=${result.maxRoll.toFixed(6)}, limit=${MAX_TILT})`,
  );
}

// --- Run all tests ---
console.log("=== Buoyancy Heading-Invariance & Settling Tests ===\n");

const monohull = makeMonohullCells();
const catamaran = makeCatamaranCells();

const mpMono = computeMassProperties(monohull);
const mpCat = computeMassProperties(catamaran);
console.log(`Monohull: mass=${mpMono.mass.toFixed(0)}kg, Ixx=${mpMono.Ixx.toFixed(0)}, Izz=${mpMono.Izz.toFixed(0)}`);
console.log(`Catamaran: mass=${mpCat.mass.toFixed(0)}kg, Ixx=${mpCat.Ixx.toFixed(0)}, Izz=${mpCat.Izz.toFixed(0)}`);
console.log("");

// Disturbance magnitudes
const PITCH_DIST = 0.15;   // ~8.6°
const ROLL_DIST = 0.15;    // ~8.6°
const COMBINED_DIST = 0.1; // ~5.7° each
const JOLT_VEL = 0.5;      // rad/s

const scenarios = [
  { name: "pure-pitch", pitch: PITCH_DIST, roll: 0, avx: 0, avz: 0 },
  { name: "pure-roll", pitch: 0, roll: ROLL_DIST, avx: 0, avz: 0 },
  { name: "combined-tilt", pitch: COMBINED_DIST, roll: COMBINED_DIST, avx: 0, avz: 0 },
  { name: "pitch-jolt", pitch: 0, roll: 0, avx: JOLT_VEL, avz: 0 },
  { name: "roll-jolt", pitch: 0, roll: 0, avx: 0, avz: JOLT_VEL },
];

for (let s = 0; s < scenarios.length; s++) {
  const sc = scenarios[s];
  const monoName = `monohull/${sc.name}`;
  const catName = `catamaran/${sc.name}`;

  console.log(`\n--- ${sc.name} ---`);

  // Heading invariance
  testHeadingInvariance(monoName, monohull, sc.pitch, sc.roll, sc.avx, sc.avz);
  testHeadingInvariance(catName, catamaran, sc.pitch, sc.roll, sc.avx, sc.avz);

  // Settling
  testSettling(monoName, monohull, sc.pitch, sc.roll, sc.avx, sc.avz);
  testSettling(catName, catamaran, sc.pitch, sc.roll, sc.avx, sc.avz);

  // Decaying envelope
  testDecayingEnvelope(monoName, monohull, sc.pitch, sc.roll);
  testDecayingEnvelope(catName, catamaran, sc.pitch, sc.roll);

  // No cross-axis growth
  testNoCrossAxisGrowth(monoName, monohull, sc.pitch, sc.roll);
  testNoCrossAxisGrowth(catName, catamaran, sc.pitch, sc.roll);

  // Bounded state
  testBoundedState(monoName, monohull, sc.pitch, sc.roll, sc.avx, sc.avz);
  testBoundedState(catName, catamaran, sc.pitch, sc.roll, sc.avx, sc.avz);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
