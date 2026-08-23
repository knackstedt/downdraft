// ============================================================================
// Sandjongg worker — runs the sand physics (SandStepPool) + board logic.
//
// Mirrors games/falling-sand/src/simulation/sand-worker.ts but with
// Mahjongg Connect board logic instead of player physics.
// ============================================================================

import { expose, exposeEvents } from "@downdraft/core/worker/rpc";
import {
    Material,
    SandStepPool,
    SandWorld,
} from "@downdraft/library-sand";
import { MAX_LAYERS, MAX_TILES, TILE_CELL_SIZE, WALL_THICKNESS } from "../shared/constants";
import {
    BOARD_ELEMENT_OFFSET,
    BOARD_META_OFFSET,
    INPUT,
    INPUT_BYTES,
    INPUT_OFFSET,
    OFFSETS,
    STATS,
    SimBufferWriter,
} from "../shared/sim-buffer";
import type { CrumbleEvent, SerializedBoard } from "../shared/types";
import { TileBoard } from "./board";
import { generateLevel } from "./level-generator";
import { attemptMatch, resetComboState, type MatchEngineState } from "./match-engine";
import { findHint, hasAnyMatch, isSolvable } from "./solver";

// --- Gravity overrides for static element materials ---
// Ice and Plant have gravityDir=0 (static) in the library defaults.
// In Sandjongg, crumbled tile sand must fall into the pit, so we override only
// the gravity fields — all other material properties (reactions, flammability,
// density, etc.) are preserved. These are passed to SandStepPool which forwards
// them to each sand-step worker thread (which has its own module instance).
const GRAVITY_OVERRIDES = [
    { mat: Material.Ice,       gravityDir: 1, gravity: 1 },
    { mat: Material.Plant,     gravityDir: 1, gravity: 1 },
];

const events = exposeEvents();

// --- Worker state ---
let pool: SandStepPool | null = null;
let world: SandWorld | null = null; // = pool.getBoundaryWorld()
let board: TileBoard | null = null;
let writer: SimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
let inputBuf: Int32Array | null = null;
let running = false;
let paused = false;
let lastTick = 0;
let tickCount = 0;
let frameCount = 0;
let fpsTimer = 0;
let fps = 0;

let loopActive = true;
let stepInProgress = false;

// Board geometry within the sand grid.
let boardOriginSandCol = 0;
let boardOriginSandRow = 0;
let sandW = 0;
let sandH = 0;
let boardCols = 0;
let boardRows = 0;

// Game state.
let level = 1;
let score = 0;
let matchState: MatchEngineState = resetComboState();
let pendingCrumble: CrumbleEvent[] = [];

// Number of strip-workers for multi-threaded sand physics.
// Sandjongg uses a single worker because the strip-based parallelism creates
// visible column artifacts at strip boundaries — liquids can't flow across
// strips during the main pass, and the 2-column boundary cleanup is too narrow
// to handle the 5-cell horizontal flow distance. The 512×512 grid is small
// enough that a single worker runs at 60fps with no issues.
const NUM_SAND_WORKERS = 1;

const TICK_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;
let tickAccumulator = 0;
let speedMultiplier = 1;
let stepOnce = false;

