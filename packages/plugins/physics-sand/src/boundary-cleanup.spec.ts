import { expect, test } from "bun:test";
import { FLAG_UPDATED, packCell } from "./cell";
import { Material } from "./materials";
import { SandWorld } from "./sand-world";

// ============================================================================
// Tests for the strip-mode boundary cleanup — verifies that cells at strip
// boundaries don't fall faster than interior cells (the "fast falling columns"
// artifact caused by the old boundary cleanup re-rolling RNG gates).
//
// These tests simulate the SandStepPool's multi-strip step + boundary cleanup
// using SandWorld instances with SAB-backed grids, without spawning actual
// workers. The SAB layout matches what SandStepPool allocates:
//   grid (W*H*4) + fields (W*H*4) + skipMask (W*H) + deferredMask (W*H) + histogram (W*4)
// ============================================================================

/** SAB layout matching SandStepPool's allocation. */
function allocSAB(W: number, H: number): { sab: SharedArrayBuffer; gridOffset: number; fieldsOffset: number; skipMaskOffset: number; deferredMaskOffset: number; histogramOffset: number } {
  const cells = W * H;
  const gridBytes = cells * 4;
  const fieldsBytes = cells * 4;
  const skipMaskBytes = cells;
  const deferredMaskBytes = cells;
  const histogramBytes = W * 4;
  const total = gridBytes + fieldsBytes + skipMaskBytes + deferredMaskBytes + histogramBytes;
  const sab = new SharedArrayBuffer(total);
  return {
    sab,
    gridOffset: 0,
    fieldsOffset: gridBytes,
    skipMaskOffset: gridBytes + fieldsBytes,
    deferredMaskOffset: gridBytes + fieldsBytes + skipMaskBytes,
    histogramOffset: gridBytes + fieldsBytes + skipMaskBytes + deferredMaskBytes,
  };
}

/** Create a SAB-backed SandWorld with the given strip bounds. */
function makeStripWorld(
  sab: SharedArrayBuffer, W: number, H: number,
  offsets: { gridOffset: number; fieldsOffset: number; skipMaskOffset: number; deferredMaskOffset: number; histogramOffset: number },
  stripStart: number, stripEnd: number,
): SandWorld {
  const w = new SandWorld(W, H, {
    sab,
    gridOffset: offsets.gridOffset,
    fieldsOffset: offsets.fieldsOffset,
    skipMaskOffset: offsets.skipMaskOffset,
    deferredMaskOffset: offsets.deferredMaskOffset,
    histogramOffset: offsets.histogramOffset,
    skipStoneFloor: true,
  });
  w.setStripBounds(stripStart, stripEnd);
  w.reseed(42);
  return w;
}

/**
 * Simulate one SandStepPool step: step all strip worlds, then run the boundary
 * cleanup on the boundary world (replicating SandStepPool.runBoundaryCleanup
 * logic — only deferred cells, restricted write bounds, boundaryPass mode).
 */
function multiStripStep(
  strips: SandWorld[], boundary: SandWorld,
  stripBounds: { startX: number; endX: number }[],
  frame: number,
): void {
  // Step all strip worlds (sequentially — simulates parallel workers).
  for (const w of strips) {
    w.frame = frame;
    w.step();
  }
  // Boundary cleanup — replicate SandStepPool.runBoundaryCleanup.
  const W = boundary.W;
  const H = boundary.H;
  const grid = boundary.grid;
  const deferred = boundary.deferredMask;
  if (deferred === null) return;
  boundary.frame = frame;
  boundary.boundaryPass = true;
  for (let bi = 0; bi < stripBounds.length - 1; bi++) {
    const leftStrip = stripBounds[bi];
    const rightStrip = stripBounds[bi + 1];
    const leftCol = leftStrip.endX - 1;
    const rightCol = rightStrip.startX;
    // Left column → can only write into right strip.
    boundary.writeXMin = rightStrip.startX;
    boundary.writeXMax = rightStrip.endX;
    processCol(boundary, grid, deferred, leftCol, W, H);
    // Right column → can only write into left strip.
    boundary.writeXMin = leftStrip.startX;
    boundary.writeXMax = leftStrip.endX;
    processCol(boundary, grid, deferred, rightCol, W, H);
  }
  boundary.boundaryPass = false;
  boundary.writeXMin = 0;
  boundary.writeXMax = W;
  // Clear deferred mask on boundary columns.
  for (let bi = 0; bi < stripBounds.length - 1; bi++) {
    const leftCol = stripBounds[bi].endX - 1;
    const rightCol = stripBounds[bi + 1].startX;
    for (let y = 0; y < H; y++) {
      deferred[y * W + leftCol] = 0;
      deferred[y * W + rightCol] = 0;
    }
  }
}

