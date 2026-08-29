// ============================================================================
// Sandjongg worker — runs the sand physics (SandStepPool) + board logic.
//
// Mirrors games/falling-sand/src/simulation/sand-worker.ts but with
// Mahjongg Connect board logic instead of player physics.
// ============================================================================

// Global error handler — catches errors during module evaluation and forwards
// them to the main thread so they're visible in the console.
self.addEventListener("error", (e: ErrorEvent) => {
  console.error("[sandjongg-worker] global error:", e.message, e.filename, e.lineno, e.error?.stack);
});
self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  console.error("[sandjongg-worker] unhandled rejection:", String(e.reason));
});

import { createSimWorker, usingRealSAB, type BufferSyncConfig, type SimWorkerControl } from "@downdraft/core";
import {
    DEFAULT_GRAVITY,
    FIELD,
    MAT_GRAVITY,
    MAT_GRAVITY_DIR,
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
    TOTAL_BYTES,
} from "../shared/sim-buffer";
import { tilesetMaterial, type TilesetId } from "../shared/tilesets";
import type { GameMode, SerializedBoard } from "../shared/types";
import { TileBoard } from "./board";
import { generateLevel } from "./level-generator";
import { attemptMatch, resetComboState, type MatchEngineState } from "./match-engine";
import { findHint, hasAnyMatch, isSolvable } from "./solver";

// --- Gravity overrides for static element materials ---
// Plant has gravityDir=0 (static) in the library defaults.
// In Sandjongg, crumbled tile sand must fall into the pit, so we override only
// the gravity fields — all other material properties (reactions, flammability,
// density, etc.) are preserved. These are passed to SandStepPool which forwards
// them to each sand-step worker thread (which has its own module instance).
const GRAVITY_OVERRIDES = [
    { mat: Material.Plant,     gravityDir: 1, gravity: 1 },
];

// --- Worker state ---
let pool: SandStepPool | null = null;
let world: SandWorld | null = null; // = pool.getBoundaryWorld()
let board: TileBoard | null = null;

/** Timeout for pool.init()/step() — if nested workers can't load or hang,
 *  fall back to a single-threaded SandWorld. */
const POOL_INIT_TIMEOUT_MS = 5000;
const POOL_STEP_TIMEOUT_MS = 2000;
let writer: SimBufferWriter | null = null;
let sabRef: SharedArrayBuffer | null = null;
let inputBuf: Int32Array | null = null;

// Synced from createSimWorker's ctx for helper functions / getStats.
let tickCount = 0;
let frameCount = 0;
let fps = 0;

// createSimWorker control + events (saved in onInit).
let simControl: SimWorkerControl | null = null;
let simEvents: { emit: (kind: string, data?: any) => void } | null = null;

/** Permanently switch from pool-based stepping to inline SandWorld.
 *  Called when pool.step() hangs — nested workers loaded but can't communicate.
 *  Copies the current grid state from the SAB-backed boundary world into a
 *  fresh standalone SandWorld so the simulation can continue single-threaded. */
function switchToInlineFallback(reason: string): void {
  console.warn(`[sandjongg-worker] Switching to inline fallback: ${reason}`);
  // Snapshot the current grid + fields before destroying the pool.
  const oldW = world?.W ?? 0;
  const oldH = world?.H ?? 0;
  const oldGrid = world && oldW > 0 ? new Uint32Array(world.grid) : null;
  const oldFields = world && oldW > 0 ? new Uint8Array(world.fields) : null;
  if (pool) { try { pool.shutdown(); } catch { /* ignore */ } pool = null; }
  if (oldW > 0 && oldH > 0) {
    world = new SandWorld(oldW, oldH, { skipStoneFloor: true });
    for (const o of GRAVITY_OVERRIDES) {
      MAT_GRAVITY_DIR[o.mat] = o.gravityDir;
      if (o.gravity !== 0) MAT_GRAVITY[o.mat] = o.gravity;
    }
    if (oldGrid) world.grid.set(oldGrid);
    if (oldFields) world.fields.set(oldFields);
    world.reseed(0x9e3779b9);
  } else {
    world = null;
  }
}

// Board geometry within the sand grid.
let boardOriginSandCol = 0;
let boardOriginSandRow = 0;
// Per-tile footprint on the sand grid (in sand cells). Synced from the
// renderer's visual layout so crumbled sand spawns at the tile's on-screen
// position. Defaults to the legacy fixed footprint until the renderer reports.
let tileSandW = TILE_CELL_SIZE;
let tileSandH = TILE_CELL_SIZE;
let sandW = 0;
let sandH = 0;
let boardCols = 0;
let boardRows = 0;

