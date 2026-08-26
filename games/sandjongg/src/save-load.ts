// ============================================================================
// Save load / mode start helpers — bridges the React UI (app.tsx) with the
// renderer + worker + save store. Kept in its own module so app.tsx and
// main.tsx can both import it without a circular dependency.
// ============================================================================

import type { SandjonggSaveData } from "./save-system";
import { hasAutosave, loadAutosave, loadHighScore, saveHighScore } from "./save-system";
import type { GameMode } from "./shared/types";
import { useGameStore } from "./stores/game-store";

/** Apply a loaded save to the renderer + worker + store. Used by the main
 *  menu "Continue" flow. */
export async function applySave(saved: SandjonggSaveData): Promise<void> {
  const renderer = useGameStore.getState().renderer;
  if (!renderer) return;
  // Load the sand grid + fields first (resizes the world if needed).
  await renderer.loadSave(saved.grid, saved.fields, saved.gridW, saved.gridH);
  // Then restore the tile board layout + worker progress.
  if (saved.board) {
    await renderer.getWorkerHost()?.loadBoardState(saved.board);
  }
  await renderer.getWorkerHost()?.setProgress(saved.level, saved.score, saved.combo);
  // Set the store mode quietly (no pending mode-change → no new game) so the
  // UI + renderer use the saved mode's rules without regenerating the board.
  useGameStore.setState({
    mode: saved.mode,
    score: saved.score,
    level: saved.level,
    combo: saved.combo,
  });
  if (saved.highScore > 0) {
    useGameStore.getState().setHighScore(saved.highScore);
  }
  console.log(`[save-load] Restored ${saved.mode} session (level ${saved.level})`);
}

/** Start a brand-new game in the given mode (level 1, score 0). Triggers the
 *  renderer's mode-change + new-game pending flow. */
export function startNewGame(mode: GameMode): void {
  const store = useGameStore.getState();
  const renderer = store.renderer;
  // Reset display state for a clean start. The worker's newGame() will reset
  // its own score/combo; these store resets avoid a stale-value flash before
  // the next SAB stats poll updates them.
  useGameStore.setState({
    mode,
    level: 1,
    score: 0,
    combo: 0,
    tilesLeft: 0,
    lastMatchTime: 0,
    noAdjacentUserSet: false,
    noAdjacentSame: false,
    _pendingModeChange: true,
  });
  // Load this mode's high score into the HUD.
  const hs = loadHighScore(mode);
  useGameStore.getState().setHighScore(hs);
  // Hide the main menu + resume the sim (it was paused while the menu showed).
  useGameStore.getState().setShowMainMenu(false);
  renderer?.getWorkerHost()?.resume();
  useGameStore.getState().setPaused(false);
}

/** Continue the given mode from its autosave. If no save exists, falls back to
 *  starting a new game. Returns true if a save was loaded. */
export async function continueMode(mode: GameMode): Promise<boolean> {
  const saved = await loadAutosave(mode);
  if (!saved) {
    startNewGame(mode);
    return false;
  }
  await applySave(saved);
  // Load this mode's high score.
  const hs = loadHighScore(mode);
  useGameStore.getState().setHighScore(hs);
  // Persist the high score if the save carried one (keeps localStorage in sync).
  if (saved.highScore > 0) saveHighScore(mode, saved.highScore);
  // Hide the main menu + resume.
  useGameStore.getState().setShowMainMenu(false);
  const renderer = useGameStore.getState().renderer;
  renderer?.getWorkerHost()?.resume();
  useGameStore.getState().setPaused(false);
  return true;
}

/** Check both modes for an existing autosave and update the store's hasSave
 *  map so the main menu can show/hide "Continue" buttons. Uses hasAutosave()
 *  (which lists the saves directory) instead of loadAutosave() (which logs an
 *  ERROR in the OPFS store when the slot doesn't exist yet). */
export async function refreshSaveAvailability(): Promise<void> {
  for (const mode of ["sandjongg", "mahjongg"] as GameMode[]) {
    const exists = await hasAutosave(mode);
    useGameStore.getState().setHasSave(mode, exists);
  }
}

/** Return to the main menu (from the pause menu). Pauses the sim. */
export function returnToMainMenu(): void {
  const store = useGameStore.getState();
  store.renderer?.getWorkerHost()?.pause();
  store.setPaused(true);
  store.setShowPauseMenu(false);
  store.setShowMainMenu(true);
  refreshSaveAvailability();
}
