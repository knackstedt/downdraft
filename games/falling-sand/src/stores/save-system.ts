// IndexedDB-based save/load system for falling-sand game state.
// Each save stores: grid data for all layers, field data, grid dims, and a
// screenshot thumbnail (JPEG) captured from the canvas.

const DB_NAME = "falling-sand-saves";
const DB_VERSION = 1;
const STORE_NAME = "saves";

export interface SaveEntry {
  id: string;
  name: string;
  timestamp: number;
  thumbnail: Blob;       // JPEG screenshot
  gridW: number;
  gridH: number;
  numLayers: number;
  grids: Uint32Array[];  // one per layer
  fields: Uint8Array[];  // one per layer
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
  grids: Uint32Array[],
  fields: Uint8Array[],
): Promise<SaveEntry> {
  const db = await openDB();
  const id = `save-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: SaveEntry = {
    id, name, timestamp: Date.now(),
    thumbnail, gridW, gridH,
    numLayers: grids.length,
    grids: grids.map((g) => new Uint32Array(g)),
    fields: fields.map((f) => new Uint8Array(f)),
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

  // Capture full-res JPEG from the WebGPU canvas, then downscale via Image
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

  // Placeholder if capture fails
  const placeholder = document.createElement("canvas");
  placeholder.width = 320;
  placeholder.height = 180;
  const pctx = placeholder.getContext("2d")!;
  pctx.fillStyle = "#1a1a2e";
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

// ============================================================================
// Autosave — single-slot save that gets overwritten each time.
// Skips thumbnail capture for speed. Used for automatic restore on startup.
// ============================================================================

const AUTOSAVE_ID = "autosave";
const AUTOSAVE_PLACEHOLDER_THUMB = new Blob([], { type: "image/jpeg" });

/** Save game state to the autosave slot (overwrites previous autosave). */
export async function autosave(
  gridW: number,
  gridH: number,
  grids: Uint32Array[],
  fields: Uint8Array[],
): Promise<void> {
  const db = await openDB();
  const entry: SaveEntry = {
    id: AUTOSAVE_ID,
    name: "Autosave",
    timestamp: Date.now(),
    thumbnail: AUTOSAVE_PLACEHOLDER_THUMB,
    gridW, gridH,
    numLayers: grids.length,
    grids: grids.map((g) => new Uint32Array(g)),
    fields: fields.map((f) => new Uint8Array(f)),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the autosave slot. Returns null if no autosave exists. */
export async function loadAutosave(): Promise<SaveEntry | null> {
  return loadGame(AUTOSAVE_ID);
}

