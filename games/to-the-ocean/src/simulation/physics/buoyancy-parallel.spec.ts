// Tests for parallel buoyancy computation — verifies computeBuoyancyBatch
// produces correct force/torque values for known inputs.
// Run with: bun test src/simulation/physics/buoyancy-parallel.spec.ts
// (Uses custom harness to avoid bun:test workspace resolution issues)

import {
    BOAT_CELL_WORLD_SIZE,
    BoatCellType,
    getCellGeometry
} from "../../shared/constants";
import { computeBuoyancyBatch, type BuoyancyComputeInput } from "./buoyancy-compute";

// Physics constants (must match buoyancy-compute.ts)
const GRAVITY = 9.8;
const WATER_DENSITY = 1000;

// --- Test harness ---
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

// --- Tests ---

function testZeroForceAboveWater(): void {
  const cells = [
    { type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 },
    { type: BoatCellType.HULL, gridX: 1, gridY: 0, gridZ: 0 },
  ];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: 100, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0, 0],
  };

  const results = computeBuoyancyBatch([input]);
  assert(results.length === 1, "should return 1 result");
  assert(results[0].totalForceY === 0, "force should be 0 for cells above water");
  assert(results[0].totalTorqueX === 0, "torqueX should be 0");
  assert(results[0].totalTorqueZ === 0, "torqueZ should be 0");
  assert(results[0].hullCellCount === 0, "no cells should be submerged");
  console.log("  zero-force-above-water: OK");
}

function testPositiveForceSubmerged(): void {
  const cells = [{ type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 }];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: -1, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0],
  };

  const results = computeBuoyancyBatch([input]);
  assert(results[0].totalForceY > 0, "force should be positive for submerged cells");
  assert(results[0].hullCellCount === 1, "1 hull cell should be submerged");
  console.log("  positive-force-submerged: OK");
}

function testForceMagnitude(): void {
  const cells = [{ type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 }];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: -1, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0],
  };

  const results = computeBuoyancyBatch([input]);
  const cellArea = BOAT_CELL_WORLD_SIZE * BOAT_CELL_WORLD_SIZE;
  const geo = getCellGeometry(BoatCellType.HULL);
  const cellHeight = geo.y1 - geo.y0;
  const cellBottom = -1 - cellHeight / 2;
  const expectedSubmersion = Math.min(0 - cellBottom, cellHeight);
  const expectedForce = WATER_DENSITY * cellArea * expectedSubmersion * GRAVITY;
  assert(
    approxEqual(results[0].totalForceY, expectedForce, 0.01),
    `force magnitude should match (got ${results[0].totalForceY}, expected ${expectedForce})`,
  );
  console.log(`  force-magnitude: OK (force=${results[0].totalForceY.toFixed(2)}N)`);
}

function testSymmetricTorquesCancel(): void {
  const cells = [
    { type: BoatCellType.HULL, gridX: -1, gridY: 0, gridZ: 0 },
    { type: BoatCellType.HULL, gridX: 1, gridY: 0, gridZ: 0 },
  ];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: -1, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0, 0],
  };

  const results = computeBuoyancyBatch([input]);
  assert(approxEqual(results[0].totalTorqueX, 0, 1e-10), "torqueX should cancel for symmetric layout");
  assert(approxEqual(results[0].totalTorqueZ, 0, 1e-10), "torqueZ should cancel for symmetric layout");
  console.log("  symmetric-torques-cancel: OK");
}

function testAsymmetricTorque(): void {
  const cells = [
    { type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 },
    { type: BoatCellType.HULL, gridX: 2, gridY: 0, gridZ: 0 },
  ];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: -1, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0, 0],
  };

  const results = computeBuoyancyBatch([input]);
  assert(results[0].totalTorqueZ !== 0, "torqueZ should be non-zero for asymmetric layout");
  console.log(`  asymmetric-torque: OK (torqueZ=${results[0].totalTorqueZ.toFixed(2)})`);
}