// Generation options (synced from the renderer/store).
// noAdjacentSame: avoid placing the same element in orthogonally-adjacent cells.
let noAdjacentSame = false;
// customCols/customRows: when > 0, override level-based board dimensions.
let customCols = 0;
let customRows = 0;
// Game mode — drives board generation + selectability + matching rules.
let mode: GameMode = "sandjongg";
// Active tileset — determines the number of distinct tile types dealt and the
// sand-material mapping for crumbled tiles. Defaults to "elements" (18
// procedural elemental tiles). Changed via setTileset(); the renderer triggers
// a board regenerate after changing it because the tile count differs.
let activeTileset: TilesetId = "elements";

// Game state.
let level = 1;
let score = 0;
let matchState: MatchEngineState = resetComboState();

// Number of strip-workers for multi-threaded sand physics.
// Sandjongg uses a single sand step worker because the strip-based parallelism
// creates visible column artifacts at strip boundaries — liquids can't flow
// across strips during the main pass, and the 2-column boundary cleanup is too
// narrow to handle the 5-cell horizontal flow distance. The 512×512 grid is
// small enough that a single worker runs at 60fps with no issues.
//
// However, spawning a nested worker (sand-step-worker.ts) from within this
// worker (sandjongg-worker.ts) fails silently in some Electron environments:
// the nested worker loads and sends "ready", but then hangs on step messages,
// freezing the simulation. Rather than detecting and falling back from this
// unreliable nested-worker path, we skip it entirely and step a standalone
// SandWorld inline on this worker's thread. With a 512×512 grid and 1 worker,
// there is no parallelism loss — only the nested-worker failure mode is removed.
//
// Additionally, when the SAB polyfill is active (Android WebView), the
// SandStepPool cannot function — it spawns nested workers that share a SAB
// for parallel sand physics, but the polyfilled SAB is not actually shared
// (each thread gets its own ArrayBuffer copy). So we force inline mode.
const NUM_SAND_WORKERS = 1;
const USE_INLINE_FALLBACK = true; // Always inline — nested workers are unreliable + SAB polyfill

