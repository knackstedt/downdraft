// ============================================================================
// sandjongg game UI — imui scene mounted via createGameUi.
//
// Replaces the PixiJS-in-worker scene (src/pixi-scene.ts + bridge protocol).
// All state lives in the zustand store on the main thread — widgets read it
// in onUpdate and actions call store setters / save-load helpers directly.
// ============================================================================

import {
    createGameUi,
    getEffectiveFontScale,
    loadUserFontScale,
    saveUserFontScale,
    setUIFontScale,
    uiButton,
    uiButtonActive,
    uiCheckbox,
    uiPanel,
    UIPanel,
    UIProgressBar,
    uiSegmented,
    uiSetEnabled,
    uiSliderRow,
    uiText,
    UIText,
    type GameUiContext,
    type RendererModule,
    type UIColor
} from "@downdraft/core";
import { continueMode, returnToMainMenu, startNewGame } from "../save-load";
import { TILESET_IDS, type TilesetId, type TileTheme } from "../shared/tilesets";
import type { GameMode } from "../shared/types";
import { useGameStore } from "../stores/game-store";

const COMBO_WINDOW_MS = 5000;
const MAX_COLS = 30;
const MAX_ROWS = 20;

const COL_GOLD: UIColor = [0.99, 0.80, 0.43, 1];
const COL_PANEL: UIColor = [0.10, 0.10, 0.18, 0.95];
const COL_ACCENT: UIColor = [0.42, 0.36, 0.91, 1];
const FONT_SANS = "sans-serif";
const FONT = "monospace";

const FONT_SIZE = 14;
const FONT_SIZE_SM = 12;
const FONT_SIZE_MD = 16;
const FONT_SIZE_LG = 20;
const FONT_SIZE_XL = 30;

const MODE_NAMES: Record<GameMode, string> = { sandjongg: "Sandjongg", mahjongg: "Mahjongg" };
const MODE_TAGLINES: Record<GameMode, string> = { sandjongg: "Connect + Sand", mahjongg: "Classic Layered" };
const MODE_DESCRIPTIONS: Record<GameMode, string> = {
  sandjongg:
    "Shisen-Sho connect: match identical tiles by linking them with a path of at most 2 turns. " +
    "Crumbling tiles fall into a reactive sand pit — fire ignites oil, water quenches lava, acid dissolves metal.",
  mahjongg:
    "Classic Mahjongg Solitaire: match pairs of free tiles (nothing stacked on top, at least one side open). " +
    "Layered pyramid boards. Cross-layer matches allowed. Sand pit optional — disable it for a pure puzzle.",
};

const TILESET_LABELS: Record<TilesetId, string> = { elements: "Elements", riichi: "Riichi" };
const TILETHEME_LABELS: Record<TileTheme, string> = { light: "Light", dark: "Dark" };

function cssColorToUIColor(css: string): UIColor {
  if (css.startsWith("#")) {
    const hex = parseInt(css.slice(1), 16);
    return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, 1];
  }
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [parseInt(m[1]) / 255, parseInt(m[2]) / 255, parseInt(m[3]) / 255, 1];
  return [1, 1, 1, 1];
}

function sjText(text: string, x: number, y: number, opts: Parameters<typeof uiText>[3] = {}): UIText {
  return uiText(text, x, y, { family: FONT_SANS, ...opts });
}

/** Full-screen modal backdrop + centered content panel. */
function modalBackdrop(contentW: number, contentH: number, alpha: number): { modal: UIPanel; panel: UIPanel } {
  const modal = new UIPanel(0, 0);
  modal.visible = false;
  modal.style.backgroundColor = [0.067, 0.067, 0.067, alpha];
  modal.style.borderWidth = 0;
  // The backdrop blocks canvas input while open (modal behavior).
  const panel = uiPanel(contentW, contentH);
  panel.style.backgroundColor = [...COL_PANEL] as UIColor;
  panel.style.borderRadius = 8;
  modal.addChild(panel);
  return { modal, panel };
}

export function createSandjonggUi(): RendererModule {
  return createGameUi({
    name: "sandjongg-ui",
    build(ui) {
      buildScene(ui);
      setUIFontScale(ui.root, getEffectiveFontScale(loadUserFontScale()));
    },
  });
}