function testMultipleEntities(): void {
  const cells = [{ type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 }];
  const inputs: BuoyancyComputeInput[] = [
    {
      entityIndex: 0,
      position: { x: 0, y: -1, z: 0 },
      heading: 0, pitch: 0, roll: 0,
      cells,
      massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
      waterHeights: [0],
    },
    {
      entityIndex: 1,
      position: { x: 10, y: -1, z: 0 },
      heading: Math.PI / 2, pitch: 0, roll: 0,
      cells,
      massProps: { mass: 2000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 800, Izz: 800 },
      waterHeights: [0],
    },
  ];

  const results = computeBuoyancyBatch(inputs);
  assert(results.length === 2, "should return 2 results");
  assert(results[0].entityIndex === 0, "first result should be entity 0");
  assert(results[1].entityIndex === 1, "second result should be entity 1");
  assert(results[0].shipMass === 1000, "entity 0 mass should be 1000");
  assert(results[1].shipMass === 2000, "entity 1 mass should be 2000");
  console.log("  multiple-entities: OK");
}

function testSkipNonHullCells(): void {
  const cells = [
    { type: BoatCellType.BRIDGE, gridX: 0, gridY: 1, gridZ: 0 },
    { type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 },
  ];
  const input: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: -1, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0, 0],
  };

  const results = computeBuoyancyBatch([input]);
  assert(results[0].hullCellCount === 1, "only HULL cell should be counted (not BRIDGE)");
  console.log("  skip-non-hull-cells: OK");
}

function testEmptyInput(): void {
  const results = computeBuoyancyBatch([]);
  assert(results.length === 0, "empty input should return empty output");
  console.log("  empty-input: OK");
}

function testHeadingInvariance(): void {
  const cells = [
    { type: BoatCellType.HULL, gridX: -1, gridY: 0, gridZ: -1 },
    { type: BoatCellType.HULL, gridX: 1, gridY: 0, gridZ: -1 },
    { type: BoatCellType.HULL, gridX: -1, gridY: 0, gridZ: 1 },
    { type: BoatCellType.HULL, gridX: 1, gridY: 0, gridZ: 1 },
  ];
  const massProps = { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 };

  const headings = [0, Math.PI / 4, Math.PI / 2, Math.PI];
  const forces: number[] = [];

  for (const heading of headings) {
    const input: BuoyancyComputeInput = {
      entityIndex: 0,
      position: { x: 0, y: -1, z: 0 },
      heading, pitch: 0, roll: 0,
      cells,
      massProps,
      waterHeights: [0, 0, 0, 0],
    };
    const results = computeBuoyancyBatch([input]);
    forces.push(results[0].totalForceY);
  }

  for (let i = 1; i < forces.length; i++) {
    assert(
      approxEqual(forces[i], forces[0], 0.01),
      `heading ${i}: force should match heading 0 (got ${forces[i]}, expected ${forces[0]})`,
    );
  }
  console.log(`  heading-invariance: OK (forces: ${forces.map(f => f.toFixed(2)).join(", ")})`);
}

function testPitchAffectsForce(): void {
  const cells = [{ type: BoatCellType.HULL, gridX: 0, gridY: 0, gridZ: 0 }];
  const baseInput: BuoyancyComputeInput = {
    entityIndex: 0,
    position: { x: 0, y: 0, z: 0 },
    heading: 0, pitch: 0, roll: 0,
    cells,
    massProps: { mass: 1000, centerX: 0, centerY: 0, centerZ: 0, Ixx: 500, Izz: 500 },
    waterHeights: [0],
  };
  const tiltedInput: BuoyancyComputeInput = {
    ...baseInput,
    pitch: 0.3,
  };

  const levelResults = computeBuoyancyBatch([baseInput]);
  const tiltedResults = computeBuoyancyBatch([tiltedInput]);
  assert(
    !approxEqual(tiltedResults[0].totalForceY, levelResults[0].totalForceY, 0.01),
    "pitch should change the force (cell vertical position changes)",
  );
  console.log(`  pitch-affects-force: OK (level=${levelResults[0].totalForceY.toFixed(2)}, tilted=${tiltedResults[0].totalForceY.toFixed(2)})`);
}

// --- Run all tests ---
console.log("=== Parallel Buoyancy Computation Tests ===\n");

testZeroForceAboveWater();
testPositiveForceSubmerged();
testForceMagnitude();
testSymmetricTorquesCancel();
testAsymmetricTorque();
testMultipleEntities();
testSkipNonHullCells();
testEmptyInput();
testHeadingInvariance();
testPitchAffectsForce();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
