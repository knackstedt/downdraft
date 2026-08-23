// ============================================================================
// Save system — persists game state to localStorage (renderer-side).
// Uses base64-encoded binary for the sand grid + fields to keep save size
// small and avoid JSON parse/stringify overhead on large arrays.
// ============================================================================

import type { SerializedBoard } from "./shared/types";

export interface SandjonggSaveData {
  version: number;
  level: number;
  score: number;
  combo: number;
  highScore: number;
  gridW: number;
  gridH: number;
  /** Base64-encoded Uint32Array of the sand grid. */
  gridB64: string;
  /** Base64-encoded Uint8Array of the sand fields. */
  fieldsB64: string;
  /** Serialized tile board layout (for mid-level restore). */
  board: SerializedBoard | null;
  savedAt: number;
}

const SAVE_KEY = "sandjongg-autosave-v2";
const SAVE_VERSION = 2;
const HIGHSCORE_KEY = "sandjongg-highscore-v1";

// --- Binary encoding helpers ---

/** Convert a Uint8Array to a base64 string, chunking to avoid call stack overflow. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32KB chunks — well within call stack limits
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint32ToBase64(arr: Uint32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return bytesToBase64(bytes);
}

function base64ToUint32(b64: string): Uint32Array {
  const bytes = base64ToBytes(b64);
  return new Uint32Array(bytes.buffer);
}

function uint8ToBase64(arr: Uint8Array): string {
  return bytesToBase64(arr);
}

function base64ToUint8(b64: string): Uint8Array {
  return base64ToBytes(b64);
}

// --- High score API ---

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
  const data: SandjonggSaveData = {
    version: SAVE_VERSION,
    level: meta.level,
    score: meta.score,
    combo: meta.combo,
    highScore: meta.highScore,
    gridW,
    gridH,
    gridB64: uint32ToBase64(grid),
    fieldsB64: uint8ToBase64(fields),
    board,
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (err) {
    console.error("[autosave] Failed:", err);
  }
}

export async function loadAutosave(): Promise<SandjonggSaveData | null> {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SandjonggSaveData;
    if (data.version !== SAVE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

/** Decode the grid from a save data object into a Uint32Array. */
export function decodeGrid(save: SandjonggSaveData): Uint32Array {
  return base64ToUint32(save.gridB64);
}

/** Decode the fields from a save data object into a Uint8Array. */
export function decodeFields(save: SandjonggSaveData): Uint8Array {
  return base64ToUint8(save.fieldsB64);
}