expose({
  async init(sab: SharedArrayBuffer, gridW: number, gridH: number): Promise<void> {
    sabRef = sab;
    sandW = gridW;
    sandH = gridH;
    (globalThis as any).__ddThreadTag = "S0";
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);

    // Create the sand step pool.
    pool = new SandStepPool({ W: gridW, H: gridH, numWorkers: NUM_SAND_WORKERS, gravityOverrides: GRAVITY_OVERRIDES });
    await pool.init();
    world = pool.getBoundaryWorld();
    world.reseed(0x9e3779b9);

    // Generate the first level.
    startLevel(1, 12345);

    running = true;
    paused = false;
    lastTick = performance.now();
    events.emit("ready", {});
    loop();
  },

  async resize(gridW: number, gridH: number): Promise<void> {
    await doResize(gridW, gridH);
  },

  pause(): void { paused = true; },
  resume(): void { paused = false; lastTick = performance.now(); },
  shutdown(): void {
    running = false;
    loopActive = false;
    if (pool) { pool.shutdown(); pool = null; }
    world = null;
  },

  setSpeed(speed: number): void { speedMultiplier = Math.max(0, speed); },

  step(): void {
    stepOnce = true;
    paused = false;
    lastTick = performance.now();
  },

  newGame(levelNum: number): void {
    level = levelNum;
    score = 0;
    matchState = resetComboState();
    startLevel(levelNum, Math.floor(Math.random() * 0x7fffffff));
  },

  /** Advance to the next level WITHOUT resetting the score. */
  advanceLevel(levelNum: number): void {
    level = levelNum;
    // Keep score; only reset combo state.
    matchState = resetComboState();
    startLevel(levelNum, Math.floor(Math.random() * 0x7fffffff));
  },

  getStats(): { fps: number; tick: number; frame: number; score: number; level: number; combo: number; tilesLeft: number } {
    return { fps, tick: tickCount, frame: frameCount, score, level, combo: matchState.combo, tilesLeft: board?.remainingCount() ?? 0 };
  },

  async loadGrid(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (!writer || !world || !pool) return;
    if (world.W !== gridW || world.H !== gridH) {
      await doResize(gridW, gridH);
    }
    world.grid.set(grid.subarray(0, gridW * gridH));
    world.fields.set(fields.subarray(0, gridW * gridH * 4));
  },

  loadBoard(cols: number, rows: number, elements: Int32Array, layers: number = 1): void {
    boardCols = cols;
    boardRows = rows;
    board = new TileBoard(cols, rows, layers);
    for (let l = 0; l < layers; l++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const el = elements[(c + r * cols) * layers + l];
          if (el >= 0) board.place(c, r, el, l);
        }
      }
    }
    writeBoardToSAB();
  },

  /** Return the serialized board state for saving. */
  getBoardState(): SerializedBoard | null {
    if (!board) return null;
    return board.serialize();
  },

  /** Restore a serialized board state (for loading a save). */
  loadBoardState(data: SerializedBoard): void {
    board = TileBoard.deserialize(data);
    boardCols = board.cols;
    boardRows = board.rows;
    // Recompute board origin within the sand grid.
    const boardSandW = boardCols * TILE_CELL_SIZE;
    boardOriginSandCol = Math.floor((sandW - boardSandW) / 2);
    boardOriginSandRow = WALL_THICKNESS + 1;
    writeBoardToSAB();
    writeStats();
  },
});

// --- Level management ---

function startLevel(levelNum: number, seed: number): void {
  const result = generateLevel(levelNum, seed);
  board = result.board;
  boardCols = board.cols;
  boardRows = board.rows;
  level = levelNum;

  // Compute board origin within the sand grid.
  // Center the board horizontally; place it at the top.
  const boardSandW = boardCols * TILE_CELL_SIZE;
  boardOriginSandCol = Math.floor((sandW - boardSandW) / 2);
  boardOriginSandRow = WALL_THICKNESS + 1;

  // Build pit walls.
  buildPitWalls();

  // Write board to SAB.
  writeBoardToSAB();
  writeStats();
}

function buildPitWalls(): void {
  if (!world) return;
  const W = world.W, H = world.H;
  const grid = world.grid;

  // Clear the grid first.
  grid.fill(0);

  // Floor wall at the bottom of the pit.
  const floorRow = H - WALL_THICKNESS;
  for (let y = floorRow; y < H; y++) {
    for (let x = 0; x < W; x++) {
      grid[y * W + x] = Material.Wall;
    }
  }

  // Side walls.
  for (let x = 0; x < WALL_THICKNESS; x++) {
    for (let y = 0; y < H; y++) {
      grid[y * W + x] = Material.Wall;
      grid[y * W + (W - 1 - x)] = Material.Wall;
    }
  }
}

// --- Board ↔ SAB sync ---

function writeBoardToSAB(): void {
  if (!board || !sabRef) return;
  const boardView = new Int32Array(sabRef, BOARD_ELEMENT_OFFSET, MAX_TILES);
  boardView.fill(-1);
  for (let l = 0; l < board.maxLayers; l++) {
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        const tile = board.at(c, r, l);
        if (tile !== null) {
          boardView[(c + r * board.cols) * MAX_LAYERS + l] = tile.element;
        }
      }
    }
  }
  const metaView = new Int32Array(sabRef, BOARD_META_OFFSET, 4);
  metaView[0] = board.cols;
  metaView[1] = board.rows;
  metaView[2] = board.maxLayers;
  metaView[3] = board.remainingCount();
}