function processCol(bw: SandWorld, grid: Uint32Array, deferred: Uint8Array, col: number, W: number, H: number): void {
  let minY = H, maxY = 0;
  let hasDeferred = false;
  for (let y = 0; y < H; y++) {
    const idx = y * W + col;
    if (grid[idx] !== 0 && deferred[idx] !== 0) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hasDeferred = true;
    }
  }
  if (!hasDeferred) return;
  bw.runBoundaryMovement([col], minY, maxY, true);
}

/** Place a vertical column of sand at (x, y0..y1). */
function placeSandColumn(world: SandWorld, x: number, y0: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    world.grid[y * world.W + x] = packCell(Material.Sand, 0, 0);
  }
}

/** Find the lowest (max Y) non-empty cell in column x, or -1 if empty. */
function lowestCellY(world: SandWorld, x: number): number {
  for (let y = world.H - 1; y >= 0; y--) {
    if (world.grid[y * world.W + x] !== 0) return y;
  }
  return -1;
}

/** Count non-empty cells in column x. */
function countColumn(world: SandWorld, x: number): number {
  let count = 0;
  for (let y = 0; y < world.H; y++) {
    if (world.grid[y * world.W + x] !== 0) count++;
  }
  return count;
}

test("boundary column sand falls at same rate as interior column (no fast-falling artifact)", () => {
  const W = 16, H = 48;
  const offsets = allocSAB(W, H);
  // 2 strips: [0,8) and [8,16). Boundary at x=7 (left) / x=8 (right).
  const stripBounds = [{ startX: 0, endX: 8 }, { startX: 8, endX: 16 }];
  const strips = [
    makeStripWorld(offsets.sab, W, H, offsets, 0, 8),
    makeStripWorld(offsets.sab, W, H, offsets, 8, 16),
  ];
  const boundary = makeStripWorld(offsets.sab, W, H, offsets, 0, W);
  boundary.setStripBounds(0, W); // full grid

  // Place a floor at y=47 (bottom row) across the full grid so sand rests.
  for (let x = 0; x < W; x++) {
    boundary.grid[47 * W + x] = packCell(Material.Wall, 0, 0);
  }

  // Place two equal columns of sand:
  // - Interior column at x=4 (well inside strip 0)
  // - Boundary column at x=7 (last column of strip 0, at the strip boundary)
  const sandTop = 0, sandBottom = 30;
  placeSandColumn(boundary, 4, sandTop, sandBottom);
  placeSandColumn(boundary, 7, sandTop, sandBottom);

  // Run 40 frames of multi-strip step + boundary cleanup.
  for (let frame = 1; frame <= 40; frame++) {
    multiStripStep(strips, boundary, stripBounds, frame);
  }

  // Both columns should have settled near the floor. The boundary column
  // (x=7) should NOT be significantly lower than the interior column (x=4).
  // Before the fix, the boundary column fell ~1.3× faster because the cleanup
  // re-rolled edge friction (30% → 9% effective skip).
  const interiorLowest = lowestCellY(boundary, 4);
  const boundaryLowest = lowestCellY(boundary, 7);
  const interiorCount = countColumn(boundary, 4);
  const boundaryCount = countColumn(boundary, 7);

  // Both columns should have the same amount of sand (none lost to cross-strip
  // diagonal moves — the floor prevents sideways spread at the bottom).
  // Some sand may spread diagonally at the top, so allow a small difference.
  expect(Math.abs(interiorCount - boundaryCount)).toBeLessThan(6);

  // The lowest sand cell in both columns should be near the floor (y=46).
  // The boundary column should NOT be significantly lower — if it fell faster,
  // its lowest cell would be lower (higher Y) than the interior's.
  expect(interiorLowest).toBeGreaterThan(40);
  expect(boundaryLowest).toBeGreaterThan(40);
  // The key assertion: boundary column is not more than 3 cells lower
  // than the interior column. Before the fix, the difference was 5-10+ cells.
  expect(boundaryLowest - interiorLowest).toBeLessThan(4);
});

