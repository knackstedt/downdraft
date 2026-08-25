// ============================================================================
// Save system — persists game state via @downdraft/app/renderer createSaveStore.
// Migrated from localStorage to OPFS/IPC save store for consistency with
// other games. High score stays in localStorage (small, separate).
// ============================================================================

import { createSaveStore, downdraft } from "@downdraft/app/renderer";
import type { ISaveStore, SaveState } from "@downdraft/core";
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

const AUTOSAVE_SLOT = "autosave";
const ENGINE_VERSION = "0.1.0";
const SAVE_VERSION = 2;
const HIGHSCORE_KEY = "sandjongg-highscore-v1";

let storePromise: Promise<ISaveStore> | null = null;

function getStore(): Promise<ISaveStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const store = await createSaveStore({
        mode: "auto",
        opfsOptions: { engineVersion: ENGINE_VERSION },
        bridge: downdraft,
      });
      if (!store) {
        const { OpfsSaveStore } = await import("@downdraft/library-persistence/browser");
        const fallback = new OpfsSaveStore({ engineVersion: ENGINE_VERSION });
        await fallback.init();
        return fallback;
      }
      return store;
    })();
  }
  return storePromise;
}

function buildState(
  gridW: number,
  gridH: number,
  meta: { score: number; level: number; combo: number; highScore: number },
  board: SerializedBoard | null,
): SaveState {
  return {
    components: {
      world: { v: 1, data: { gridW, gridH, version: SAVE_VERSION } },
      progress: { v: 1, data: { score: meta.score, level: meta.level, combo: meta.combo, highScore: meta.highScore } },
      board: { v: 1, data: { board } },
    },
    meta: {
      engineVersion: ENGINE_VERSION,
      timestamp: Date.now() / 1000,
      entityCount: 0,
      playerCount: 1,
    },
  };
}

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

export async function autosave(
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: { score: number; level: number; combo: number; highScore: number },
  board: SerializedBoard | null,
): Promise<void> {
  const store = await getStore();
  const state = buildState(gridW, gridH, meta, board);
  await store.save(AUTOSAVE_SLOT, state, {
    properties: { name: "Autosave", savedAt: Date.now() },
    blobs: {
      grid: grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength) as ArrayBuffer,
      fields: fields.buffer.slice(fields.byteOffset, fields.byteOffset + fields.byteLength) as ArrayBuffer,
    },
  });
}

export async function loadAutosave(): Promise<SandjonggSaveData | null> {
  const store = await getStore();
  const result = await store.load(AUTOSAVE_SLOT);
  if (!result.state) return null;
  const world = result.state.components.world?.data as { gridW: number; gridH: number; version: number } | undefined;
  const progress = result.state.components.progress?.data as { score: number; level: number; combo: number; highScore: number } | undefined;
  const boardComp = result.state.components.board?.data as { board: SerializedBoard | null } | undefined;
  if (!world || !progress || !result.blobs) return null;
  const grid = new Uint32Array(result.blobs.grid);
  const fields = new Uint8Array(result.blobs.fields);
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
    savedAt: result.state.meta.timestamp * 1000,
  };
}

/** Decode the grid from a save data object. (Now returns the already-decoded grid.) */
export function decodeGrid(save: SandjonggSaveData): Uint32Array {
  return save.grid;
}

/** Decode the fields from a save data object. (Now returns the already-decoded fields.) */
export function decodeFields(save: SandjonggSaveData): Uint8Array {
  return save.fields;
}