function writeStats(): void {
  if (!writer) return;
  writer.writeStat(STATS.SCORE, score);
  writer.writeStat(STATS.COMBO, matchState.combo);
  writer.writeStat(STATS.LEVEL, level);
  writer.writeStat(STATS.TILES_LEFT, board?.remainingCount() ?? 0);
}

// --- Input processing ---

function processInput(): void {
  if (!board || !world || !inputBuf) return;
  const ib = inputBuf;
  const action = ib[INPUT.ACTION / 4];

  if (action === 0) return; // no action

  if (action === 1) {
    // Match
    const aCol = ib[INPUT.MATCH_A_COL / 4];
    const aRow = ib[INPUT.MATCH_A_ROW / 4];
    const aLayer = ib[INPUT.MATCH_A_LAYER / 4];
    const bCol = ib[INPUT.MATCH_B_COL / 4];
    const bRow = ib[INPUT.MATCH_B_ROW / 4];
    const bLayer = ib[INPUT.MATCH_B_LAYER / 4];
    const now = performance.now();
    const result = attemptMatch(board, aCol, aRow, aLayer, bCol, bRow, bLayer, matchState, now, boardOriginSandCol, boardOriginSandRow);
    if (result.ok) {
      score += result.score;
      // Queue crumble events for sand spawning.
      for (const c of result.crumble) {
        pendingCrumble.push(c);
      }
      writeBoardToSAB();
      writeStats();
      events.emit("matched", { score: result.score, combo: result.combo, path: result.path });
      // Check for dead-end after the match.
      if (board && !board.isCleared()) {
        if (!hasAnyMatch(board)) {
          events.emit("deadEnd", {});
        }
      }
    } else {
      events.emit("matchFailed", { reason: result.reason, a: { col: aCol, row: aRow, layer: aLayer }, b: { col: bCol, row: bRow, layer: bLayer } });
    }
  } else if (action === 2) {
    // Hint
    const hint = findHint(board);
    if (hint) {
      events.emit("hint", hint);
    } else {
      events.emit("noHint", {});
    }
  } else if (action === 3) {
    // Shuffle — redistribute remaining tiles, ensuring the result is solvable.
    shuffleBoardSafe();
    writeBoardToSAB();
    writeStats();
  } else if (action === 4) {
    // New game (restart) — resets score.
    const newLevel = ib[INPUT.NEW_LEVEL / 4] || level + 1;
    score = 0;
    matchState = resetComboState();
    startLevel(newLevel, Math.floor(Math.random() * 0x7fffffff));
    writeStats();
  } else if (action === 6) {
    // Advance to next level — keeps score, resets combo.
    const newLevel = ib[INPUT.NEW_LEVEL / 4] || level + 1;
    matchState = resetComboState();
    startLevel(newLevel, Math.floor(Math.random() * 0x7fffffff));
    writeStats();
  } else if (action === 5) {
    // Clear sand
    if (world) {
      buildPitWalls();
    }
  }

  // Reset action.
  ib[INPUT.ACTION / 4] = 0;
}

function shuffleBoard(): void {
  if (!board) return;
  const tiles = board.allTiles();
  if (tiles.length < 2) return;

  // Collect all occupied positions (with layer).
  const positions: { col: number; row: number; layer: number }[] = [];
  for (let l = 0; l < board.maxLayers; l++) {
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (board.at(c, r, l) !== null) positions.push({ col: c, row: r, layer: l });
      }
    }
  }

  // Shuffle the elements.
  const elements = tiles.map((t) => t.element);
  for (let i = elements.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [elements[i], elements[j]] = [elements[j], elements[i]];
  }

  // Clear and re-place.
  for (const p of positions) board.remove(p.col, p.row, p.layer);
  for (let i = 0; i < positions.length; i++) {
    board.place(positions[i].col, positions[i].row, elements[i], positions[i].layer);
  }
}

/**
 * Shuffle the board, retrying until the result is solvable (or at least has
 * a valid move). For small boards we check full solvability via isSolvable;
 * for large boards (>40 tiles) we only check hasAnyMatch to avoid expensive
 * solver runs. Falls back to the pre-shuffle state if no good shuffle is found.
 */
