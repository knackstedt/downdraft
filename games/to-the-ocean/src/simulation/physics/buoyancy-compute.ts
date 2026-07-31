// ============================================================================
// Pure buoyancy force computation — extracted for parallel worker dispatch.
// No imports beyond shared/constants, safe to load in worker contexts.
// ============================================================================

import {
  BOAT_CELL_WORLD_SIZE,
  BOAT_LAYER_HEIGHT,
  isHullShellCell,
} from "../../shared/constants";

// Physics constants (duplicated from BuoyancySystem.ts to avoid import chain)
const GRAVITY = 9.8;
const WATER_DENSITY = 1000;

export interface BuoyancyComputeInput {
  entityIndex: number;
  position: { x: number; y: number; z: number };
  heading: number;
  pitch: number;
  roll: number;
  cells: { type: number; gridX: number; gridY: number; gridZ: number }[];
  massProps: { mass: number; centerX: number; centerY: number; centerZ: number; Ixx: number; Izz: number };
  waterHeights: number[];
}

export interface BuoyancyComputeOutput {
  entityIndex: number;
  totalForceY: number;
  totalTorqueX: number;
  totalTorqueZ: number;
  shipMass: number;
  Ixx: number;
  Izz: number;
  hullCellCount: number;
}

/**
 * Pure function: compute buoyancy forces from pre-sampled water heights.
 * No side effects, no SAB access — safe for worker dispatch.
 */
export function computeBuoyancyBatch(
  inputs: BuoyancyComputeInput[],
): BuoyancyComputeOutput[] {
  const results: BuoyancyComputeOutput[] = [];
  const cellArea = BOAT_CELL_WORLD_SIZE * BOAT_CELL_WORLD_SIZE;
  const cellHeight = BOAT_LAYER_HEIGHT;

  for (let s = 0; s < inputs.length; s++) {
    const inp = inputs[s];
    const cosP = Math.cos(inp.pitch);
    const sinP = Math.sin(inp.pitch);
    const cosR = Math.cos(inp.roll);
    const sinR = Math.sin(inp.roll);

    let totalForceY = 0;
    let totalTorqueX = 0;
    let totalTorqueZ = 0;
    let hullCellCount = 0;
    let waterIdx = 0;

    for (let i = 0; i < inp.cells.length; i++) {
      const cell = inp.cells[i];
      if (!isHullShellCell(cell.type)) continue;

      const localX = cell.gridX * BOAT_CELL_WORLD_SIZE;
      const localY = cell.gridY * BOAT_LAYER_HEIGHT + BOAT_LAYER_HEIGHT / 2;
      const localZ = cell.gridZ * BOAT_CELL_WORLD_SIZE;

      const armX = localX - inp.massProps.centerX;
      const armY = localY - inp.massProps.centerY;
      const armZ = localZ - inp.massProps.centerZ;

      const pY = armY * cosP - armZ * sinP;
      const rY = armX * sinR + pY * cosR;
      const worldY = inp.position.y + rY;

      const waterHeight = inp.waterHeights[waterIdx++];

      const cellBottom = worldY - cellHeight / 2;
      if (waterHeight <= cellBottom) continue;

      const submersionDepth = Math.min(waterHeight - cellBottom, cellHeight);
      const submergedVolume = cellArea * submersionDepth;
      const buoyancyForce = WATER_DENSITY * submergedVolume * GRAVITY;

      totalForceY += buoyancyForce;
      totalTorqueX += -armZ * buoyancyForce;
      totalTorqueZ += armX * buoyancyForce;
      hullCellCount++;
    }

    results.push({
      entityIndex: inp.entityIndex,
      totalForceY,
      totalTorqueX,
      totalTorqueZ,
      shipMass: inp.massProps.mass,
      Ixx: inp.massProps.Ixx,
      Izz: inp.massProps.Izz,
      hullCellCount,
    });
  }

  return results;
}