function buildScene(ui: GameUiContext): void {
  const root = ui.root;
  const s = () => useGameStore.getState();

  const openPauseMenu = () => {
    s().renderer?.getWorkerHost()?.pause();
    s().setPaused(true);
    s().setShowPauseMenu(true);
  };
  const closePauseMenu = () => {
    s().renderer?.getWorkerHost()?.resume();
    s().setPaused(false);
    s().setShowPauseMenu(false);
  };

  // ══════════════════════════════════════════════════════════════════════
  // HUD (top bar)
  // ══════════════════════════════════════════════════════════════════════
  const hud = new UIPanel(0, 36);
  hud.name = "hud";
  hud.pointerThrough = true;
  hud.style.backgroundColor = [0.067, 0.067, 0.067, 0.7];
  hud.style.borderWidth = 0;

  const hudLabels = ["Level", "Score", "Best", "Combo", "Tiles", "Mode"];
  const hudVals: UIText[] = [];
  for (let i = 0; i < hudLabels.length; i++) {
    const x = 12 + i * 110;
    hud.addChild(sjText(hudLabels[i], x, 4, { dim: true, size: FONT_SIZE_SM }));
    const v = sjText("0", x, 16, { size: FONT_SIZE_MD, bold: true });
    hud.addChild(v);
    hudVals.push(v);
  }

  const comboBar = new UIProgressBar(80, 3);
  comboBar.x = 110 * 3 + 12;
  comboBar.y = 32;
  comboBar.barColor = [...COL_GOLD] as UIColor;
  comboBar.trackColor = [0.2, 0.2, 0.33, 0.8];
  hud.addChild(comboBar);
  root.addChild(hud);

  // ══════════════════════════════════════════════════════════════════════
  // Pause button (top-right)
  // ══════════════════════════════════════════════════════════════════════
  const pauseBtn = uiButton("❚❚", 36, 32, openPauseMenu);
  pauseBtn.name = "pause-button";
  root.addChild(pauseBtn);

  // ══════════════════════════════════════════════════════════════════════
  // Bottom toolbar (Hint, Shuffle, Debug)
  // ══════════════════════════════════════════════════════════════════════
  const toolbar = uiPanel(234, 28, { transparent: true });
  toolbar.name = "toolbar";
  const hintBtn = uiButton("Hint", 70, 28, () => s().requestHint());
  const shuffleBtn = uiButton("Shuffle", 80, 28, () => s().requestShuffle());
  shuffleBtn.x = 76;
  const debugBtn = uiButton("Debug", 70, 28, () => s().toggleDebugMode(), { accent: true });
  debugBtn.x = 162;
  toolbar.addChild(hintBtn);
  toolbar.addChild(shuffleBtn);
  toolbar.addChild(debugBtn);
  root.addChild(toolbar);

  // ══════════════════════════════════════════════════════════════════════
  // FPS (bottom-right)
  // ══════════════════════════════════════════════════════════════════════
  const fpsText = sjText("0 FPS", 0, 0, { dim: true, size: FONT_SIZE_SM });
  fpsText.name = "fps-text";
  root.addChild(fpsText);

  // ══════════════════════════════════════════════════════════════════════
  // Toast (top-center, below HUD)
  // ══════════════════════════════════════════════════════════════════════
  const toast = uiPanel(300, 34);
  toast.name = "toast";
  toast.visible = false;
  toast.style.backgroundColor = [...COL_PANEL] as UIColor;
  toast.style.borderColor = [...COL_ACCENT] as UIColor;
  const toastText = sjText("", 16, 8, { size: FONT_SIZE_MD });
  toast.addChild(toastText);
  root.addChild(toast);

  // ══════════════════════════════════════════════════════════════════════
  // Level cleared overlay
  // ══════════════════════════════════════════════════════════════════════
  const levelCleared = uiPanel(400, 100);
  levelCleared.name = "level-cleared";
  levelCleared.visible = false;
  levelCleared.style.backgroundColor = [0.067, 0.067, 0.067, 0.9];
  levelCleared.style.borderRadius = 8;
  const lcTitle = sjText("Level Cleared!", 0, 30, { color: COL_GOLD, size: FONT_SIZE_LG, bold: true });
  lcTitle.style.textAlign = "center";
  lcTitle.width = 400;
  const lcSub = sjText("Advancing...", 0, 60, { size: FONT_SIZE_MD });
  lcSub.style.textAlign = "center";
  lcSub.width = 400;
  levelCleared.addChild(lcTitle);
  levelCleared.addChild(lcSub);
  root.addChild(levelCleared);

  // ══════════════════════════════════════════════════════════════════════
  // Main menu
  // ══════════════════════════════════════════════════════════════════════
  const { modal: mainMenu, panel: mmPanel } = modalBackdrop(880, 500, 0.95);
  mainMenu.name = "main-menu";

  const mmTitle = sjText("Sandjongg", 0, 14, { color: COL_GOLD, size: FONT_SIZE_XL, bold: true });
  mmTitle.style.textAlign = "center";
  mmTitle.width = 880;
  mmPanel.addChild(mmTitle);
  const mmSubtitle = sjText("Pick a game mode", 0, 52, { dim: true, size: FONT_SIZE_MD });
  mmSubtitle.style.textAlign = "center";
  mmSubtitle.width = 880;
  mmPanel.addChild(mmSubtitle);

  const mmTilesetSeg = uiSegmented("Tileset", TILESET_IDS, TILESET_LABELS, s().tileset,
    (v) => s().setTileset(v as TilesetId));
  mmTilesetSeg.el.x = 180;
  mmTilesetSeg.el.y = 84;
  mmPanel.addChild(mmTilesetSeg.el);
  const mmThemeSeg = uiSegmented("Theme", ["light", "dark"], TILETHEME_LABELS, s().tileTheme,
    (v) => s().setTileTheme(v as TileTheme));
  mmThemeSeg.el.x = 400;
  mmThemeSeg.el.y = 84;
  mmPanel.addChild(mmThemeSeg.el);

  const modeCards: { continueBtn: ReturnType<typeof uiButton>; mode: GameMode }[] = [];
  const modes: GameMode[] = ["sandjongg", "mahjongg"];
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    const card = uiPanel(400, 340);
    card.x = 20 + i * 440;
    card.y = 140;
    card.style.borderRadius = 8;

    card.addChild(sjText(MODE_NAMES[m], 20, 16, { size: FONT_SIZE_LG, bold: true }));
    card.addChild(sjText(MODE_TAGLINES[m], 20, 42, { color: COL_ACCENT, size: FONT_SIZE_SM }));
    const desc = sjText(MODE_DESCRIPTIONS[m], 20, 70, { dim: true, size: FONT_SIZE_SM });
    desc.width = 360;
    card.addChild(desc);

    const newGameBtn = uiButton("New Game", 120, 32, () => startNewGame(m));
    newGameBtn.x = 20; newGameBtn.y = 280;
    newGameBtn.style.backgroundColor = [...COL_ACCENT] as UIColor;
    card.addChild(newGameBtn);

    const continueBtn = uiButton("Continue", 100, 32, () => { void continueMode(m); });
    continueBtn.x = 150; continueBtn.y = 280;
    continueBtn.visible = false;
    card.addChild(continueBtn);

    modeCards.push({ continueBtn, mode: m });
    mmPanel.addChild(card);
  }
  root.addChild(mainMenu);

  // ══════════════════════════════════════════════════════════════════════
  // Pause menu
  // ══════════════════════════════════════════════════════════════════════
  const { modal: pauseMenu, panel: pmPanel } = modalBackdrop(300, 440, 0.8);
  pauseMenu.name = "pause-menu";

  const pmTitle = sjText("Paused", 0, 20, { size: FONT_SIZE_LG, bold: true });
  pmTitle.style.textAlign = "center";
  pmTitle.width = 300;
  pmPanel.addChild(pmTitle);

  let pmY = 60;
  const addPmBtn = (label: string, onClick: () => void, opts: Parameters<typeof uiButton>[4] = {}) => {
    const b = uiButton(label, 260, 34, onClick, opts);
    b.x = 20; b.y = pmY; pmY += 40;
    pmPanel.addChild(b);
    return b;
  };
  addPmBtn("Resume", closePauseMenu);
  addPmBtn("Restart Level", () => {
    s().requestNewGame(s().level);
    s().setShowPauseMenu(false);
    s().renderer?.getWorkerHost()?.resume();
    s().setPaused(false);
  });
  addPmBtn("Clear Pit", () => {
    s().requestClearSand();
    s().setShowPauseMenu(false);
    s().renderer?.getWorkerHost()?.resume();
    s().setPaused(false);
  });
  addPmBtn("Settings", () => { s().setShowPauseMenu(false); s().toggleSettings(); });
  addPmBtn("Help", () => { s().setShowPauseMenu(false); s().toggleHelp(); });
  const pmNoAdjacent = addPmBtn("No-Adjacent: OFF", () => s().toggleNoAdjacentSame(), { accent: true });
  const pmSand = addPmBtn("Sand: ON", () => s().toggleSandEnabled(), { accent: true });
  addPmBtn("Main Menu", () => returnToMainMenu(), { danger: true });

  const pmModeLabel = sjText("Mode: Sandjongg", 0, pmY + 8, { dim: true, size: FONT_SIZE_SM });
  pmModeLabel.style.textAlign = "center";
  pmModeLabel.width = 300;
  pmPanel.addChild(pmModeLabel);
  root.addChild(pauseMenu);

  // ══════════════════════════════════════════════════════════════════════
  // Help modal
  // ══════════════════════════════════════════════════════════════════════
  const { modal: helpModal, panel: helpPanel } = modalBackdrop(600, 560, 0.8);
  helpModal.name = "help-modal";
  const helpTitle = sjText("Sandjongg", 20, 16, { color: COL_GOLD, size: FONT_SIZE_LG, bold: true });
  helpPanel.addChild(helpTitle);
  const helpBody = sjText("", 20, 50, { size: FONT_SIZE_SM });
  helpBody.width = 560;
  helpPanel.addChild(helpBody);
  const helpClose = uiButton("Close", 100, 32, () => useGameStore.setState({ showHelp: false }));
  helpClose.x = 250; helpClose.y = 510;
  helpPanel.addChild(helpClose);
  root.addChild(helpModal);

  // ══════════════════════════════════════════════════════════════════════
  // Settings modal
  // ══════════════════════════════════════════════════════════════════════
  const { modal: settingsModal, panel: setPanel } = modalBackdrop(600, 480, 0.8);
  settingsModal.name = "settings-modal";
  setPanel.addChild(sjText("Board Settings", 20, 16, { color: COL_GOLD, size: FONT_SIZE_LG, bold: true }));
  const setDesc = sjText(
    "Choose a custom board size. Larger boards may not fit the screen — right-drag or middle-drag to pan the view.",
    20, 48, { dim: true, size: FONT_SIZE_SM });
  setDesc.width = 560;
  setPanel.addChild(setDesc);

  setPanel.addChild(sjText("Tileset", 20, 90, { size: FONT_SIZE_SM, bold: true }));
  const setTilesetSeg = uiSegmented("", TILESET_IDS, TILESET_LABELS, s().tileset,
    (v) => s().setTileset(v as TilesetId));
  setTilesetSeg.el.x = 20; setTilesetSeg.el.y = 108;
  setPanel.addChild(setTilesetSeg.el);

  const setThemeSeg = uiSegmented("Theme", ["light", "dark"], TILETHEME_LABELS, s().tileTheme,
    (v) => s().setTileTheme(v as TileTheme));
  setThemeSeg.el.x = 220; setThemeSeg.el.y = 108;
  setPanel.addChild(setThemeSeg.el);

  const autoSizeCb = uiCheckbox("Auto size (scales with level)", true, (v) => {
    if (v) s().setCustomDims(0, 0);
  });
  autoSizeCb.el.x = 20; autoSizeCb.el.y = 160;
  setPanel.addChild(autoSizeCb.el);

  const colsSlider = uiSliderRow("Columns", 8, MAX_COLS, 16, 400, (v) => {
    const st = s();
    st.setCustomDims(Math.round(v), st.customRows === 0 ? 12 : st.customRows);
  });
  colsSlider.row.x = 20; colsSlider.row.y = 200;
  setPanel.addChild(colsSlider.row);

  const rowsSlider = uiSliderRow("Rows", 6, MAX_ROWS, 12, 400, (v) => {
    const st = s();
    st.setCustomDims(st.customCols === 0 ? 16 : st.customCols, Math.round(v));
  });
  rowsSlider.row.x = 20; rowsSlider.row.y = 250;
  setPanel.addChild(rowsSlider.row);

  const setHint = sjText("", 20, 300, { dim: true, size: FONT_SIZE_SM });
  setHint.width = 560;
  setPanel.addChild(setHint);

  setPanel.addChild(sjText("UI Font Scale", 20, 340, { size: FONT_SIZE_SM, bold: true }));
  const fontScaleSlider = uiSliderRow("Scale", 1, 2.5, loadUserFontScale() ?? 1, 400, (v) => {
    saveUserFontScale(v);
    setUIFontScale(ui.root, getEffectiveFontScale(v));
    ui.invalidate();
  });
  fontScaleSlider.row.x = 20; fontScaleSlider.row.y = 370;
  setPanel.addChild(fontScaleSlider.row);

  const setClose = uiButton("Close", 100, 32, () => useGameStore.setState({ showSettings: false }));
  setClose.x = 250; setClose.y = 420;
  setPanel.addChild(setClose);
  root.addChild(settingsModal);

  // ══════════════════════════════════════════════════════════════════════
  // Debug panel (top-right)
  // ══════════════════════════════════════════════════════════════════════
  const debugPanel = uiPanel(280, 260);
  debugPanel.name = "debug-panel";
  debugPanel.visible = false;
  debugPanel.style.borderRadius = 6;
  debugPanel.addChild(sjText("DEBUG", 8, 6, { color: COL_GOLD, size: FONT_SIZE_SM, bold: true }));
  const dbgClose = uiButton("×", 20, 20, () => s().toggleDebugMode(), { danger: true, fontSize: FONT_SIZE_MD });
  dbgClose.x = 248; dbgClose.y = 2;
  debugPanel.addChild(dbgClose);

  const dbgEmpty = sjText("Click a tile to inspect it.", 12, 30, { dim: true, size: FONT_SIZE_SM });
  debugPanel.addChild(dbgEmpty);

  const dbgSwatch = uiPanel(18, 18);
  dbgSwatch.x = 12; dbgSwatch.y = 30;
  debugPanel.addChild(dbgSwatch);
  const dbgElementName = sjText("", 36, 30, { size: FONT_SIZE_SM, bold: true });
  debugPanel.addChild(dbgElementName);
  const dbgElementId = sjText("", 152, 30, { dim: true, size: FONT_SIZE_SM });
  debugPanel.addChild(dbgElementId);

  const dbgLabels = ["Position", "Topmost", "Glyph", "Sand material", "Screen rect", "Sand rect", "Neighbors (N/S/E/W)"];
  const dbgVals: UIText[] = [];
  for (let i = 0; i < dbgLabels.length; i++) {
    const y = 54 + i * 22;
    debugPanel.addChild(sjText(dbgLabels[i], 12, y, { dim: true, size: FONT_SIZE_SM }));
    const v = sjText("—", 122, y, { size: FONT_SIZE_SM, family: FONT });
    debugPanel.addChild(v);
    dbgVals.push(v);
  }
  const dbgBodyEls = [dbgSwatch, dbgElementName, dbgElementId, ...dbgVals];
  root.addChild(debugPanel);

  // ══════════════════════════════════════════════════════════════════
  // Escape key: close topmost overlay, or open pause menu.
  // ══════════════════════════════════════════════════════════════════
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const st = s();
    if (st.showPauseMenu) closePauseMenu();
    else if (st.showHelp) useGameStore.setState({ showHelp: false });
    else if (st.showSettings) useGameStore.setState({ showSettings: false });
    else if (!st.showMainMenu) openPauseMenu();
  };
  window.addEventListener("keydown", onKeyDown);
  ui.onDispose(() => window.removeEventListener("keydown", onKeyDown));

  // ══════════════════════════════════════════════════════════════════
  // Help text (mode-dependent)
  // ══════════════════════════════════════════════════════════════════
  function updateHelpText(): void {
    const isMahjongg = s().mode === "mahjongg";
    helpTitle.setText(isMahjongg ? "Mahjongg" : "Sandjongg");
    helpBody.setText(isMahjongg
      ? "Classic Mahjongg Solitaire. Match pairs of identical tiles that are free — a tile is free when nothing is stacked on top of it and at least one of its left/right neighbours (same layer) is empty. Tiles on different layers can be matched as long as both are free. Clear the layered pyramid to win.\n\nControls\n• Click a tile to select it, then click a matching tile to connect.\n• H — Show a hint (highlights a valid pair).\n• F — Shuffle remaining tiles.\n• P — Open the pause menu (resume, settings, restart, etc.).\n• Pause menu → Clear Pit — Remove all sand from the pit below the board.\n• Pause menu → Disable Sand — Skip spawning sand entirely (pure puzzle).\n\nScoring\nEach match scores points based on the path length and current combo (Sandjongg) or a flat base score (Mahjongg). Quick consecutive matches build a combo multiplier for higher scores. Your best score is saved per mode and shown as \"Best\" in the HUD.\n\nDead Ends\nIf no valid moves remain but tiles are left, the board auto-shuffles so you can keep playing. You can also shuffle manually at any time with F."
      : "Match pairs of identical elemental tiles by connecting them with a path of at most 2 turns. When matched, tiles crumble into elemental sand that falls into the pit below — where it reacts! Fire ignites oil, water extinguishes lava, acid dissolves metal, and more. Watch the chaos unfold.\n\nControls\n• Click a tile to select it, then click a matching tile to connect.\n• H — Show a hint (highlights a valid pair).\n• F — Shuffle remaining tiles.\n• P — Open the pause menu (resume, settings, restart, etc.).\n• Pause menu → Clear Pit — Remove all sand from the pit below the board.\n• Pause menu → Disable Sand — Skip spawning sand entirely (pure puzzle).\n\nScoring\nEach match scores points based on the path length and current combo (Sandjongg) or a flat base score (Mahjongg). Quick consecutive matches build a combo multiplier for higher scores. Your best score is saved per mode and shown as \"Best\" in the HUD.\n\nDead Ends\nIf no valid moves remain but tiles are left, the board auto-shuffles so you can keep playing. You can also shuffle manually at any time with F.");
  }

  // ══════════════════════════════════════════════════════════════════
  // Layout
  // ══════════════════════════════════════════════════════════════════
  function layout(): void {
    const w = root.width;
    const h = root.height;
    hud.width = w;
    pauseBtn.x = w - 44; pauseBtn.y = 2;
    toolbar.x = Math.round((w - 234) / 2);
    toolbar.y = h - 40;
    fpsText.x = w - 70; fpsText.y = h - 18;
    toast.x = Math.round((w - 300) / 2);
    toast.y = 44;
    levelCleared.x = Math.round((w - 400) / 2);
    levelCleared.y = Math.round((h - 100) / 2);
    for (const m of [mainMenu, pauseMenu, helpModal, settingsModal]) {
      m.width = w;
      m.height = h;
      const panel = m.children[0];
      panel.x = Math.round((w - panel.width) / 2);
      panel.y = Math.round((h - panel.height) / 2);
    }
    debugPanel.x = w - 290;
    debugPanel.y = 40;
  }
  layout();
  ui.onResize(() => { layout(); ui.invalidate(); });

  // ══════════════════════════════════════════════════════════════════
  // Per-frame sync
  // ══════════════════════════════════════════════════════════════════
  ui.onUpdate(() => {
    const st = s();

    hudVals[0].setText(String(st.level));
    hudVals[1].setText(st.score.toLocaleString());
    hudVals[2].setText(st.highScore.toLocaleString());
    hudVals[3].setText(`x${st.combo}`);
    hudVals[4].setText(String(st.tilesLeft));
    hudVals[5].setText(MODE_NAMES[st.mode]);

    if (st.combo > 0 && st.lastMatchTime > 0) {
      const remaining = Math.max(0, Math.min(1, (COMBO_WINDOW_MS - (performance.now() - st.lastMatchTime)) / COMBO_WINDOW_MS));
      comboBar.visible = remaining > 0;
      comboBar.setValue(remaining);
    } else {
      comboBar.visible = false;
    }

    fpsText.setText(`${Math.floor(st.fps ?? 0)} FPS`);
    pauseBtn.visible = !st.showMainMenu;

    const anyModal = st.showMainMenu || st.showPauseMenu || st.showHelp || st.showSettings;
    hud.visible = !anyModal;
    toolbar.visible = !anyModal;
    uiButtonActive(debugBtn, st.debugMode, true);

    if (st.toast) {
      toast.visible = true;
      toastText.setText(st.toast.message);
      toast.width = st.toast.message.length * (FONT_SIZE_MD * 0.62) + 32;
      toast.x = Math.round((root.width - toast.width) / 2);
    } else {
      toast.visible = false;
    }

    const showLevelCleared = st.tilesLeft === 0 && !st.showPauseMenu && !st.showMainMenu && st.level > 0;
    levelCleared.visible = showLevelCleared;
    if (showLevelCleared) {
      lcTitle.setText(`Level ${st.level} Cleared!`);
      lcSub.setText(`Advancing to level ${st.level + 1}...`);
    }

    mainMenu.visible = st.showMainMenu;
    if (st.showMainMenu) {
      for (const c of modeCards) c.continueBtn.visible = st.hasSave[c.mode];
      mmTilesetSeg.setValue(st.tileset);
      mmThemeSeg.setValue(st.tileTheme);
    }

    pauseMenu.visible = st.showPauseMenu;
    if (st.showPauseMenu) {
      pmNoAdjacent.label = `No-Adjacent: ${st.noAdjacentSame ? "ON" : "OFF"}`;
      uiButtonActive(pmNoAdjacent, st.noAdjacentSame, true);
      pmSand.label = `Sand: ${st.sandEnabled ? "ON" : "OFF"}`;
      uiButtonActive(pmSand, !st.sandEnabled, true);
      pmModeLabel.setText(`Mode: ${MODE_NAMES[st.mode]}`);
    }

    helpModal.visible = st.showHelp;
    if (st.showHelp) updateHelpText();

    settingsModal.visible = st.showSettings;
    if (st.showSettings) {
      const isAuto = st.customCols === 0 && st.customRows === 0;
      autoSizeCb.setChecked(isAuto);
      uiSetEnabled(colsSlider.row, !isAuto);
      uiSetEnabled(rowsSlider.row, !isAuto);
      colsSlider.slider.setValue(st.customCols === 0 ? 16 : st.customCols);
      rowsSlider.slider.setValue(st.customRows === 0 ? 12 : st.customRows);
      setHint.setText(`No-Adjacent is ${st.noAdjacentSame ? "ON" : "OFF"} (auto-on after level 10). Changing the size regenerates the current level.`);
      setTilesetSeg.setValue(st.tileset);
      setThemeSeg.setValue(st.tileTheme);
    }

    // Debug panel
    debugPanel.visible = st.debugMode;
    if (st.debugMode) {
      const t = st.debugTile;
      dbgEmpty.visible = !t;
      for (const el of dbgBodyEls) el.visible = !!t;
      if (t) {
        dbgSwatch.style.backgroundColor = cssColorToUIColor(t.elementColor);
        dbgElementName.setText(t.elementName);
        dbgElementId.setText(`#${t.element}`);
        dbgVals[0].setText(`col=${t.col} row=${t.row} layer=${t.layer}`);
        dbgVals[1].setText(t.isTopmost ? "yes (selectable)" : "no (covered)");
        dbgVals[2].setText(t.glyph);
        dbgVals[3].setText(`${t.sandMaterialName} (id=${t.sandMaterialId})`);
        dbgVals[4].setText(`${Math.round(t.screenX)},${Math.round(t.screenY)} ${Math.round(t.screenW)}×${Math.round(t.screenH)}`);
        dbgVals[5].setText(`${t.sandCol.toFixed(1)},${t.sandRow.toFixed(1)} ${t.sandW.toFixed(1)}×${t.sandH.toFixed(1)}`);
        dbgVals[6].setText(`${t.neighbors.n}/${t.neighbors.s}/${t.neighbors.e}/${t.neighbors.w}`);
      }
    }
  });
}
