// ============================================================================
// Save system — persists game state to localStorage (renderer-side).
// ============================================================================


export interface SandjonggSaveData {
  version: number;
  level: number;
  score: number;
  combo: number;
  gridW: number;
  gridH: number;
  grid: number[]; // sand grid snapshot
  fields: number[]; // sand fields snapshot
  savedAt: number;
}

const SAVE_KEY = "sandjongg-autosave-v1";
const SAVE_VERSION = 1;

export function saveGame(data: Omit<SandjonggSaveData, "version" | "savedAt">): void {
  try {
    const full: SandjonggSaveData = {
      ...data,
      version: SAVE_VERSION,
      savedAt: Date.now(),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(full));
  } catch (err) {
    console.error("[SandjonggSave] Failed to save:", err);
  }
}

export function loadGame(): SandjonggSaveData | null {
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

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}

export function hasSave(): boolean {
  try {
    return localStorage.getItem(SAVE_KEY) !== null;
  } catch {
    return false;
  }
}

// --- Autosave API (matches alchemy's pattern) ---

export async function autosave(
  gridW: number,
  gridH: number,
  grid: Uint32Array,
  fields: Uint8Array,
  meta: { score: number; level: number; combo: number },
): Promise<void> {
  const data: SandjonggSaveData = {
    version: SAVE_VERSION,
    level: meta.level,
    score: meta.score,
    combo: meta.combo,
    gridW,
    gridH,
    grid: Array.from(grid),
    fields: Array.from(fields),
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (err) {
    console.error("[autosave] Failed:", err);
  }
}

export async function loadAutosave(): Promise<SandjonggSaveData | null> {
  return loadGame();
}
