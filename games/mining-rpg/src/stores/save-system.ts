// ============================================================================
// SaveSystem — IndexedDB-based persistence for the mining RPG.
//
// Only **dirty** chunks are persisted (unmodified chunks regenerate from
// seed). The save includes: player state, inventory, world seed, and all
// dirty chunk data (grid + fields + wakeTick).
//
// Autosave runs every 3 seconds (skipped in deterministic mode).
// Autosave data is loaded on startup before the worker begins simulating.
// ============================================================================

import { WORLD_SEED } from "../shared/constants";
import type { InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
import type { SavedChunk } from "../simulation/chunk-world";

const DB_NAME = "mining-rpg-save";
const DB_VERSION = 1;
const STORE_META = "meta";
const STORE_CHUNKS = "chunks";
const SAVE_KEY = "world";
const AUTOSAVE_INTERVAL_MS = 3000;

export interface SaveData {
  version: number;
  seed: number;
  player: MiningPlayerState;
  upgrades: PlayerUpgrades;
  inventory: InventoryEntry[];
  currency: number;
  chunks: SavedChunk[];
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Save the world state to IndexedDB. */
export async function saveWorld(data: SaveData): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_META, STORE_CHUNKS], "readwrite");

  // Save metadata (player, inventory, seed)
  const metaStore = tx.objectStore(STORE_META);
  metaStore.put({
    version: data.version,
    seed: data.seed,
    player: data.player,
    inventory: data.inventory,
    currency: data.currency,
    savedAt: data.savedAt,
  }, SAVE_KEY);

  // Save dirty chunks — clear old chunks first, then write new ones
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  chunkStore.clear();
  for (const chunk of data.chunks) {
    const key = `${chunk.cx},${chunk.cy}`;
    // Copy typed arrays to plain arrays for structured clone compatibility
    chunkStore.put({
      key,
      cx: chunk.cx,
      cy: chunk.cy,
      grid: chunk.grid,
      fields: chunk.fields,
      wakeTick: chunk.wakeTick,
    });
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Load the world state from IndexedDB. Returns null if no save exists. */
export async function loadWorld(): Promise<SaveData | null> {
  const db = await openDB();

  // Load metadata
  const meta = await new Promise<any>((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(SAVE_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
  if (!meta) return null;

  // Load all saved chunks
  const chunks = await new Promise<SavedChunk[]>((resolve, reject) => {
    const tx = db.transaction(STORE_CHUNKS, "readonly");
    const req = tx.objectStore(STORE_CHUNKS).getAll();
    req.onsuccess = () => {
      const results = (req.result ?? []) as any[];
      resolve(results.map((r) => ({
        cx: r.cx,
        cy: r.cy,
        grid: r.grid as Uint32Array,
        fields: r.fields as Uint8Array,
        wakeTick: r.wakeTick as Uint32Array,
      })));
    };
    req.onerror = () => reject(req.error);
  });

  return {
    version: meta.version,
    seed: meta.seed ?? WORLD_SEED,
    player: meta.player,
    upgrades: meta.upgrades ?? { damage: 0, radius: 0, rate: 0, inventorySize: 0 },
    inventory: meta.inventory ?? [],
    currency: meta.currency ?? 0,
    chunks,
    savedAt: meta.savedAt ?? 0,
  };
}

/** Delete the save data (new game / reset). */
export async function deleteSave(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_META, STORE_CHUNKS], "readwrite");
  tx.objectStore(STORE_META).delete(SAVE_KEY);
  tx.objectStore(STORE_CHUNKS).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * AutosaveManager — runs saveWorld() on an interval.
 * Skipped when deterministic mode is active (DOWNDRAFT_DETERMINISTIC env).
 */
export class AutosaveManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private getSaveData: () => Promise<SaveData> | SaveData;
  private deterministic: boolean;

  constructor(getSaveData: () => Promise<SaveData> | SaveData, deterministic: boolean = false) {
    this.getSaveData = getSaveData;
    this.deterministic = deterministic;
  }

  start(): void {
    if (this.deterministic) return; // no autosave in deterministic mode
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.saveNow().catch((e) => console.error("[AutosaveManager] Save failed:", e));
    }, AUTOSAVE_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async saveNow(): Promise<void> {
    if (this.deterministic) return;
    const data = await this.getSaveData();
    await saveWorld(data);
  }
}
