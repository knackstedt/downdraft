// IndexedDB-based save/load system for the alchemy game.
// Each save stores: cauldron grid + fields, grid dims, meta-state (money,
// inventory, potions, unlocks, discovered recipes), and a screenshot thumbnail.

const DB_NAME = "alchemy-saves";
const DB_VERSION = 1;
const STORE_NAME = "saves";

export interface SaveEntry {
  id: string;
  name: string;
  timestamp: number;
  thumbnail: Blob;
  gridW: number;
  gridH: number;
  grid: Uint32Array;
  fields: Uint8Array;
  // Meta-state
  money: number;
  ingredientInventory: { mat: number; count: number }[];
  potions: any[];
  unlockedTiers: number[];
  discoveredRecipes: string[];
}

export interface SaveMetadata {
  id: string;
  name: string;
  timestamp: number;
  thumbnailUrl: string;
  gridW: number;
  gridH: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveGame(
  name: string,
  thumbnail: Blob,
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: {
    money: number;
    ingredientInventory: { mat: number; count: number }[];
    potions: any[];
    unlockedTiers: number[];
    discoveredRecipes: string[];
  },
): Promise<SaveEntry> {
  const db = await openDB();
  const id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: SaveEntry = {
    id, name, timestamp: Date.now(),
    thumbnail, gridW, gridH,
    grid: new Uint32Array(grid),
    fields: new Uint8Array(fields),
    money: meta.money,
    ingredientInventory: meta.ingredientInventory,
    potions: meta.potions,
    unlockedTiers: meta.unlockedTiers,
    discoveredRecipes: meta.discoveredRecipes,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve(entry);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadGame(id: string): Promise<SaveEntry | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function listSaves(): Promise<SaveMetadata[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const entries = req.result as SaveEntry[];
      const metas = entries
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((e) => ({
          id: e.id,
          name: e.name,
          timestamp: e.timestamp,
          thumbnailUrl: URL.createObjectURL(e.thumbnail),
          gridW: e.gridW,
          gridH: e.gridH,
        }));
      resolve(metas);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSave(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function captureThumbnail(canvas: HTMLCanvasElement): Promise<Blob> {
  const maxW = 320;
  const scale = Math.min(1, maxW / canvas.width);
  const thumbW = Math.floor(canvas.width * scale);
  const thumbH = Math.floor(canvas.height * scale);

  const fullBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });

  if (fullBlob) {
    const img = new Image();
    const url = URL.createObjectURL(fullBlob);
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img load"));
        img.src = url;
      });
      const off = document.createElement("canvas");
      off.width = thumbW;
      off.height = thumbH;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(img, 0, 0, thumbW, thumbH);
      const thumbBlob = await new Promise<Blob | null>((resolve) => {
        off.toBlob((b) => resolve(b), "image/jpeg", 0.8);
      });
      if (thumbBlob) return thumbBlob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const placeholder = document.createElement("canvas");
  placeholder.width = 320;
  placeholder.height = 180;
  const pctx = placeholder.getContext("2d")!;
  pctx.fillStyle = "#0a0a12";
  pctx.fillRect(0, 0, 320, 180);
  pctx.fillStyle = "rgba(255,255,255,0.5)";
  pctx.font = "14px monospace";
  pctx.textAlign = "center";
  pctx.fillText("No preview", 160, 90);
  const phBlob = await new Promise<Blob | null>((resolve) => {
    placeholder.toBlob((b) => resolve(b), "image/jpeg", 0.8);
  });
  if (phBlob) return phBlob;
  throw new Error("Thumbnail capture failed");
}

// --- Autosave (single-slot, no thumbnail for speed) ---

const AUTOSAVE_ID = "autosave";
const AUTOSAVE_PLACEHOLDER_THUMB = new Blob([], { type: "image/jpeg" });

export async function autosave(
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: {
    money: number;
    ingredientInventory: { mat: number; count: number }[];
    potions: any[];
    unlockedTiers: number[];
    discoveredRecipes: string[];
  },
): Promise<void> {
  const db = await openDB();
  const entry: SaveEntry = {
    id: AUTOSAVE_ID,
    name: "Autosave",
    timestamp: Date.now(),
    thumbnail: AUTOSAVE_PLACEHOLDER_THUMB,
    gridW, gridH,
    grid: new Uint32Array(grid),
    fields: new Uint8Array(fields),
    money: meta.money,
    ingredientInventory: meta.ingredientInventory,
    potions: meta.potions,
    unlockedTiers: meta.unlockedTiers,
    discoveredRecipes: meta.discoveredRecipes,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame(AUTOSAVE_ID);
}
