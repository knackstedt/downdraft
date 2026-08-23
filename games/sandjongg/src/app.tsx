import { useEffect, useRef } from "react";
import { useGameStore } from "./stores/game-store";

export default function App() {
  const score = useGameStore((s) => s.score);
  const combo = useGameStore((s) => s.combo);
  const level = useGameStore((s) => s.level);
  const tilesLeft = useGameStore((s) => s.tilesLeft);
  const highScore = useGameStore((s) => s.highScore);
  const paused = useGameStore((s) => s.paused);
  const showHelp = useGameStore((s) => s.showHelp);
  const fps = useGameStore((s) => s.fps);
  const toast = useGameStore((s) => s.toast);

  const requestHint = useGameStore((s) => s.requestHint);
  const requestShuffle = useGameStore((s) => s.requestShuffle);
  const requestNewGame = useGameStore((s) => s.requestNewGame);
  const requestClearSand = useGameStore((s) => s.requestClearSand);
  const toggleHelp = useGameStore((s) => s.toggleHelp);
  const setPaused = useGameStore((s) => s.setPaused);

  // Track whether the game has ever reported a non-zero tile count.
  // This prevents the auto-advance from firing before the renderer/worker
  // have initialized and written tilesLeft to the SAB. Without this guard,
  // the store starts with tilesLeft=0, the useEffect fires immediately,
  // and if renderer.init() takes >2s the timer fires requestNewGame before
  // the worker has ever reported tiles — causing a stuck _pendingNewGame
  // flag that triggers repeated level advances on every setTilesLeft call.
  const hasSeenTiles = useRef(false);
  if (tilesLeft > 0) hasSeenTiles.current = true;

  // Auto-advance to next level when board is cleared.
  // Uses requestAdvance (not requestNewGame) so the score is preserved.
  // Only fire after the game has initialized (hasSeenTiles) so we don't
  // auto-advance through empty levels during startup.
  useEffect(() => {
    if (tilesLeft === 0 && level > 0 && hasSeenTiles.current) {
      // Board cleared — wait a moment for sand to fall, then advance.
      const timer = setTimeout(() => {
        useGameStore.getState().requestAdvance(level + 1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [tilesLeft, level]);

  return (
    <div className="sandjongg-overlay">
      {/* Top HUD */}
      <div className="sandjongg-hud-top">
        <div className="sandjongg-stat">
          <span className="label">Level</span>
          <span className="value">{level}</span>
        </div>
        <div className="sandjongg-stat">
          <span className="label">Score</span>
          <span className="value">{score.toLocaleString()}</span>
        </div>
        <div className="sandjongg-stat">
          <span className="label">Best</span>
          <span className="value">{highScore.toLocaleString()}</span>
        </div>
        <div className="sandjongg-stat combo">
          <span className="label">Combo</span>
          <span className="value">x{combo}</span>
        </div>
        <div className="sandjongg-stat">
          <span className="label">Tiles</span>
          <span className="value">{tilesLeft}</span>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="sandjongg-toast" key={toast.id}>
          {toast.message}
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="sandjongg-toolbar">
        <button onClick={() => requestHint()} title="Hint (H)">
          Hint
        </button>
        <button onClick={() => requestShuffle()} title="Shuffle (F)">
          Shuffle
        </button>
        <button onClick={() => requestNewGame(level)} title="Restart (N)">
          Restart
        </button>
        <button onClick={() => requestClearSand()} title="Clear sand">
          Clear Pit
        </button>
        <button
          onClick={() => {
            const r = useGameStore.getState().renderer;
            if (paused) { r?.getWorkerHost()?.resume(); setPaused(false); }
            else { r?.getWorkerHost()?.pause(); setPaused(true); }
          }}
          title="Pause (P)"
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={toggleHelp} title="Help">
          Help
        </button>
      </div>

      {/* FPS counter */}
      <div className="sandjongg-fps">{fps} FPS</div>

      {/* Help modal */}
      {showHelp && (
        <div className="sandjongg-help" onClick={toggleHelp}>
          <div className="sandjongg-help-content" onClick={(e) => e.stopPropagation()}>
            <h2>Sandjongg</h2>
            <p>
              Match pairs of identical elemental tiles by connecting them with a path
              of at most 2 turns. When matched, tiles crumble into elemental sand that
              falls into the pit below — where it reacts! Fire ignites oil, water
              extinguishes lava, acid dissolves metal, and more. Watch the chaos unfold.
            </p>
            <h3>Controls</h3>
            <ul>
              <li><b>Click</b> a tile to select it, then click a matching tile to connect.</li>
              <li><b>H</b> — Show a hint (highlights a valid pair).</li>
              <li><b>F</b> — Shuffle remaining tiles.</li>
              <li><b>N</b> — Restart the current level.</li>
              <li><b>P</b> — Pause/resume the simulation.</li>
              <li><b>Clear Pit</b> — Remove all sand from the pit below the board.</li>
            </ul>
            <h3>Scoring</h3>
            <p>
              Each match scores points based on the path length and current combo.
              Quick consecutive matches build a combo multiplier for higher scores.
              Your best score is saved and shown as "Best" in the HUD.
            </p>
            <h3>Dead Ends</h3>
            <p>
              If no valid moves remain but tiles are left, the board auto-shuffles so
              you can keep playing. You can also shuffle manually at any time with <b>F</b>.
            </p>
            <button onClick={toggleHelp}>Close</button>
          </div>
        </div>
      )}

      {/* Level cleared overlay */}
      {tilesLeft === 0 && (
        <div className="sandjongg-level-cleared">
          <h2>Level {level} Cleared!</h2>
          <p>Advancing to level {level + 1}...</p>
        </div>
      )}
    </div>
  );
}
