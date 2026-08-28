import { memo, useEffect, useRef, useState } from "react";
import { continueMode, refreshSaveAvailability, returnToMainMenu, startNewGame } from "./save-load";
import { COMBO_WINDOW_MS, MAX_COLS, MAX_ROWS } from "./shared/constants";
import { TILESET_IDS, type TilesetId, type TileTheme } from "./shared/tilesets";
import type { GameMode } from "./shared/types";
import { useGameStore } from "./stores/game-store";

/** Combo stat + countdown bar. Isolated in its own component so the per-frame
 *  rAF tick only re-renders this tiny subtree, not the entire App overlay. */
const ComboTimer = memo(function ComboTimer() {
  const combo = useGameStore((s) => s.combo);
  const lastMatchTime = useGameStore((s) => s.lastMatchTime);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (combo <= 0 || lastMatchTime <= 0) { setNow(0); return; }
    let raf = 0;
    const tick = () => { setNow(performance.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [combo, lastMatchTime]);
  const remaining = (combo > 0 && lastMatchTime > 0)
    ? Math.max(0, Math.min(1, (COMBO_WINDOW_MS - (now - lastMatchTime)) / COMBO_WINDOW_MS))
    : 0;
  return (
    <div className="sandjongg-stat combo">
      <span className="label">Combo</span>
      <span className="value">x{combo}</span>
      {combo > 0 && (
        <div className="sandjongg-combo-bar" aria-hidden="true">
          <div className="sandjongg-combo-bar-fill" style={{ width: `${remaining * 100}%` }} />
        </div>
      )}
    </div>
  );
});

// ----------------------------------------------------------------------------
// TilesetSelector — segmented control for picking the tileset (Elements /
// Riichi) and theme (Light / Dark). Shared by the main menu and the Settings
// panel so the player can pick before starting OR switch live mid-game.
// Tileset change regenerates the current level (keeps score); theme change
// is purely visual (reloads the SVG atlas, no regenerate).
// ----------------------------------------------------------------------------

const TILESET_LABELS: Record<TilesetId, string> = {
  elements: "Elements",
  riichi: "Riichi",
};

const TILETHEME_LABELS: Record<TileTheme, string> = {
  light: "Light",
  dark: "Dark",
};

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="sandjongg-segmented">
      <span className="sandjongg-segmented-label">{label}</span>
      <div className="sandjongg-segmented-options">
        {options.map((opt) => (
          <button
            key={opt}
            className={`sandjongg-segmented-btn${opt === value ? " sandjongg-btn-active" : ""}`}
            onClick={() => onChange(opt)}
          >
            {TILESET_LABELS[opt as TilesetId] ?? TILETHEME_LABELS[opt as TileTheme] ?? opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function TilesetSelector() {
  const tileset = useGameStore((s) => s.tileset);
  const tileTheme = useGameStore((s) => s.tileTheme);
  const setTileset = useGameStore((s) => s.setTileset);
  const setTileTheme = useGameStore((s) => s.setTileTheme);
  return (
    <div className="sandjongg-tileset-selector">
      <SegmentedControl
        label="Tileset"
        value={tileset}
        options={TILESET_IDS}
        labels={TILESET_LABELS}
        onChange={setTileset}
      />
      <SegmentedControl
        label="Theme"
        value={tileTheme}
        options={["light", "dark"] as const}
        labels={TILETHEME_LABELS}
        onChange={setTileTheme}
      />
    </div>
  );
}

const MODES: { id: GameMode; name: string; tagline: string; description: string }[] = [
  {
    id: "sandjongg",
    name: "Sandjongg",
    tagline: "Connect + Sand",
    description:
      "Shisen-Sho connect: match identical tiles by linking them with a path of at most 2 turns. " +
      "Crumbling tiles fall into a reactive sand pit — fire ignites oil, water quenches lava, acid dissolves metal.",
  },
  {
    id: "mahjongg",
    name: "Mahjongg",
    tagline: "Classic Layered",
    description:
      "Classic Mahjongg Solitaire: match pairs of free tiles (nothing stacked on top, at least one side open). " +
      "Layered pyramid boards. Cross-layer matches allowed. Sand pit optional — disable it for a pure puzzle.",
  },
];

export default function App() {
  const score = useGameStore((s) => s.score);
  const level = useGameStore((s) => s.level);
  const tilesLeft = useGameStore((s) => s.tilesLeft);
  const highScore = useGameStore((s) => s.highScore);
  const showHelp = useGameStore((s) => s.showHelp);
  const fps = useGameStore((s) => s.fps);
  const toast = useGameStore((s) => s.toast);

  const requestHint = useGameStore((s) => s.requestHint);
  const requestShuffle = useGameStore((s) => s.requestShuffle);
  const requestNewGame = useGameStore((s) => s.requestNewGame);
  const requestClearSand = useGameStore((s) => s.requestClearSand);
  const toggleHelp = useGameStore((s) => s.toggleHelp);
  const setPaused = useGameStore((s) => s.setPaused);

  const showSettings = useGameStore((s) => s.showSettings);
  const toggleSettings = useGameStore((s) => s.toggleSettings);
  const noAdjacentSame = useGameStore((s) => s.noAdjacentSame);
  const toggleNoAdjacentSame = useGameStore((s) => s.toggleNoAdjacentSame);
  const customCols = useGameStore((s) => s.customCols);
  const customRows = useGameStore((s) => s.customRows);
  const setCustomDims = useGameStore((s) => s.setCustomDims);

  const debugMode = useGameStore((s) => s.debugMode);

  // --- Menu state ---
  const mode = useGameStore((s) => s.mode);
  const sandEnabled = useGameStore((s) => s.sandEnabled);
  const showMainMenu = useGameStore((s) => s.showMainMenu);
  const showPauseMenu = useGameStore((s) => s.showPauseMenu);
  const hasSave = useGameStore((s) => s.hasSave);
  const toggleSandEnabled = useGameStore((s) => s.toggleSandEnabled);
  const setShowPauseMenu = useGameStore((s) => s.setShowPauseMenu);

  // Track whether the game has ever reported a non-zero tile count.
  // This prevents the auto-advance from firing before the renderer/worker
  // have initialized and written tilesLeft to the SAB. Without this guard,
  // the store starts with tilesLeft=0, the useEffect fires immediately,
  // and if renderer.init() takes >2s the timer fires requestNewGame before
  // the worker has ever reported tiles — causing a stuck _pendingNewGame
  // flag that triggers repeated level advances on every setTilesLeft call.
  const hasSeenTiles = useRef(false);
  if (tilesLeft > 0) hasSeenTiles.current = true;

  // Refresh per-mode save availability whenever the main menu opens so the
  // "Continue" buttons only appear when a save exists.
  useEffect(() => {
    if (showMainMenu) refreshSaveAvailability();
  }, [showMainMenu]);

  // Auto-advance to next level when board is cleared.
  // Uses requestAdvance (not requestNewGame) so the score is preserved.
  // Only fire after the game has initialized (hasSeenTiles) so we don't
  // auto-advance through empty levels during startup. Skipped while any
  // menu is open (no gameplay progression while paused/in-menu).
  useEffect(() => {
    if (showMainMenu || showPauseMenu) return;
    if (tilesLeft === 0 && level > 0 && hasSeenTiles.current) {
      // Board cleared — wait a moment for sand to fall, then advance.
      const timer = setTimeout(() => {
        useGameStore.getState().requestAdvance(level + 1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [tilesLeft, level, showMainMenu, showPauseMenu]);

  // Safety net: if tilesLeft is still 0 after 6s (advance didn't take effect),
  // retry the advance. This handles edge cases where the SAB action was lost
  // or the worker was busy during the first request.
  useEffect(() => {
    if (showMainMenu || showPauseMenu) return;
    if (tilesLeft === 0 && level > 0 && hasSeenTiles.current) {
      const timer = setTimeout(() => {
        const s = useGameStore.getState();
        if (s.tilesLeft === 0) {
          console.warn("[sandjongg] auto-advance retry: tilesLeft still 0 after 6s");
          s.requestAdvance(s.level + 1);
        }
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [tilesLeft, level, showMainMenu, showPauseMenu]);

  // --- Pause menu open/close: pause/resume the sim to match. ---
  const openPauseMenu = () => {
    const r = useGameStore.getState().renderer;
    r?.getWorkerHost()?.pause();
    setPaused(true);
    setShowPauseMenu(true);
  };
  const closePauseMenu = () => {
    const r = useGameStore.getState().renderer;
    r?.getWorkerHost()?.resume();
    setPaused(false);
    setShowPauseMenu(false);
  };

  // Don't render the gameplay HUD/toolbar while the main menu is up.
  if (showMainMenu) {
    return (
      <div className="sandjongg-overlay">
        <MainMenu
          hasSave={hasSave}
          onNewGame={(m) => startNewGame(m)}
          onContinue={(m) => { void continueMode(m); }}
        />
        {toast && (
          <div className="sandjongg-toast" key={toast.id}>{toast.message}</div>
        )}
      </div>
    );
  }

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
        <ComboTimer />
        <div className="sandjongg-stat">
          <span className="label">Tiles</span>
          <span className="value">{tilesLeft}</span>
        </div>
        <div className="sandjongg-stat sandjongg-mode-badge">
          <span className="label">Mode</span>
          <span className="value">{mode === "mahjongg" ? "Mahjongg" : "Sandjongg"}</span>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className="sandjongg-toast" key={toast.id}>
          {toast.message}
        </div>
      )}

      {/* Pause button (top-right corner) */}
      <button
        className="sandjongg-pause-btn"
        onClick={openPauseMenu}
        title="Pause menu (P)"
      >
        ⏸
      </button>

      {/* Bottom toolbar — in-game actions only. Menu items (settings, help,
          restart, clear pit, no-adjacent, sand toggle, main menu) live in the
          pause menu. */}
      <div className="sandjongg-toolbar">
        <button onClick={() => requestHint()} title="Hint (H)">
          Hint
        </button>
        <button onClick={() => requestShuffle()} title="Shuffle (F)">
          Shuffle
        </button>
        <button
          onClick={() => useGameStore.getState().toggleDebugMode()}
          title="Debug mode (`) — click tiles to inspect"
          className={debugMode ? "sandjongg-btn-active" : ""}
        >
          Debug
        </button>
      </div>

      {/* FPS counter */}
      <div className="sandjongg-fps">{fps} FPS</div>

      {/* Pause menu */}
      {showPauseMenu && (
        <PauseMenu
          mode={mode}
          sandEnabled={sandEnabled}
          noAdjacentSame={noAdjacentSame}
          onResume={closePauseMenu}
          onRestart={() => { requestNewGame(level); closePauseMenu(); }}
          onClearPit={() => { requestClearSand(); closePauseMenu(); }}
          onToggleNoAdjacent={() => toggleNoAdjacentSame()}
          onToggleSand={() => toggleSandEnabled()}
          onOpenSettings={() => { closePauseMenu(); toggleSettings(); }}
          onOpenHelp={() => { closePauseMenu(); toggleHelp(); }}
          onMainMenu={() => returnToMainMenu()}
        />
      )}

      {/* Help modal */}
      {showHelp && (
        <div className="sandjongg-help" onClick={toggleHelp}>
          <div className="sandjongg-help-content" onClick={(e) => e.stopPropagation()}>
            <h2>{mode === "mahjongg" ? "Mahjongg" : "Sandjongg"}</h2>
            {mode === "mahjongg" ? (
              <p>
                Classic Mahjongg Solitaire. Match pairs of identical tiles that are
                <b> free</b> — a tile is free when nothing is stacked on top of it and at
                least one of its left/right neighbours (same layer) is empty. Tiles on
                different layers can be matched as long as both are free. Clear the
                layered pyramid to win.
              </p>
            ) : (
              <p>
                Match pairs of identical elemental tiles by connecting them with a path
                of at most 2 turns. When matched, tiles crumble into elemental sand that
                falls into the pit below — where it reacts! Fire ignites oil, water
                extinguishes lava, acid dissolves metal, and more. Watch the chaos unfold.
              </p>
            )}
            <h3>Controls</h3>
            <ul>
              <li><b>Click</b> a tile to select it, then click a matching tile to connect.</li>
              <li><b>H</b> — Show a hint (highlights a valid pair).</li>
              <li><b>F</b> — Shuffle remaining tiles.</li>
              <li><b>P</b> — Open the pause menu (resume, settings, restart, etc.).</li>
              <li><b>Pause menu → Clear Pit</b> — Remove all sand from the pit below the board.</li>
              <li><b>Pause menu → Disable Sand</b> — Skip spawning sand entirely (pure puzzle).</li>
            </ul>
            <h3>Scoring</h3>
            <p>
              Each match scores points based on the path length and current combo
              (Sandjongg) or a flat base score (Mahjongg). Quick consecutive matches
              build a combo multiplier for higher scores. Your best score is saved per
              mode and shown as "Best" in the HUD.
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
      {tilesLeft === 0 && !showPauseMenu && (
        <div className="sandjongg-level-cleared">
          <h2>Level {level} Cleared!</h2>
          <p>Advancing to level {level + 1}...</p>
        </div>
      )}

      {/* Settings panel — custom board dimensions + panning hint */}
      {showSettings && (
        <div className="sandjongg-help" onClick={toggleSettings}>
          <div className="sandjongg-help-content" onClick={(e) => e.stopPropagation()}>
            <h2>Board Settings</h2>
            <p>
              Choose a custom board size. Larger boards may not fit the screen —
              <b> right-drag</b> or <b>middle-drag</b> to pan the view.
            </p>

            <h3>Tileset</h3>
            <p className="sandjongg-hint">
              Switch the tile faces. Theme is purely visual; tileset change
              regenerates the current level (keeps your score).
            </p>
            <TilesetSelector />

            <label className="sandjongg-field">
              <input
                type="checkbox"
                checked={customCols === 0 && customRows === 0}
                onChange={(e) => {
                  if (e.target.checked) setCustomDims(0, 0);
                }}
              />
              Auto size (scales with level)
            </label>

            <div className="sandjongg-slider-row">
              <label>Columns: <b>{customCols === 0 ? "auto" : customCols}</b></label>
              <input
                type="range"
                min={8}
                max={MAX_COLS}
                step={2}
                value={customCols === 0 ? 16 : customCols}
                disabled={customCols === 0 && customRows === 0}
                onChange={(e) => setCustomDims(parseInt(e.target.value, 10), customRows === 0 ? 12 : customRows)}
              />
            </div>

            <div className="sandjongg-slider-row">
              <label>Rows: <b>{customRows === 0 ? "auto" : customRows}</b></label>
              <input
                type="range"
                min={6}
                max={MAX_ROWS}
                step={2}
                value={customRows === 0 ? 12 : customRows}
                disabled={customCols === 0 && customRows === 0}
                onChange={(e) => setCustomDims(customCols === 0 ? 16 : customCols, parseInt(e.target.value, 10))}
              />
            </div>

            <p className="sandjongg-hint">
              No-Adjacent is {noAdjacentSame ? "ON" : "OFF"} (auto-on after level 10).
              Changing the size regenerates the current level.
            </p>

            <button onClick={toggleSettings}>Close</button>
          </div>
        </div>
      )}

      {/* Debug mode panel — toggle with backtick (`) key.
          Click any tile to inspect its element, material, position, and neighbors. */}
      {debugMode && (
        <DebugPanel />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Main Menu — mode select screen shown at startup (and when returning from the
// pause menu). Each mode has its own save, so "Continue" only appears when a
// save exists for that mode.
// ----------------------------------------------------------------------------

function MainMenu({
  hasSave,
  onNewGame,
  onContinue,
}: {
  hasSave: Record<GameMode, boolean>;
  onNewGame: (mode: GameMode) => void;
  onContinue: (mode: GameMode) => void;
}) {
  return (
    <div className="sandjongg-mainmenu">
      <div className="sandjongg-mainmenu-content">
        <h1 className="sandjongg-mainmenu-title">Sandjongg</h1>
        <p className="sandjongg-mainmenu-subtitle">Pick a game mode</p>
        <TilesetSelector />
        <div className="sandjongg-mainmenu-cards">
          {MODES.map((m) => (
            <div key={m.id} className="sandjongg-mainmenu-card">
              <div className="sandjongg-mainmenu-card-header">
                <span className="sandjongg-mainmenu-card-name">{m.name}</span>
                <span className="sandjongg-mainmenu-card-tag">{m.tagline}</span>
              </div>
              <p className="sandjongg-mainmenu-card-desc">{m.description}</p>
              <div className="sandjongg-mainmenu-card-actions">
                <button
                  className="sandjongg-mainmenu-btn primary"
                  onClick={() => onNewGame(m.id)}
                >
                  New Game
                </button>
                {hasSave[m.id] && (
                  <button
                    className="sandjongg-mainmenu-btn"
                    onClick={() => onContinue(m.id)}
                  >
                    Continue
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Pause Menu — rolls up the menu options (settings, no-adjacent, help, restart,
// clear pit, disable sand, main menu). Opens via the top-right pause button or
// the P key. While open the sim is paused.
// ----------------------------------------------------------------------------

function PauseMenu({
  mode,
  sandEnabled,
  noAdjacentSame,
  onResume,
  onRestart,
  onClearPit,
  onToggleNoAdjacent,
  onToggleSand,
  onOpenSettings,
  onOpenHelp,
  onMainMenu,
}: {
  mode: GameMode;
  sandEnabled: boolean;
  noAdjacentSame: boolean;
  onResume: () => void;
  onRestart: () => void;
  onClearPit: () => void;
  onToggleNoAdjacent: () => void;
  onToggleSand: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onMainMenu: () => void;
}) {
  return (
    <div className="sandjongg-pause-overlay">
      <div className="sandjongg-pause-content">
        <h2>Paused</h2>
        <div className="sandjongg-pause-actions">
          <button className="sandjongg-pause-btn-menu primary" onClick={onResume}>
            Resume
          </button>
          <button onClick={onRestart}>Restart Level</button>
          <button onClick={onClearPit}>Clear Pit</button>
          <button onClick={onOpenSettings}>Settings</button>
          <button onClick={onOpenHelp}>Help</button>
          <button
            className={noAdjacentSame ? "sandjongg-btn-active" : ""}
            onClick={onToggleNoAdjacent}
            title="Prevent identical tiles spawning side-by-side (auto-on after level 10)"
          >
            No-Adjacent: {noAdjacentSame ? "ON" : "OFF"}
          </button>
          <button
            className={!sandEnabled ? "sandjongg-btn-active" : ""}
            onClick={onToggleSand}
            title="Skip spawning crumbled-tile sand (disables the falling-sand pit)"
          >
            Sand: {sandEnabled ? "ON" : "OFF"}
          </button>
          <button className="sandjongg-pause-mainmenu" onClick={onMainMenu}>
            Main Menu
          </button>
        </div>
        <p className="sandjongg-pause-mode">Mode: {mode === "mahjongg" ? "Mahjongg" : "Sandjongg"}</p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Debug panel — extracted so App doesn't re-render it every store tick.
// ----------------------------------------------------------------------------

function DebugPanel() {
  const debugTile = useGameStore((s) => s.debugTile);
  return (
    <div className="sandjongg-debug-panel">
      <div className="sandjongg-debug-header">
        <span>DEBUG</span>
        <button className="sandjongg-debug-close" onClick={() => useGameStore.getState().toggleDebugMode()}>×</button>
      </div>
      {debugTile ? (
        <div className="sandjongg-debug-body">
          <div className="sandjongg-debug-row">
            <span className="sandjongg-debug-swatch" style={{ background: debugTile.elementColor }} />
            <b>{debugTile.elementName}</b>
            <span className="sandjongg-debug-mono">#{debugTile.element}</span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Position</span>
            <span className="sandjongg-debug-mono">
              col={debugTile.col} row={debugTile.row} layer={debugTile.layer}
            </span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Topmost</span>
            <span>{debugTile.isTopmost ? "yes (selectable)" : "no (covered)"}</span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Glyph</span>
            <span className="sandjongg-debug-mono">{debugTile.glyph}</span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Sand material</span>
            <span className="sandjongg-debug-mono">
              {debugTile.sandMaterialName} (id={debugTile.sandMaterialId})
            </span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Screen rect</span>
            <span className="sandjongg-debug-mono">
              {Math.round(debugTile.screenX)},{Math.round(debugTile.screenY)} {Math.round(debugTile.screenW)}×{Math.round(debugTile.screenH)}
            </span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Sand rect</span>
            <span className="sandjongg-debug-mono">
              {debugTile.sandCol.toFixed(1)},{debugTile.sandRow.toFixed(1)} {debugTile.sandW.toFixed(1)}×{debugTile.sandH.toFixed(1)}
            </span>
          </div>
          <div className="sandjongg-debug-row">
            <span>Neighbors (N/S/E/W)</span>
            <span className="sandjongg-debug-mono">
              {debugTile.neighbors.n}/{debugTile.neighbors.s}/{debugTile.neighbors.e}/{debugTile.neighbors.w}
            </span>
          </div>
        </div>
      ) : (
        <div className="sandjongg-debug-empty">Click a tile to inspect it.</div>
      )}
    </div>
  );
}
