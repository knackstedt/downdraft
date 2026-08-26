// ============================================================================
// Save system — persists game state via the engine's createGridSaveSystem.
// Migrated from localStorage to OPFS/IPC save store for consistency with
// other games. High score stays in localStorage (small, separate).
//
// Per-mode isolation: each game mode (sandjongg / mahjongg) gets its own
// autosave slot + high-score key, so the two modes never overwrite each
// other's progress.
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGridSaveSystem, type SaveState } from "@downdraft/core";
import type { GameMode, SerializedBoard } from "./shared/types";

export interface SandjonggSaveData {
  version: number;
  level: number;
  score: number;
  combo: number;
  highScore: number;
  gridW: number;
  gridH: number;
  /** Decoded grid (from save store blob). */
  grid: Uint32Array;
  /** Decoded fields (from save store blob). */
  fields: Uint8Array;
  /** Serialized tile board layout (for mid-level restore). */
  board: SerializedBoard | null;
  /** Game mode this save was made in. */
  mode: GameMode;
  savedAt: number;
}

const ENGINE_VERSION = "0.1.0";
const SAVE_VERSION = 3;
// Sandjongg keeps its original autosave slot + high-score key so existing
// players' progress carries over. Mahjongg (new mode) gets its own.
const AUTOSAVE_SLOT: Record<GameMode, string> = {
  sandjongg: "autosave",
  mahjongg: "autosave-mahjongg",
};
const HIGHSCORE_KEY: Record<GameMode, string> = {
  sandjongg: "sandjongg-highscore-v1",
  mahjongg: "sandjongg-highscore-mahjongg",
};

export interface SandjonggMeta {
  gridW: number;
  gridH: number;
  grid: Uint32Array;
  fields: Uint8Array;
  score: number;
  level: number;
  combo: number;
  highScore: number;
  board: SerializedBoard | null;
  mode: GameMode;
}

function buildState(meta: SandjonggMeta): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW: meta.gridW, gridH: meta.gridH, version: SAVE_VERSION } },
      progress: { v: 1, data: { score: meta.score, level: meta.level, combo: meta.combo, highScore: meta.highScore } },
      board: { v: 1, data: { board: meta.board, mode: meta.mode } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

function buildBlobs(meta: SandjonggMeta): Record<string, ArrayBuffer> {
  return {
    grid: meta.grid.buffer.slice(meta.grid.byteOffset, meta.grid.byteOffset + meta.grid.byteLength) as ArrayBuffer,
    fields: meta.fields.buffer.slice(meta.fields.byteOffset, meta.fields.byteOffset + meta.fields.byteLength) as ArrayBuffer,
  };
}

function parseEntry(state: SaveState, blobs: Record<string, ArrayBuffer> | null): SandjonggSaveData | null {
  const world = state.components.world?.data as { gridW: number; gridH: number; version: number } | undefined;
  const progress = state.components.progress?.data as { score: number; level: number; combo: number; highScore: number } | undefined;
  const boardComp = state.components.board?.data as { board: SerializedBoard | null; mode?: GameMode } | undefined;
  if (!world || !progress || !blobs) return null;
  const grid = new Uint32Array(blobs.grid);
  const fields = new Uint8Array(blobs.fields);
  return {
    version: world.version ?? SAVE_VERSION,
    level: progress.level,
    score: progress.score,
    combo: progress.combo,
    highScore: progress.highScore,
    gridW: world.gridW,
    gridH: world.gridH,
    grid,
    fields,
    board: boardComp?.board ?? null,
    mode: boardComp?.mode ?? "sandjongg",
    savedAt: state.meta.timestamp * 1000,
  };
}

// --- Per-mode save systems (one autosave slot per game mode) ---

const systems: Partial<Record<GameMode, ReturnType<typeof createGridSaveSystem<SandjonggMeta, SandjonggSaveData>>>> = {};

function getSystem(mode: GameMode) {
  let sys = systems[mode];
  if (!sys) {
    sys = createGridSaveSystem<SandjonggMeta, SandjonggSaveData>({
      createStore: () => createDefaultSaveStore(ENGINE_VERSION),
      autosaveSlot: AUTOSAVE_SLOT[mode],
      buildState,
      buildBlobs,
      parseEntry,
    });
    systems[mode] = sys;
  }
  return sys;
}

// --- High score API (stays in localStorage — small, separate, per-mode) ---

export function loadHighScore(mode: GameMode): number {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY[mode]);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export function saveHighScore(mode: GameMode, score: number): void {
  try {
    localStorage.setItem(HIGHSCORE_KEY[mode], String(score));
  } catch {
    // ignore
  }
}

// --- Autosave API ---

export async function autosave(meta: SandjonggMeta): Promise<void> {
  await getSystem(meta.mode).autosave(meta);
}

export async function loadAutosave(mode: GameMode): Promise<SandjonggSaveData | null> {
  return getSystem(mode).loadAutosave();
}

/** Check whether an autosave exists for the given mode WITHOUT triggering a
 *  load (which logs an ERROR in the OPFS save store when the slot directory
 *  doesn't exist yet). Uses the raw store's listSaves() which iterates the
 *  saves directory gracefully — missing directories are simply absent from
 *  the listing rather than throwing. */
export async function hasAutosave(mode: GameMode): Promise<boolean> {
  const store = await getSystem(mode).getStore();
  const slots = await store.listSaves();
  return slots.some((s) => s.slot === AUTOSAVE_SLOT[mode]);
}

/** Decode the grid from a save data object. (Now returns the already-decoded grid.) */
export function decodeGrid(save: SandjonggSaveData): Uint32Array {
  return save.grid;
}

/** Decode the fields from a save data object. (Now returns the already-decoded fields.) */
export function decodeFields(save: SandjonggSaveData): Uint8Array {
  return save.fields;
}