function shuffleBoardSafe(): void {
  if (!board) return;
  const tiles = board.allTiles();
  if (tiles.length < 2) return;

  // Snapshot the current board so we can revert if all shuffles are bad.
  const snapshot = board.serialize();

  const checkSolvable = tiles.length <= 40;
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    shuffleBoard();
    if (checkSolvable) {
      if (isSolvable(board)) return; // good shuffle
    } else {
      if (hasAnyMatch(board)) return; // at least one move available
    }
  }

  // All shuffles failed — revert to the pre-shuffle state.
  const restored = TileBoard.deserialize(snapshot);
  // Copy restored tiles back into the live board.
  for (let i = 0; i < board.tiles.length; i++) {
    board.tiles[i] = restored.tiles[i];
  }
}

// --- Sand spawning from crumble events ---

function processPendingCrumble(): void {
  if (!world || pendingCrumble.length === 0) return;
  const W = world.W;
  for (const c of pendingCrumble) {
    // Paint sand material across the tile footprint.
    const radius = Math.floor(TILE_CELL_SIZE / 2);
    const cx = c.sandCol + radius;
    const cy = c.sandRow + radius;
    // Use paintMaterial to fill the tile area with the element's sand material.
    for (let dy = 0; dy < TILE_CELL_SIZE; dy++) {
      for (let dx = 0; dx < TILE_CELL_SIZE; dx++) {
        const x = c.sandCol + dx;
        const y = c.sandRow + dy;
        if (x < 0 || x >= W || y < 0 || y >= world.H) continue;
        const curMat = world.grid[y * W + x] & 0xff;
        if (curMat === Material.Wall) continue;
        world.grid[y * W + x] = (c.sandMaterial & 0xff) | (Math.floor(Math.random() * 4) << 16);
      }
    }
  }
  pendingCrumble = [];
}

// --- Resize ---

async function doResize(gridW: number, gridH: number): Promise<void> {
  if (!writer || !sabRef) return;
  loopActive = false;
  for (let i = 0; i < 50 && stepInProgress; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  stepInProgress = false;

  writer.setDims(gridW, gridH);
  sandW = gridW;
  sandH = gridH;

  if (pool) pool.shutdown();
  pool = new SandStepPool({ W: gridW, H: gridH, numWorkers: NUM_SAND_WORKERS, gravityOverrides: GRAVITY_OVERRIDES });
  await pool.init();
  world = pool.getBoundaryWorld();
  world.reseed(0x9e3779b9);

  // Rebuild pit walls and recompute board origin.
  if (board) {
    const boardSandW = boardCols * TILE_CELL_SIZE;
    boardOriginSandCol = Math.floor((sandW - boardSandW) / 2);
    boardOriginSandRow = WALL_THICKNESS + 1;
  }
  buildPitWalls();

  loopActive = true;
  lastTick = performance.now();
  loop();
}

// --- Main loop ---

async function loop(): Promise<void> {
  if (!loopActive || !running || !world || !writer || !sabRef || !pool) return;

  try {
    const now = performance.now();
    const elapsed = now - lastTick;

    if (elapsed >= TICK_MS) {
      lastTick = now - (elapsed % TICK_MS);
      tickAccumulator += (elapsed / TICK_MS) * speedMultiplier;

      if (!paused || stepOnce) {
        let steps = 0;
        const maxSteps = stepOnce ? 1 : MAX_STEPS_PER_FRAME;
        while (tickAccumulator >= 1 && steps < maxSteps) {
          processInput();
          processPendingCrumble();

          const stepPool: SandStepPool | null = pool;
          if (!stepPool) break;
          stepInProgress = true;
          await stepPool.step(world.frame);
          stepInProgress = false;
          if (pool !== stepPool || !loopActive) return;
          world.frame++;
          writer.writeGrid(world.grid);
          writer.writeFieldGrid(world.fields);

          writeStats();
          tickCount++;
          tickAccumulator--;
          steps++;
        }
        if (tickAccumulator > MAX_STEPS_PER_FRAME) tickAccumulator = 0;
        if (stepOnce) {
          stepOnce = false;
          paused = true;
          tickAccumulator = 0;
        }
      }
    }

    frameCount++;
    fpsTimer += elapsed;
    if (fpsTimer >= 1000) {
      fps = Math.round((frameCount * 1000) / fpsTimer);
      writer.writeStat(STATS.FPS, fps);
      frameCount = 0;
      fpsTimer = 0;
    }
  } catch (err) {
    console.error(`[SandjonggWorker] loop error:`, err);
  }

  if (loopActive) setTimeout(loop, 0);
}
