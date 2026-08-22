// ============================================================================
// Overburden — fluid simulation (cellular automaton water + lava flow)
//
// Water has a flow level (0-7). Each tick:
// 1. Flow down: if the cell below can accept fluid, transfer as much as possible
// 2. Spread horizontally: flow to adjacent cells with lower flow level
// 3. Pressure equalization: water at higher levels pushes into lower adjacent cells
//
// Lava flows slower (every N ticks) and interacts with water → stone.
//
// Freeze optimization: cells with no adjacent disturbed cell are frozen and
// skipped. Only active cells are simulated.
// ============================================================================

import {
  ACTIVE_GRID_CELLS, ACTIVE_GRID_H, ACTIVE_GRID_W,
  BLOCK_AIR, BLOCK_LAVA, BLOCK_STONE, BLOCK_WATER,
  MAX_FLOW,
} from "../shared/constants";
import { getBlockMask } from "../shared/block-registry";
import { MASK_SOLID } from "../shared/constants";

// --- Fluid cell state ---
// We track flow level separately from block ID. A water block with flow=7 is
// a full water cell; flow=1 is a nearly-empty water cell.
// For simplicity, we store flow level in the upper bits of the foreground block.
// But since we use Uint16Array for foreground and block IDs < 256, we can use
// bits 8-10 for flow level (0-7).
const FLOW_MASK = 0x0F00; // bits 8-11
const FLOW_SHIFT = 8;
const BLOCK_MASK = 0x00FF;

export function getFlow(blockId: number): number {
  return (blockId & FLOW_MASK) >> FLOW_SHIFT;
}

export function setFlow(blockId: number, flow: number): number {
  return (blockId & BLOCK_MASK) | ((flow & 0x0F) << FLOW_SHIFT);
}

export function getBlockFromPacked(packed: number): number {
  return packed & BLOCK_MASK;
}

/** Check if a block is solid (blocks fluid flow). */
function isSolid(blockId: number): boolean {
  if (blockId === BLOCK_AIR) return false;
  return (getBlockMask(blockId) & MASK_SOLID) !== 0;
}

/** Check if a cell can accept fluid (air or same-type fluid with room). */
function canAcceptFluid(cellBlock: number, fluidBlock: number): boolean {
  if (cellBlock === BLOCK_AIR) return true;
  const cellType = getBlockFromPacked(cellBlock);
  const fluidType = getBlockFromPacked(fluidBlock);
  if (cellType !== fluidType) return false;
  // Same fluid type — can accept if flow level < MAX_FLOW
  return getFlow(cellBlock) < MAX_FLOW;
}

// --- Active cell tracking ---
// A bitset marking which cells need simulation this tick.
// A cell is "active" if it or any of its 4 neighbors changed last tick.
const activeSet = new Uint8Array(ACTIVE_GRID_CELLS);
const nextActive = new Uint8Array(ACTIVE_GRID_CELLS);

/** Mark a cell and its neighbors as active for the next tick. */
function markActive(x: number, y: number): void {
  if (y >= 0 && y < ACTIVE_GRID_H && x >= 0 && x < ACTIVE_GRID_W) {
    nextActive[y * ACTIVE_GRID_W + x] = 1;
    if (x > 0) nextActive[y * ACTIVE_GRID_W + x - 1] = 1;
    if (x < ACTIVE_GRID_W - 1) nextActive[y * ACTIVE_GRID_W + x + 1] = 1;
    if (y > 0) nextActive[(y - 1) * ACTIVE_GRID_W + x] = 1;
    if (y < ACTIVE_GRID_H - 1) nextActive[(y + 1) * ACTIVE_GRID_W + x] = 1;
  }
}

/** Initialize active set — mark all fluid cells as active. */
export function initFluidSim(fg: Uint16Array): void {
  activeSet.fill(0);
  nextActive.fill(0);
  for (let i = 0; i < ACTIVE_GRID_CELLS; i++) {
    const block = getBlockFromPacked(fg[i]);
    if (block === BLOCK_WATER || block === BLOCK_LAVA) {
      activeSet[i] = 1;
    }
  }
}

