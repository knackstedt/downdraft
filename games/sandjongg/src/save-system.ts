// ============================================================================
// Save system — persists game state via the engine's createGridSaveSystem.
// Migrated from localStorage to OPFS/IPC save store for consistency with
// other games. High score stays in localStorage (small, separate).
// ============================================================================

import { createDefaultSaveStore } from "@downdraft/app/renderer";
import { createGridSaveSystem, type SaveState } from "@downdraft/core";
import type { SerializedBoard } from "./shared/types";

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
  savedAt: number;
}

const ENGINE_VERSION = "0.1.0";
const SAVE_VERSION = 2;
const HIGHSCORE_KEY = "sandjongg-highscore-v1";

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
}

function buildState(meta: SandjonggMeta): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW: meta.gridW, gridH: meta.gridH, version: SAVE_VERSION } },
      progress: { v: 1, data: { score: meta.score, level: meta.level, combo: meta.combo, highScore: meta.highScore } },
      board: { v: 1, data: { board: meta.board } },
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
  const boardComp = state.components.board?.data as { board: SerializedBoard | null } | undefined;
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
    savedAt: state.meta.timestamp * 1000,
  };
}

const system = createGridSaveSystem<SandjonggMeta, SandjonggSaveData>({
  createStore: () => createDefaultSaveStore(ENGINE_VERSION),
  autosaveSlot: "autosave",
  buildState,
  buildBlobs,
  parseEntry,
});

// --- High score API (stays in localStorage — small, separate) ---

export function loadHighScore(): number {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

export function saveHighScore(score: number): void {
  try {
    localStorage.setItem(HIGHSCORE_KEY, String(score));
  } catch {
    // ignore
  }
}

// --- Autosave API ---

export async function autosave(meta: SandjonggMeta): Promise<void> {
  await system.autosave(meta);
}

export async function loadAutosave(): Promise<SandjonggSaveData | null> {
  return system.loadAutosave();
}

/** Decode the grid from a save data object. (Now returns the already-decoded grid.) */
export function decodeGrid(save: SandjonggSaveData): Uint32Array {
  return save.grid;
}

/** Decode the fields from a save data object. (Now returns the already-decoded fields.) */
export function decodeFields(save: SandjonggSaveData): Uint8Array {
  return save.fields;
}