createSimWorker({
  fixedDt: 1 / 60,
  maxStepsPerFrame: 5,

  async onInit(sab: SharedArrayBuffer, control: SimWorkerControl, gridW: number, gridH: number): Promise<void> {
    sabRef = sab;
    sandW = gridW;
    sandH = gridH;
    simControl = control;
    simEvents = control.events;
    (globalThis as any).__ddThreadTag = "S0";
    writer = new SimBufferWriter(sab, OFFSETS, gridW, gridH);
    inputBuf = new Int32Array(sab, INPUT_OFFSET, INPUT_BYTES / 4);

    // Create the sand step pool (or skip it and use inline mode).
    // Nested workers (sand-step-worker.ts spawned from within this worker)
    // are unreliable in some Electron environments — they may load and send
    // "ready" but then hang on step messages, freezing the simulation. With
    // NUM_SAND_WORKERS = 1 there is no parallelism benefit, so we skip the
    // pool entirely and step a standalone SandWorld inline.
    //
    // Also skip when the SAB polyfill is active (Android WebView): the pool
    // shares a SAB with nested workers, but the polyfilled SAB is not actually
    // shared (each thread gets its own ArrayBuffer copy), so the pool would
    // silently produce incorrect results.
    if (!USE_INLINE_FALLBACK && usingRealSAB) {
      try {
        pool = new SandStepPool({ W: gridW, H: gridH, numWorkers: NUM_SAND_WORKERS, gravityOverrides: GRAVITY_OVERRIDES });
        await Promise.race([
          pool.init(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("pool.init() timed out — nested workers may be unsupported")), POOL_INIT_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        console.warn("[sandjongg-worker] SandStepPool init failed, using inline fallback:", String(err));
        if (pool) { try { pool.shutdown(); } catch { /* ignore */ } pool = null; }
      }
    }
    if (pool) {
      world = pool.getBoundaryWorld();
    } else {
      // Inline fallback: create a SandWorld directly (no nested workers).
      world = new SandWorld(gridW, gridH, { skipStoneFloor: true });
      // Apply gravity overrides (the pool would have done this).
      for (const o of GRAVITY_OVERRIDES) {
        MAT_GRAVITY_DIR[o.mat] = o.gravityDir;
        if (o.gravity !== 0) MAT_GRAVITY[o.mat] = o.gravity;
      }
    }
    world.reseed(0x9e3779b9);

    // Generate the first level.
    startLevel(1, 12345);
  },

  async onTick(_dt: number, ctx): Promise<void> {
    if (!world || !writer || !sabRef) return;

    tickCount = ctx.tickCount;

    processInput();

    const stepPool: SandStepPool | null = pool;
    if (!stepPool && !world) return;
    if (stepPool) {
      // Race pool.step() against a timeout — if the nested workers
      // loaded but can't communicate (hang on postMessage), fall back
      // to inline mode permanently.
      try {
        await Promise.race([
          stepPool.step(world.frame),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("pool.step() timed out")), POOL_STEP_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        switchToInlineFallback(String(err));
        if (!world) return;
        // Retry this tick inline.
        world.step();
      }
    } else {
      // Inline fallback: step the world directly on this thread.
      // Don't double-increment frame: world.step() already increments it.
      world.step();
    }
    if (pool !== stepPool) return; // resize replaced pool
    if (stepPool) world.frame++;
    writer.writeGrid(world.grid);
    writer.writeFieldGrid(world.fields);

    writeStats();
  },

  onAfterTicks(ctx): void {
    if (!writer) return;
    fps = ctx.fps;
    frameCount = ctx.frameCount;
    writer.writeStat(STATS.FPS, ctx.fps);
  },

  async onResize(gridW: number, gridH: number): Promise<void> {
    await doResize(gridW, gridH);
  },

  onShutdown(): void {
    if (pool) { pool.shutdown(); pool = null; }
    world = null;
  },

  // SAB polyfill: declare buffer sync regions (worker side).
  // The worker writes everything (including the input region, which it
  // clears after processing — e.g. ACTION → 0). The main thread writes
  // the input region (setting ACTION). This is a ping-pong protocol:
  //   1. Main sends input (ACTION=1) to worker
  //   2. Worker processes action, clears ACTION → 0
  //   3. Worker sends sim data + cleared input back to main
  //   4. Main sees ACTION=0, doesn't re-send stale action
  onSyncConfig(sab: SharedArrayBuffer): BufferSyncConfig {
    return {
      buffers: { sim: sab },
      regions: {
        sim: {
          // Worker writes: everything (including input, which it clears)
          writeRegions: [
            { offset: 0, length: INPUT_OFFSET, name: "pre-input" },
            { offset: INPUT_OFFSET, length: INPUT_BYTES, name: "input" },
            { offset: INPUT_OFFSET + INPUT_BYTES, length: TOTAL_BYTES - INPUT_OFFSET - INPUT_BYTES, name: "post-input" },
          ],
          // Main thread writes: input region only
          readRegions: [
            { offset: INPUT_OFFSET, length: INPUT_BYTES, name: "input" },
          ],
        },
      },
    };
  },

  extraApi: {
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
      if (!writer || !world) return;
      if (world.W !== gridW || world.H !== gridH) {
        await simControl?.withLoopStopped(() => doResize(gridW, gridH));
      }
      world.grid.set(grid.subarray(0, gridW * gridH));
      world.fields.set(fields.subarray(0, gridW * gridH * 4));
      // Repair gravity field for non-empty cells. Old saves may have gravity=0
      // for all cells (corrupted from a save cycle where the SAB fields were
      // never initialized). Without this, restored sand can't fall.
      const W = gridW, H = gridH;
      let repaired = 0;
      for (let i = 0; i < W * H; i++) {
        if (world.grid[i] !== 0 && world.fields[i * 4 + FIELD.GRAVITY] === 0) {
          world.fields[i * 4 + FIELD.GRAVITY] = DEFAULT_GRAVITY;
          repaired++;
        }
      }
      if (repaired > 0) {
        console.warn(`[loadGrid] Repaired gravity field for ${repaired} cells (had gravity=0)`);
      }
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
      // Sync local mode from the restored board so subsequent generation +
      // matching use the saved mode.
      mode = board.mode;
      boardCols = board.cols;
      boardRows = board.rows;
      // Recompute board origin within the sand grid.
      const boardSandW = boardCols * TILE_CELL_SIZE;
      boardOriginSandCol = Math.floor((sandW - boardSandW) / 2);
      boardOriginSandRow = WALL_THICKNESS + 1;
      writeBoardToSAB();
      writeStats();
    },

    /** Restore game progress (level, score, combo) when loading a save.
     *  loadBoardState() only restores the board layout — the worker's
     *  level/score/combo variables stay at their init values (level=1,
     *  score=0). Without this, writeStats() reports level=1/score=0 to
     *  the SAB, and the renderer's updateStatsFromSAB() overwrites the
     *  store back to level 1 on every frame. */
    setProgress(levelNum: number, scoreVal: number, comboVal: number): void {
      level = levelNum;
      score = scoreVal;
      matchState = resetComboState();
      matchState.combo = comboVal;
      writeStats();
    },

    /** Sync the board's sand-grid layout from the renderer's visual layout.
     *  The renderer computes where the board is drawn on screen (in canvas px)
     *  and converts that to sand-grid cells; this is where crumbled tile sand
     *  spawns so it appears at the tile's on-screen position. */
    setBoardLayout(originCol: number, originRow: number, tileW: number, tileH: number): void {
      tileSandW = Math.max(1, tileW);
      tileSandH = Math.max(1, tileH);
      boardOriginSandCol = originCol;
      boardOriginSandRow = originRow;
    },

    /** Enable/disable the no-adjacent-same-element generation constraint. */
    setNoAdjacentSame(enabled: boolean): void {
      noAdjacentSame = !!enabled;
    },

    /** Override board dimensions for the next generated level (0 = auto-scale). */
    setCustomDims(cols: number, rows: number): void {
      customCols = Math.max(0, Math.floor(cols));
      customRows = Math.max(0, Math.floor(rows));
    },

    /** Set the game mode. Applied to the live board immediately and used for
     *  the next generated level. The renderer triggers a new game after
     *  calling this so the board is regenerated in the new mode. */
    setMode(newMode: GameMode): void {
      mode = newMode;
      if (board) board.mode = newMode;
    },

    /** Set the active tileset. Used for the next generated level (the tile
     *  count differs between tilesets, so the current board's ids are
     *  invalidated — the renderer triggers a regenerate after calling this).
     *  Also updates the sand-material mapping for any subsequent spawnSand()
     *  calls. The tile count is read from the tileset registry so the worker
     *  doesn't need to know the specific tilesets. */
    setTileset(id: TilesetId): void {
      activeTileset = id;
    },

    /** Spawn sand at an exact sand-grid rect (driven by the renderer, which
     *  knows the tile's on-screen position at match time). This replaces the
     *  old crumble-event approach that computed positions from a generic layout
     *  sync — the exact-rect approach avoids rounding drift and per-layer
     *  offset mismatch. */
    spawnSand(sandCol: number, sandRow: number, sandW: number, sandH: number, element: number): void {
      if (!world) return;
      const mat = tilesetMaterial(activeTileset, element);
      if (mat === 0) return;
      const W = world.W;
      const fields = world.fields;
      const fw = Math.max(1, Math.round(sandW));
      const fh = Math.max(1, Math.round(sandH));
      const ox = Math.round(sandCol);
      const oy = Math.round(sandRow);
      for (let dy = 0; dy < fh; dy++) {
        for (let dx = 0; dx < fw; dx++) {
          const x = ox + dx;
          const y = oy + dy;
          if (x < 0 || x >= W || y < 0 || y >= world.H) continue;
          const idx = y * W + x;
          const curMat = world.grid[idx] & 0xff;
          if (curMat === Material.Wall) continue;
          world.grid[idx] = (mat & 0xff) | (Math.floor(Math.random() * 4) << 16);
          // Ensure the gravity field is set so the sand can fall. Old saves
          // may have gravity=0 (corrupted), which would freeze spawned sand.
          fields[idx * 4 + FIELD.GRAVITY] = DEFAULT_GRAVITY;
        }
      }
    },
  },
});

// --- Level management ---

function startLevel(levelNum: number, seed: number): void {
  const result = generateLevel(levelNum, seed, {
    noAdjacentSame,
    cols: customCols,
    rows: customRows,
    mode,
    tileset: activeTileset,
  });
  board = result.board;
  boardCols = board.cols;
  boardRows = board.rows;
  level = levelNum;

  // Compute a default board origin within the sand grid (centered, at the top).
  // The renderer overrides this via setBoardLayout() once it computes the
  // visual layout, so crumbled sand spawns at the tile's on-screen position.
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
  const fields = world.fields;

  // Clear the grid first.
  grid.fill(0);
  // Reset all fields to defaults. Old saves may have gravity=0 (corrupted
  // from a previous save cycle), which would freeze all sand. Resetting
  // here ensures every new level starts with correct gravity.
  for (let i = 0; i < W * H * 4; i += 4) {
    fields[i + FIELD.GRAVITY] = DEFAULT_GRAVITY;
    fields[i + FIELD.TEMP] = 128; // DEFAULT_TEMP
  }

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
    const result = attemptMatch(board, aCol, aRow, aLayer, bCol, bRow, bLayer, matchState, now, boardOriginSandCol, boardOriginSandRow, tileSandW, tileSandH);
    if (result.ok) {
      score += result.score;
      // Sand spawning is driven by the renderer via spawnSand() — it knows the
      // exact on-screen tile rect at match time, avoiding layout drift.
      writeBoardToSAB();
      writeStats();
      simEvents?.emit("matched", { score: result.score, combo: result.combo, path: result.path, element: result.crumble[0]?.element ?? 0 });
      // Check for dead-end after the match.
      if (board && !board.isCleared()) {
        if (!hasAnyMatch(board)) {
          simEvents?.emit("deadEnd", {});
        }
      }
    } else {
      simEvents?.emit("matchFailed", { reason: result.reason, a: { col: aCol, row: aRow, layer: aLayer }, b: { col: bCol, row: bRow, layer: bLayer } });
    }
  } else if (action === 2) {
    // Hint
    const hint = findHint(board);
    if (hint) {
      simEvents?.emit("hint", hint);
    } else {
      simEvents?.emit("noHint", {});
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

// --- Sand spawning ---
// Sand spawning is now driven by the renderer via the spawnSand() RPC, which
// receives exact sand-grid coordinates computed from the tile's on-screen rect
// at match time. The old crumble-event queue (pendingCrumble) is no longer used.

// --- Resize ---

async function doResize(gridW: number, gridH: number): Promise<void> {
  if (!writer || !sabRef) return;

  // Snapshot the old grid + fields before creating the new world so we can
  // preserve sand across the resize. On shrink, cells outside the new bounds
  // are dropped (clipped). On expand, existing sand stays in place and new
  // space appears on the right (cells from oldW..gridW are empty).
  const oldW = sandW;
  const oldH = sandH;
  const oldGrid = world ? new Uint32Array(world.grid) : null;
  const oldFields = world ? new Uint8Array(world.fields) : null;

  writer.setDims(gridW, gridH);
  sandW = gridW;
  sandH = gridH;

  if (pool) { try { pool.shutdown(); } catch { /* ignore */ } pool = null; }
  if (!USE_INLINE_FALLBACK) {
    try {
      pool = new SandStepPool({ W: gridW, H: gridH, numWorkers: NUM_SAND_WORKERS, gravityOverrides: GRAVITY_OVERRIDES });
      await Promise.race([
        pool.init(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("pool.init() timed out on resize")), POOL_INIT_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      console.warn("[sandjongg-worker] SandStepPool resize failed, using inline fallback:", String(err));
      if (pool) { try { pool.shutdown(); } catch { /* ignore */ } pool = null; }
    }
  }
  if (pool) {
    world = pool.getBoundaryWorld();
  } else {
    world = new SandWorld(gridW, gridH, { skipStoneFloor: true });
    for (const o of GRAVITY_OVERRIDES) {
      MAT_GRAVITY_DIR[o.mat] = o.gravityDir;
      if (o.gravity !== 0) MAT_GRAVITY[o.mat] = o.gravity;
    }
  }
  world.reseed(0x9e3779b9);

  // Rebuild pit walls first (clears the grid + builds walls).
  if (board) {
    const boardSandW = boardCols * TILE_CELL_SIZE;
    boardOriginSandCol = Math.floor((sandW - boardSandW) / 2);
    boardOriginSandRow = WALL_THICKNESS + 1;
  }
  buildPitWalls();

  // Restore sand from the old grid into the new world. Copy the overlapping
  // region (0..min(oldW,gridW), 0..min(oldH,gridH)), skipping wall cells in
  // both the old and new grids so pit walls are preserved.
  if (oldGrid && oldFields && world) {
    const copyW = Math.min(oldW, gridW);
    const copyH = Math.min(oldH, gridH);
    const newGrid = world.grid;
    const newFields = world.fields;
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const newIdx = y * gridW + x;
        if ((newGrid[newIdx] & 0xff) === Material.Wall) continue;
        const oldIdx = y * oldW + x;
        const oldVal = oldGrid[oldIdx];
        if ((oldVal & 0xff) === Material.Wall) continue;
        newGrid[newIdx] = oldVal;
        const fOld = oldIdx * 4;
        const fNew = newIdx * 4;
        newFields[fNew] = oldFields[fOld];
        newFields[fNew + 1] = oldFields[fOld + 1];
        newFields[fNew + 2] = oldFields[fOld + 2];
        newFields[fNew + 3] = oldFields[fOld + 3];
      }
    }
  }
}