// --- Step the fluid simulation ---
// tickCount is used to throttle lava flow (every 4 ticks).
export function stepFluidSim(fg: Uint16Array, tickCount: number): void {
  // Swap active sets: use nextActive (built last tick) as this tick's active set
  activeSet.set(nextActive);
  nextActive.fill(0);

  const lavaTick = tickCount % 4 === 0; // lava flows every 4 ticks

  // Process bottom-to-top so water flows down correctly
  for (let y = ACTIVE_GRID_H - 1; y >= 0; y--) {
    // Alternate left-right sweep direction each tick for more even flow
    const leftToRight = (tickCount + y) % 2 === 0;
    if (leftToRight) {
      for (let x = 0; x < ACTIVE_GRID_W; x++) {
        processCell(fg, x, y, lavaTick);
      }
    } else {
      for (let x = ACTIVE_GRID_W - 1; x >= 0; x--) {
        processCell(fg, x, y, lavaTick);
      }
    }
  }

  // Copy nextActive to activeSet for next tick
  // (already done at the top of next call)
}

function processCell(fg: Uint16Array, x: number, y: number, lavaTick: boolean): void {
  const idx = y * ACTIVE_GRID_W + x;
  if (!activeSet[idx]) return;

  const packed = fg[idx];
  const blockType = getBlockFromPacked(packed);
  if (blockType !== BLOCK_WATER && blockType !== BLOCK_LAVA) return;

  // Lava only flows on lava ticks
  if (blockType === BLOCK_LAVA && !lavaTick) return;

  let flow = getFlow(packed);
  if (flow === 0) {
    // Empty fluid cell — remove it
    fg[idx] = BLOCK_AIR;
    markActive(x, y);
    return;
  }

  // 1. Flow down
  if (y < ACTIVE_GRID_H - 1) {
    const belowIdx = (y + 1) * ACTIVE_GRID_W + x;
    const below = fg[belowIdx];
    if (canAcceptFluid(below, packed)) {
      const belowFlow = getFlow(below);
      const belowType = getBlockFromPacked(below);
      const transfer = Math.min(flow, MAX_FLOW - belowFlow);
      if (belowType === BLOCK_AIR) {
        fg[belowIdx] = setFlow(packed, belowFlow + transfer);
      } else {
        fg[belowIdx] = setFlow(below, belowFlow + transfer);
      }
      flow -= transfer;
      fg[idx] = setFlow(packed, flow);
      markActive(x, y);
      markActive(x, y + 1);
      if (flow === 0) {
        fg[idx] = BLOCK_AIR;
        return;
      }
    }
  }

  // 2. Spread horizontally
  // Try to equalize with left and right neighbors
  for (const dir of [-1, 1]) {
    const nx = x + dir;
    if (nx < 0 || nx >= ACTIVE_GRID_W) continue;
    const nIdx = y * ACTIVE_GRID_W + nx;
    const neighbor = fg[nIdx];
    const nType = getBlockFromPacked(neighbor);

    if (nType === BLOCK_AIR) {
      // Flow into air
      const transfer = Math.floor(flow / 2);
      if (transfer > 0) {
        fg[nIdx] = setFlow(packed, transfer);
        flow -= transfer;
        fg[idx] = setFlow(packed, flow);
        markActive(x, y);
        markActive(nx, y);
      }
    } else if (nType === blockType) {
      // Equalize with same fluid type
      const nFlow = getFlow(neighbor);
      if (nFlow < flow - 1) {
        const transfer = Math.floor((flow - nFlow) / 2);
        if (transfer > 0) {
          fg[nIdx] = setFlow(neighbor, nFlow + transfer);
          flow -= transfer;
          fg[idx] = setFlow(packed, flow);
          markActive(x, y);
          markActive(nx, y);
        }
      }
    } else if (blockType === BLOCK_LAVA && nType === BLOCK_WATER) {
      // Lava + water → stone
      fg[nIdx] = BLOCK_STONE;
      fg[idx] = BLOCK_STONE;
      markActive(x, y);
      markActive(nx, y);
      return;
    }
  }

  // 3. Flow down diagonally (for more natural spreading)
  if (y < ACTIVE_GRID_H - 1 && flow > 1) {
    for (const dir of [-1, 1]) {
      const nx = x + dir;
      if (nx < 0 || nx >= ACTIVE_GRID_W) continue;
      const belowIdx = (y + 1) * ACTIVE_GRID_W + nx;
      const below = fg[belowIdx];
      if (canAcceptFluid(below, packed)) {
        const belowFlow = getFlow(below);
        const belowType = getBlockFromPacked(below);
        const transfer = Math.min(Math.floor(flow / 2), MAX_FLOW - belowFlow);
        if (transfer > 0) {
          if (belowType === BLOCK_AIR) {
            fg[belowIdx] = setFlow(packed, belowFlow + transfer);
          } else {
            fg[belowIdx] = setFlow(below, belowFlow + transfer);
          }
          flow -= transfer;
          fg[idx] = setFlow(packed, flow);
          markActive(x, y);
          markActive(nx, y + 1);
        }
      }
    }
  }
}