test("deferredMask is set when a cross-strip move is blocked by the write guard", () => {
  const W = 8, H = 16;
  const offsets = allocSAB(W, H);
  // Strip 0: [0,4). Boundary at x=3 (last col of strip 0).
  const strip = makeStripWorld(offsets.sab, W, H, offsets, 0, 4);
  strip.reseed(42);

  // Place sand at (3, 5) — the last column of strip 0.
  // Block ALL within-strip moves so the only available move is the
  // cross-strip diagonal down-right to (4, 6):
  //   (3, 6) = wall → blocks straight down
  //   (2, 6) = wall → blocks diagonal down-left (within strip)
  //   (4, 6) = empty → diagonal down-right (cross-strip, write-guard blocked)
  strip.grid[5 * W + 3] = packCell(Material.Sand, 0, 0);
  strip.grid[6 * W + 3] = packCell(Material.Wall, 0, 0);
  strip.grid[6 * W + 2] = packCell(Material.Wall, 0, 0);

  // Run multiple steps — friction (30% skip) might block movement on some
  // frames, but over 20 frames it will pass at least once. When it passes,
  // the sand tries down (wall), then diagonals: (4,6) is cross-strip →
  // write guard blocks → deferredMask set. (2,6) is wall → fails.
  // The sand can't move, so it stays at (3,5) every frame.
  let sawDeferred = false;
  for (let i = 0; i < 20; i++) {
    strip.step();
    if (strip.deferredMask![5 * W + 3] !== 0) {
      sawDeferred = true;
      break;
    }
  }
  expect(sawDeferred).toBe(true);
  // Sand should still be at (3,5) — all moves were blocked.
  expect(strip.grid[5 * W + 3] & 0xff).toBe(Material.Sand);
});

test("boundaryPass mode skips non-deferred cells", () => {
  const W = 8, H = 16;
  const offsets = allocSAB(W, H);
  const boundary = makeStripWorld(offsets.sab, W, H, offsets, 0, W);
  boundary.setStripBounds(0, W);

  // Place sand at (4, 5) with NO deferred marker.
  boundary.grid[5 * W + 4] = packCell(Material.Sand, 0, 0);
  // Clear FLAG_UPDATED and deferredMask.
  boundary.grid[5 * W + 4] &= ~(FLAG_UPDATED << 16);
  boundary.deferredMask![5 * W + 4] = 0;

  // Run tryMove in boundaryPass mode — should skip the cell (no deferred).
  boundary.boundaryPass = true;
  boundary.writeXMin = 0;
  boundary.writeXMax = W;
  boundary.frame = 1;
  boundary.runBoundaryMovement([4], 5, 5, true);
  boundary.boundaryPass = false;

  // The sand should NOT have moved (it was skipped).
  expect(boundary.grid[5 * W + 4] & 0xff).toBe(Material.Sand);
  expect(boundary.grid[6 * W + 4] & 0xff).toBe(Material.Empty);
});

test("boundaryPass mode processes deferred cells and attempts cross-strip moves", () => {
  const W = 8, H = 16;
  const offsets = allocSAB(W, H);
  const boundary = makeStripWorld(offsets.sab, W, H, offsets, 0, W);

  // Place sand at (3, 5) with deferred marker.
  // (4, 6) is empty and in the "adjacent strip" (write bounds [4,8)).
  boundary.grid[5 * W + 3] = packCell(Material.Sand, 0, 0);
  boundary.deferredMask![5 * W + 3] = 1;
  // Block straight-down so the diagonal cross-strip move is the only option.
  boundary.grid[6 * W + 3] = packCell(Material.Wall, 0, 0);

  // Run in boundaryPass mode with write bounds restricted to [4,8).
  boundary.boundaryPass = true;
  boundary.writeXMin = 4;
  boundary.writeXMax = 8;
  boundary.frame = 1;
  boundary.runBoundaryMovement([3], 5, 5, true);
  boundary.boundaryPass = false;
  boundary.writeXMin = 0;
  boundary.writeXMax = W;

  // The sand should have moved diagonally to (4, 6) — cross-strip.
  expect(boundary.grid[5 * W + 3] & 0xff).toBe(Material.Empty);
  expect(boundary.grid[6 * W + 4] & 0xff).toBe(Material.Sand);
});
