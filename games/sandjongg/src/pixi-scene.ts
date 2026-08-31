// ============================================================================
// sandjongg pixi-scene — the PixiJS UI scene for the sandjongg game.
//
// Replaces the React app.tsx overlay. Runs inside the pixi-ui Web Worker on
// an OffscreenCanvas. Reads per-frame scalars from the UiStatsSAB + events
// via postMessage; sends actions back to the main thread via postAction.
//
// Uses non-pass-through mode: sandjongg's UI is modal (menus capture all
// input). When menus are open, setInteractive(true) captures pointer events;
// when only the HUD is visible, setInteractive(false) lets the tile canvas
// receive clicks for tile selection/matching.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, Rect } from "@downdraft/library-pixi-ui";
import { Container, Graphics, Text } from "pixi.js";
import type { SandjonggAction } from "./pixi/bridge-protocol";
import { TILESET_IDS, type TilesetId, type TileTheme } from "./shared/tilesets";
import type { DebugTileInfo, GameMode } from "./shared/types";

// ── Colors ──
const COL_BG = 0x111111;
const COL_BG_ALPHA = 0.85;
const COL_PANEL = 0x1a1a2e;
const COL_TEXT = 0xffffff;
const COL_TEXT_DIM = 0x999999;
const COL_ACCENT = 0x6c5ce7;
const COL_GOLD = 0xfdcb6e;

// ── Style presets ──
const FONT = "monospace";
const FONT_SANS = "sans-serif";
const FONT_SIZE = 12;
const FONT_SIZE_SM = 10;
const FONT_SIZE_MD = 14;
const FONT_SIZE_LG = 18;
const FONT_SIZE_XL = 28;

// ── Constants matching app.tsx ──
const COMBO_WINDOW_MS = 5000;
const MAX_COLS = 30;
const MAX_ROWS = 20;

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

// ── UI helpers (shared with falling-sand pattern) ──

interface Button extends Container {
  _bg: Graphics;
  _label: Text;
  _active: boolean;
  _accent: boolean;
  _danger: boolean;
  _primary: boolean;
  _onClick: () => void;
}

function createButton(
  text: string,
  w: number,
  h: number,
  onClick: () => void,
  opts: { accent?: boolean; danger?: boolean; primary?: boolean; fontSize?: number; font?: string } = {},
): Button {
  const c = new Container() as Button;
  c._accent = !!opts.accent;
  c._danger = !!opts.danger;
  c._primary = !!opts.primary;
  c._active = false;
  c._onClick = onClick;

  const bg = new Graphics();
  c._bg = bg;
  c.addChild(bg);

  const label = new Text({
    text,
    style: { fill: COL_TEXT, fontSize: opts.fontSize ?? FONT_SIZE, fontFamily: opts.font ?? FONT_SANS },
  });
  label.anchor.set(0.5);
  label.x = w / 2;
  label.y = h / 2;
  c._label = label;
  c.addChild(label);

  // Store w/h for redraw (Container.width is 0 before children measured)
  (c as any)._w = w;
  (c as any)._h = h;
  drawButtonBg(c);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (e: any) => { e.stopPropagation(); onClick(); });
  c.on("pointerenter", () => { c._active = true; drawButtonBg(c); });
  c.on("pointerleave", () => { c._active = false; drawButtonBg(c); });

  return c;
}

function drawButtonBg(btn: Button): void {
  const w = (btn as any)._w ?? 80;
  const h = (btn as any)._h ?? 24;
  const bg = btn._bg;
  bg.clear();
  let fillCol = 0x222244;
  let alpha = 0.9;
  let strokeCol = 0x444466;
  if (btn._primary) { fillCol = btn._active ? 0x6c5ce7 : 0x4834b0; alpha = btn._active ? 1 : 0.9; strokeCol = 0x6c5ce7; }
  else if (btn._accent) { fillCol = btn._active ? 0x6c5ce7 : 0x2d2454; alpha = btn._active ? 0.6 : 0.4; strokeCol = 0x6c5ce7; }
  else if (btn._danger) { fillCol = btn._active ? 0xe74c3c : 0x882222; alpha = btn._active ? 0.5 : 0.3; strokeCol = 0xe74c3c; }
  else if (btn._active) { fillCol = 0x333366; alpha = 1; }
  bg.roundRect(0, 0, w, h, 4).fill({ color: fillCol, alpha }).stroke({ width: 1, color: strokeCol, alpha: 0.7 });
}

function setActive(btn: Button, active: boolean): void {
  btn._active = active;
  drawButtonBg(btn);
}

function setBtnText(btn: Button, text: string): void {
  btn._label.text = text;
  drawButtonBg(btn);
}

// ── Panel background ──

function createPanelBg(w: number, h: number, radius = 6, alpha = COL_BG_ALPHA): Graphics {
  const g = new Graphics();
  g.roundRect(0, 0, w, h, radius).fill({ color: COL_BG, alpha }).stroke({ width: 1, color: 0x333355, alpha: 0.6 });
  return g;
}

// ── Slider ──

interface Slider extends Container {
  _track: Graphics;
  _knob: Graphics;
  _label: Text;
  _valueText: Text;
  _min: number;
  _max: number;
  _step: number;
  _value: number;
  _trackW: number;
  _onChange: (v: number) => void;
  _dragging: boolean;
  _enabled: boolean;
}

function createSlider(
  labelText: string,
  min: number,
  max: number,
  step: number,
  value: number,
  trackW: number,
  onChange: (v: number) => void,
): Slider {
  const c = new Container() as Slider;
  c._min = min;
  c._max = max;
  c._step = step;
  c._value = value;
  c._trackW = trackW;
  c._onChange = onChange;
  c._dragging = false;
  c._enabled = true;

  const label = new Text({ text: labelText, style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  c._label = label;
  c.addChild(label);

  const valueText = new Text({ text: value.toString(), style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  valueText.x = trackW - 30;
  c._valueText = valueText;
  c.addChild(valueText);

  const trackY = 18;
  const track = new Graphics();
  c._track = track;
  track.y = trackY;
  c.addChild(track);

  const knob = new Graphics();
  c._knob = knob;
  knob.y = trackY + 6;
  knob.eventMode = "static";
  knob.cursor = "grab";
  c.addChild(knob);

  drawSliderTrack(c);
  updateSliderKnob(c);

  knob.on("pointerdown", (e: any) => { c._dragging = true; knob.cursor = "grabbing"; e.stopPropagation(); });
  knob.on("globalpointermove", (e: any) => {
    if (!c._dragging || !c._enabled) return;
    const local = c.toLocal(e.global);
    setSliderValueFromX(c, local.x);
  });
  knob.on("pointerup", () => { c._dragging = false; knob.cursor = "grab"; });
  knob.on("pointerupoutside", () => { c._dragging = false; knob.cursor = "grab"; });

  track.eventMode = "static";
  track.on("pointerdown", (e: any) => {
    if (!c._enabled) return;
    const local = c.toLocal(e.global);
    setSliderValueFromX(c, local.x);
    e.stopPropagation();
  });

  return c;
}

function drawSliderTrack(s: Slider): void {
  s._track.clear();
  s._track.roundRect(0, 0, s._trackW, 6, 3).fill({ color: s._enabled ? 0x333355 : 0x222222, alpha: 0.9 });
}

function updateSliderKnob(s: Slider): void {
  const ratio = (s._value - s._min) / (s._max - s._min);
  const x = Math.max(0, Math.min(1, ratio)) * s._trackW;
  s._knob.clear();
  s._knob.circle(x, 0, 7).fill({ color: s._enabled ? 0xcccccc : 0x666666, alpha: 1 }).stroke({ width: 1, color: 0x888888 });
}

function setSliderValueFromX(s: Slider, x: number): void {
  const ratio = Math.max(0, Math.min(1, x / s._trackW));
  let v = s._min + ratio * (s._max - s._min);
  if (s._step > 0) v = Math.round(v / s._step) * s._step;
  v = Math.max(s._min, Math.min(s._max, v));
  if (v !== s._value) {
    s._value = v;
    updateSliderKnob(s);
    s._valueText.text = formatSliderValue(s, v);
    s._onChange(v);
  }
}

function formatSliderValue(s: Slider, v: number): string {
  if (s._step < 1) return v.toFixed(s._step < 0.01 ? 3 : 1);
  return Math.round(v).toString();
}

function setSliderValue(s: Slider, v: number): void {
  if (v === s._value) return;
  s._value = v;
  updateSliderKnob(s);
  s._valueText.text = formatSliderValue(s, v);
}

function setSliderEnabled(s: Slider, enabled: boolean): void {
  s._enabled = enabled;
  s._knob.eventMode = enabled ? "static" : "none";
  s._track.eventMode = enabled ? "static" : "none";
  s._knob.cursor = enabled ? "grab" : "default";
  drawSliderTrack(s);
  updateSliderKnob(s);
}

// ── Checkbox ──

interface Checkbox extends Container {
  _box: Graphics;
  _label: Text;
  _checked: boolean;
  _enabled: boolean;
  _onChange: (v: boolean) => void;
}

function createCheckbox(labelText: string, checked: boolean, onChange: (v: boolean) => void): Checkbox {
  const c = new Container() as Checkbox;
  c._checked = checked;
  c._enabled = true;
  c._onChange = onChange;

  const box = new Graphics();
  c._box = box;
  c.addChild(box);

  const label = new Text({ text: labelText, style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  label.x = 24;
  label.y = 1;
  c._label = label;
  c.addChild(label);

  drawCheckbox(c);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", (e: any) => {
    e.stopPropagation();
    if (!c._enabled) return;
    c._checked = !c._checked;
    drawCheckbox(c);
    onChange(c._checked);
  });

  return c;
}

function drawCheckbox(cb: Checkbox): void {
  cb._box.clear();
  const fillCol = cb._checked ? COL_ACCENT : 0x222244;
  cb._box.roundRect(0, 0, 18, 18, 3).fill({ color: fillCol, alpha: cb._enabled ? 0.9 : 0.4 }).stroke({ width: 1, color: 0x555577, alpha: 0.7 });
  if (cb._checked) {
    cb._box.moveTo(4, 9).lineTo(8, 13).lineTo(14, 5).stroke({ width: 2, color: 0xffffff, alpha: 1 });
  }
}

function setCheckboxChecked(cb: Checkbox, checked: boolean): void {
  if (cb._checked === checked) return;
  cb._checked = checked;
  drawCheckbox(cb);
}

function setCheckboxEnabled(cb: Checkbox, enabled: boolean): void {
  cb._enabled = enabled;
  cb.eventMode = enabled ? "static" : "none";
  cb.cursor = enabled ? "pointer" : "default";
  drawCheckbox(cb);
}

// ── Segmented control ──

interface Segmented extends Container {
  _btns: Button[];
  _value: string;
  _onChange: (v: string) => void;
}

function createSegmented(
  labelText: string,
  options: readonly string[],
  labels: Record<string, string>,
  value: string,
  onChange: (v: string) => void,
): Segmented {
  const c = new Container() as Segmented;
  c._value = value;
  c._onChange = onChange;

  const label = new Text({ text: labelText, style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  c.addChild(label);

  const btnContainer = new Container();
  btnContainer.y = 16;
  c.addChild(btnContainer);

  c._btns = [];
  const btnW = 70;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const btn = createButton(labels[opt] ?? opt, btnW, 22, () => {
      c._value = opt;
      for (let j = 0; j < c._btns.length; j++) setActive(c._btns[j], j === i);
      onChange(opt);
    }, { accent: true, fontSize: FONT_SIZE_SM });
    btn.x = i * (btnW + 4);
    btnContainer.addChild(btn);
    c._btns.push(btn);
  }
  // Set initial active
  for (let i = 0; i < options.length; i++) setActive(c._btns[i], options[i] === value);

  return c;
}

// ── The scene ──

export default function createSandjonggScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = new Container();
  root.label = "hud-root";
  ctx.app.stage.addChild(root);

  // ── State (updated from SAB + events) ──
  const state = {
    fps: 0,
    score: 0,
    combo: 0,
    level: 1,
    tilesLeft: 0,
    highScore: 0,
    paused: false,
    mode: "sandjongg" as GameMode,
    sandEnabled: true,
    showMainMenu: false,
    showPauseMenu: false,
    showHelp: false,
    showSettings: false,
    debugMode: false,
    noAdjacentSame: false,
    tileset: "elements" as TilesetId,
    tileTheme: "light" as TileTheme,
    customCols: 0,
    customRows: 0,
    lastMatchTime: 0,
    canvasW: 1280,
    canvasH: 720,
    debugTile: null as DebugTileInfo | null,
    toast: null as { message: string; id: number } | null,
    hasSave: { sandjongg: false, mahjongg: false } as Record<GameMode, boolean>,
  };

  function post(action: SandjonggAction): void {
    ctx.postAction(action);
  }

  // ════════════════════════════════════════════════════════════════════════
  // HUD (top bar) — always visible during gameplay
  // ════════════════════════════════════════════════════════════════════════
  const hud = new Container();
  hud.label = "hud";
  hud.addChild(createPanelBg(1280, 36, 0, 0.7));

  const hudItems: { label: Text; value: Text }[] = [];
  const hudLabels = ["Level", "Score", "Best", "Combo", "Tiles", "Mode"];
  let hudX = 12;
  for (let i = 0; i < hudLabels.length; i++) {
    const label = new Text({ text: hudLabels[i], style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
    label.x = hudX; label.y = 4;
    hud.addChild(label);
    const value = new Text({ text: "0", style: { fill: COL_TEXT, fontSize: FONT_SIZE_MD, fontFamily: FONT_SANS, fontWeight: "bold" } });
    value.x = hudX; value.y = 16;
    hud.addChild(value);
    hudItems.push({ label, value });
    hudX += 110;
  }

  // Combo timer bar (under the combo stat)
  const comboBar = new Graphics();
  comboBar.x = 110 * 3 + 12;
  comboBar.y = 32;
  hud.addChild(comboBar);

  root.addChild(hud);

  // ════════════════════════════════════════════════════════════════════════
  // Pause button (top-right)
  // ════════════════════════════════════════════════════════════════════════
  const pauseBtn = createButton("⏸", 36, 32, () => post({ kind: "openPauseMenu" }), { fontSize: FONT_SIZE_LG });
  pauseBtn.label = "pause-button";
  root.addChild(pauseBtn);

  // ════════════════════════════════════════════════════════════════════════
  // Bottom toolbar (Hint, Shuffle, Debug)
  // ════════════════════════════════════════════════════════════════════════
  const toolbar = new Container();
  toolbar.label = "toolbar";
  root.addChild(toolbar);

  const hintBtn = createButton("Hint", 70, 28, () => post({ kind: "requestHint" }));
  hintBtn.label = "hint-button";
  toolbar.addChild(hintBtn);

  const shuffleBtn = createButton("Shuffle", 80, 28, () => post({ kind: "requestShuffle" }));
  shuffleBtn.label = "shuffle-button";
  shuffleBtn.x = 76;
  toolbar.addChild(shuffleBtn);

  const debugBtn = createButton("Debug", 70, 28, () => post({ kind: "toggleDebugMode" }), { accent: true });
  debugBtn.label = "debug-button";
  debugBtn.x = 162;
  toolbar.addChild(debugBtn);

  // ════════════════════════════════════════════════════════════════════════
  // FPS counter (bottom-right)
  // ════════════════════════════════════════════════════════════════════════
  const fpsText = new Text({ text: "0 FPS", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  fpsText.label = "fps-text";
  root.addChild(fpsText);

  // ════════════════════════════════════════════════════════════════════════
  // Toast notification
  // ════════════════════════════════════════════════════════════════════════
  const toast = new Container();
  toast.label = "toast";
  toast.visible = false;
  root.addChild(toast);

  const toastBg = new Graphics();
  toast.addChild(toastBg);
  const toastText = new Text({ text: "", style: { fill: COL_TEXT, fontSize: FONT_SIZE_MD, fontFamily: FONT_SANS } });
  toastText.x = 16; toastText.y = 8;
  toast.addChild(toastText);

  // ════════════════════════════════════════════════════════════════════════
  // Level cleared overlay
  // ════════════════════════════════════════════════════════════════════════
  const levelCleared = new Container();
  levelCleared.label = "level-cleared";
  levelCleared.visible = false;
  levelCleared.addChild(createPanelBg(400, 100, 8, 0.9));
  const levelClearedTitle = new Text({ text: "Level Cleared!", style: { fill: COL_GOLD, fontSize: FONT_SIZE_LG, fontFamily: FONT_SANS, fontWeight: "bold" } });
  levelClearedTitle.anchor.set(0.5);
  levelClearedTitle.x = 200; levelClearedTitle.y = 30;
  levelCleared.addChild(levelClearedTitle);
  const levelClearedSub = new Text({ text: "Advancing...", style: { fill: COL_TEXT, fontSize: FONT_SIZE_MD, fontFamily: FONT_SANS } });
  levelClearedSub.anchor.set(0.5);
  levelClearedSub.x = 200; levelClearedSub.y = 60;
  levelCleared.addChild(levelClearedSub);
  root.addChild(levelCleared);

  // ════════════════════════════════════════════════════════════════════════
  // Main Menu
  // ════════════════════════════════════════════════════════════════════════
  const mainMenu = new Container();
  mainMenu.label = "main-menu";
  mainMenu.visible = false;
  mainMenu.addChild(createPanelBg(1280, 720, 0, 0.95));

  const mmTitle = new Text({ text: "Sandjongg", style: { fill: COL_GOLD, fontSize: FONT_SIZE_XL, fontFamily: FONT_SANS, fontWeight: "bold" } });
  mmTitle.anchor.set(0.5, 0);
  mmTitle.x = 640; mmTitle.y = 40;
  mainMenu.addChild(mmTitle);

  const mmSubtitle = new Text({ text: "Pick a game mode", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_MD, fontFamily: FONT_SANS } });
  mmSubtitle.anchor.set(0.5, 0);
  mmSubtitle.x = 640; mmSubtitle.y = 78;
  mainMenu.addChild(mmSubtitle);

  // Tileset selector in main menu
  const mmTilesetSeg = createSegmented("Tileset", TILESET_IDS, TILESET_LABELS, "elements", (v) => post({ kind: "setTileset", tileset: v as TilesetId }));
  mmTilesetSeg.x = 440; mmTilesetSeg.y = 110;
  mainMenu.addChild(mmTilesetSeg);

  const mmThemeSeg = createSegmented("Theme", ["light", "dark"], TILETHEME_LABELS, "light", (v) => post({ kind: "setTileTheme", theme: v as TileTheme }));
  mmThemeSeg.x = 660; mmThemeSeg.y = 110;
  mainMenu.addChild(mmThemeSeg);

  // Mode cards
  const modeCards: { card: Container; newGameBtn: Button; continueBtn: Button | null }[] = [];
  const modes: GameMode[] = ["sandjongg", "mahjongg"];
  for (let i = 0; i < modes.length; i++) {
    const m = modes[i];
    const card = new Container();
    card.x = 200 + i * 440;
    card.y = 180;
    card.addChild(createPanelBg(400, 340, 8, 0.9));

    const nameText = new Text({ text: MODE_NAMES[m], style: { fill: COL_TEXT, fontSize: FONT_SIZE_LG, fontFamily: FONT_SANS, fontWeight: "bold" } });
    nameText.x = 20; nameText.y = 16;
    card.addChild(nameText);

    const tagText = new Text({ text: MODE_TAGLINES[m], style: { fill: COL_ACCENT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
    tagText.x = 20; tagText.y = 42;
    card.addChild(tagText);

    // Description (wrapped manually — PIXI Text doesn't auto-wrap well in worker)
    const descText = new Text({
      text: MODE_DESCRIPTIONS[m],
      style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, wordWrap: true, wordWrapWidth: 360 },
    });
    descText.x = 20; descText.y = 70;
    card.addChild(descText);

    const newGameBtn = createButton("New Game", 120, 32, () => post({ kind: "startNewGame", mode: m }), { primary: true });
    newGameBtn.x = 20; newGameBtn.y = 280;
    card.addChild(newGameBtn);

    const continueBtn = createButton("Continue", 100, 32, () => post({ kind: "continueMode", mode: m }));
    continueBtn.x = 150; continueBtn.y = 280;
    continueBtn.visible = false;
    card.addChild(continueBtn);

    modeCards.push({ card, newGameBtn, continueBtn });
    mainMenu.addChild(card);
  }

  root.addChild(mainMenu);

  // ════════════════════════════════════════════════════════════════════════
  // Pause Menu
  // ════════════════════════════════════════════════════════════════════════
  const pauseMenu = new Container();
  pauseMenu.label = "pause-menu";
  pauseMenu.visible = false;
  pauseMenu.addChild(createPanelBg(1280, 720, 0, 0.8));

  const pmPanel = new Container();
  pmPanel.x = 490; pmPanel.y = 140;
  pmPanel.addChild(createPanelBg(300, 440, 8, 0.95));
  pauseMenu.addChild(pmPanel);

  const pmTitle = new Text({ text: "Paused", style: { fill: COL_TEXT, fontSize: FONT_SIZE_LG, fontFamily: FONT_SANS, fontWeight: "bold" } });
  pmTitle.anchor.set(0.5, 0);
  pmTitle.x = 150; pmTitle.y = 20;
  pmPanel.addChild(pmTitle);

  let pmY = 60;
  const pmResume = createButton("Resume", 260, 34, () => post({ kind: "closePauseMenu" }), { primary: true });
  pmResume.x = 20; pmResume.y = pmY; pmY += 40;
  pmPanel.addChild(pmResume);

  const pmRestart = createButton("Restart Level", 260, 34, () => post({ kind: "restartLevel" }));
  pmRestart.x = 20; pmRestart.y = pmY; pmY += 40;
  pmPanel.addChild(pmRestart);

  const pmClearPit = createButton("Clear Pit", 260, 34, () => post({ kind: "clearPit" }));
  pmClearPit.x = 20; pmClearPit.y = pmY; pmY += 40;
  pmPanel.addChild(pmClearPit);

  const pmSettings = createButton("Settings", 260, 34, () => post({ kind: "openSettings" }));
  pmSettings.x = 20; pmSettings.y = pmY; pmY += 40;
  pmPanel.addChild(pmSettings);

  const pmHelp = createButton("Help", 260, 34, () => post({ kind: "openHelp" }));
  pmHelp.x = 20; pmHelp.y = pmY; pmY += 40;
  pmPanel.addChild(pmHelp);

  const pmNoAdjacent = createButton("No-Adjacent: OFF", 260, 34, () => post({ kind: "toggleNoAdjacent" }), { accent: true });
  pmNoAdjacent.x = 20; pmNoAdjacent.y = pmY; pmY += 40;
  pmPanel.addChild(pmNoAdjacent);

  const pmSand = createButton("Sand: ON", 260, 34, () => post({ kind: "toggleSand" }), { accent: true });
  pmSand.x = 20; pmSand.y = pmY; pmY += 40;
  pmPanel.addChild(pmSand);

  const pmMainMenu = createButton("Main Menu", 260, 34, () => post({ kind: "returnToMainMenu" }), { danger: true });
  pmMainMenu.x = 20; pmMainMenu.y = pmY; pmY += 40;
  pmPanel.addChild(pmMainMenu);

  const pmModeLabel = new Text({ text: "Mode: Sandjongg", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  pmModeLabel.anchor.set(0.5, 0);
  pmModeLabel.x = 150; pmModeLabel.y = pmY + 8;
  pmPanel.addChild(pmModeLabel);

  root.addChild(pauseMenu);

  // ════════════════════════════════════════════════════════════════════════
  // Help modal
  // ════════════════════════════════════════════════════════════════════════
  const helpModal = new Container();
  helpModal.label = "help-modal";
  helpModal.visible = false;
  helpModal.addChild(createPanelBg(1280, 720, 0, 0.8));

  const helpPanel = new Container();
  helpPanel.x = 340; helpPanel.y = 80;
  helpPanel.addChild(createPanelBg(600, 560, 8, 0.95));
  helpModal.addChild(helpPanel);

  const helpTitle = new Text({ text: "Sandjongg", style: { fill: COL_GOLD, fontSize: FONT_SIZE_LG, fontFamily: FONT_SANS, fontWeight: "bold" } });
  helpTitle.x = 20; helpTitle.y = 16;
  helpPanel.addChild(helpTitle);

  const helpBody = new Text({
    text: "",
    style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, wordWrap: true, wordWrapWidth: 560, lineHeight: 18 },
  });
  helpBody.x = 20; helpBody.y = 50;
  helpPanel.addChild(helpBody);

  const helpClose = createButton("Close", 100, 32, () => post({ kind: "closePanel", panel: "help" }), { primary: true });
  helpClose.x = 250; helpClose.y = 510;
  helpPanel.addChild(helpClose);

  root.addChild(helpModal);

  // ════════════════════════════════════════════════════════════════════════
  // Settings modal
  // ════════════════════════════════════════════════════════════════════════
  const settingsModal = new Container();
  settingsModal.label = "settings-modal";
  settingsModal.visible = false;
  settingsModal.addChild(createPanelBg(1280, 720, 0, 0.8));

  const setPanel = new Container();
  setPanel.x = 340; setPanel.y = 80;
  setPanel.addChild(createPanelBg(600, 480, 8, 0.95));
  settingsModal.addChild(setPanel);

  const setTitle = new Text({ text: "Board Settings", style: { fill: COL_GOLD, fontSize: FONT_SIZE_LG, fontFamily: FONT_SANS, fontWeight: "bold" } });
  setTitle.x = 20; setTitle.y = 16;
  setPanel.addChild(setTitle);

  const setDesc = new Text({
    text: "Choose a custom board size. Larger boards may not fit the screen — right-drag or middle-drag to pan the view.",
    style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, wordWrap: true, wordWrapWidth: 560 },
  });
  setDesc.x = 20; setDesc.y = 48;
  setPanel.addChild(setDesc);

  // Tileset selector
  const setTilesetLabel = new Text({ text: "Tileset", style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, fontWeight: "bold" } });
  setTilesetLabel.x = 20; setTilesetLabel.y = 90;
  setPanel.addChild(setTilesetLabel);

  const setTilesetSeg = createSegmented("", TILESET_IDS, TILESET_LABELS, "elements", (v) => post({ kind: "setTileset", tileset: v as TilesetId }));
  setTilesetSeg.x = 20; setTilesetSeg.y = 108;
  setPanel.addChild(setTilesetSeg);

  const setThemeSeg = createSegmented("Theme", ["light", "dark"], TILETHEME_LABELS, "light", (v) => post({ kind: "setTileTheme", theme: v as TileTheme }));
  setThemeSeg.x = 220; setThemeSeg.y = 108;
  setPanel.addChild(setThemeSeg);

  // Auto size checkbox
  const autoSizeCb = createCheckbox("Auto size (scales with level)", true, (v) => {
    if (v) post({ kind: "setCustomDims", cols: 0, rows: 0 });
  });
  autoSizeCb.x = 20; autoSizeCb.y = 160;
  setPanel.addChild(autoSizeCb);

  // Cols slider
  const colsSlider = createSlider("Columns", 8, MAX_COLS, 2, 16, 400, (v) => {
    post({ kind: "setCustomDims", cols: v, rows: state.customRows === 0 ? 12 : state.customRows });
  });
  colsSlider.x = 20; colsSlider.y = 200;
  setPanel.addChild(colsSlider);

  // Rows slider
  const rowsSlider = createSlider("Rows", 6, MAX_ROWS, 2, 12, 400, (v) => {
    post({ kind: "setCustomDims", cols: state.customCols === 0 ? 16 : state.customCols, rows: v });
  });
  rowsSlider.x = 20; rowsSlider.y = 250;
  setPanel.addChild(rowsSlider);

  const setHint = new Text({
    text: "",
    style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, wordWrap: true, wordWrapWidth: 560 },
  });
  setHint.x = 20; setHint.y = 300;
  setPanel.addChild(setHint);

  const setClose = createButton("Close", 100, 32, () => post({ kind: "closePanel", panel: "settings" }), { primary: true });
  setClose.x = 250; setClose.y = 420;
  setPanel.addChild(setClose);

  root.addChild(settingsModal);

  // ════════════════════════════════════════════════════════════════════════
  // Debug panel
  // ════════════════════════════════════════════════════════════════════════
  const debugPanel = new Container();
  debugPanel.label = "debug-panel";
  debugPanel.visible = false;
  debugPanel.addChild(createPanelBg(280, 260, 6, 0.95));

  const dbgHeader = new Container();
  dbgHeader.x = 8; dbgHeader.y = 6;
  debugPanel.addChild(dbgHeader);
  const dbgTitle = new Text({ text: "DEBUG", style: { fill: COL_GOLD, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, fontWeight: "bold" } });
  dbgHeader.addChild(dbgTitle);
  const dbgClose = createButton("×", 20, 20, () => post({ kind: "toggleDebugMode" }), { danger: true, fontSize: FONT_SIZE_MD });
  dbgClose.x = 248; dbgClose.y = -4;
  debugPanel.addChild(dbgClose);

  const dbgEmpty = new Text({ text: "Click a tile to inspect it.", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
  dbgEmpty.x = 12; dbgEmpty.y = 30;
  debugPanel.addChild(dbgEmpty);

  const dbgBody = new Container();
  dbgBody.x = 12; dbgBody.y = 30;
  dbgBody.visible = false;
  debugPanel.addChild(dbgBody);

  const dbgSwatch = new Graphics();
  dbgSwatch.x = 0; dbgSwatch.y = 0;
  dbgBody.addChild(dbgSwatch);

  const dbgElementName = new Text({ text: "", style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS, fontWeight: "bold" } });
  dbgElementName.x = 24; dbgElementName.y = 0;
  dbgBody.addChild(dbgElementName);

  const dbgElementId = new Text({ text: "", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
  dbgElementId.x = 140; dbgElementId.y = 0;
  dbgBody.addChild(dbgElementId);

  const dbgLines: { label: Text; value: Text }[] = [];
  const dbgLineLabels = ["Position", "Topmost", "Glyph", "Sand material", "Screen rect", "Sand rect", "Neighbors (N/S/E/W)"];
  for (let i = 0; i < dbgLineLabels.length; i++) {
    const y = 24 + i * 22;
    const label = new Text({ text: dbgLineLabels[i], style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT_SANS } });
    label.x = 0; label.y = y;
    dbgBody.addChild(label);
    const value = new Text({ text: "—", style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
    value.x = 110; value.y = y;
    dbgBody.addChild(value);
    dbgLines.push({ label, value });
  }

  root.addChild(debugPanel);

  // ── Layout ──
  function layout(width: number, height: number): void {
    state.canvasW = width;
    state.canvasH = height;

    // HUD bar spans full width
    (hud.children[0] as Graphics).clear();
    (hud.children[0] as Graphics).rect(0, 0, width, 36).fill({ color: COL_BG, alpha: 0.7 });

    // Pause button top-right
    pauseBtn.x = width - 44; pauseBtn.y = 2;

    // Toolbar bottom-center
    toolbar.x = Math.round((width - 234) / 2);
    toolbar.y = height - 40;

    // FPS bottom-right
    fpsText.x = width - 70; fpsText.y = height - 18;

    // Toast top-center (below HUD)
    toast.x = Math.round((width - 300) / 2);
    toast.y = 44;

    // Level cleared center
    levelCleared.x = Math.round((width - 400) / 2);
    levelCleared.y = Math.round((height - 100) / 2);

    // Main menu full screen
    (mainMenu.children[0] as Graphics).clear();
    (mainMenu.children[0] as Graphics).rect(0, 0, width, height).fill({ color: COL_BG, alpha: 0.95 });
    mmTitle.x = width / 2;
    mmSubtitle.x = width / 2;
    mmTilesetSeg.x = width / 2 - 220;
    mmThemeSeg.x = width / 2 + 0;
    for (let i = 0; i < modeCards.length; i++) {
      modeCards[i].card.x = Math.round(width / 2 - 420 + i * 440);
      modeCards[i].card.y = 180;
    }

    // Pause menu full screen
    (pauseMenu.children[0] as Graphics).clear();
    (pauseMenu.children[0] as Graphics).rect(0, 0, width, height).fill({ color: COL_BG, alpha: 0.8 });
    pmPanel.x = Math.round((width - 300) / 2);
    pmPanel.y = Math.round((height - 440) / 2);

    // Help modal full screen
    (helpModal.children[0] as Graphics).clear();
    (helpModal.children[0] as Graphics).rect(0, 0, width, height).fill({ color: COL_BG, alpha: 0.8 });
    helpPanel.x = Math.round((width - 600) / 2);
    helpPanel.y = Math.round((height - 560) / 2);

    // Settings modal full screen
    (settingsModal.children[0] as Graphics).clear();
    (settingsModal.children[0] as Graphics).rect(0, 0, width, height).fill({ color: COL_BG, alpha: 0.8 });
    setPanel.x = Math.round((width - 600) / 2);
    setPanel.y = Math.round((height - 480) / 2);

    // Debug panel top-right (below pause button)
    debugPanel.x = width - 290;
    debugPanel.y = 40;
  }
  layout(ctx.width, ctx.height);

  // ── Help text (mode-dependent) ──
  function updateHelpText(): void {
    const isMahjongg = state.mode === "mahjongg";
    helpTitle.text = isMahjongg ? "Mahjongg" : "Sandjongg";
    if (isMahjongg) {
      helpBody.text =
        "Classic Mahjongg Solitaire. Match pairs of identical tiles that are free — a tile is free when nothing is stacked on top of it and at least one of its left/right neighbours (same layer) is empty. Tiles on different layers can be matched as long as both are free. Clear the layered pyramid to win.\n\nControls\n• Click a tile to select it, then click a matching tile to connect.\n• H — Show a hint (highlights a valid pair).\n• F — Shuffle remaining tiles.\n• P — Open the pause menu (resume, settings, restart, etc.).\n• Pause menu → Clear Pit — Remove all sand from the pit below the board.\n• Pause menu → Disable Sand — Skip spawning sand entirely (pure puzzle).\n\nScoring\nEach match scores points based on the path length and current combo (Sandjongg) or a flat base score (Mahjongg). Quick consecutive matches build a combo multiplier for higher scores. Your best score is saved per mode and shown as \"Best\" in the HUD.\n\nDead Ends\nIf no valid moves remain but tiles are left, the board auto-shuffles so you can keep playing. You can also shuffle manually at any time with F.";
    } else {
      helpBody.text =
        "Match pairs of identical elemental tiles by connecting them with a path of at most 2 turns. When matched, tiles crumble into elemental sand that falls into the pit below — where it reacts! Fire ignites oil, water extinguishes lava, acid dissolves metal, and more. Watch the chaos unfold.\n\nControls\n• Click a tile to select it, then click a matching tile to connect.\n• H — Show a hint (highlights a valid pair).\n• F — Shuffle remaining tiles.\n• P — Open the pause menu (resume, settings, restart, etc.).\n• Pause menu → Clear Pit — Remove all sand from the pit below the board.\n• Pause menu → Disable Sand — Skip spawning sand entirely (pure puzzle).\n\nScoring\nEach match scores points based on the path length and current combo (Sandjongg) or a flat base score (Mahjongg). Quick consecutive matches build a combo multiplier for higher scores. Your best score is saved per mode and shown as \"Best\" in the HUD.\n\nDead Ends\nIf no valid moves remain but tiles are left, the board auto-shuffles so you can keep playing. You can also shuffle manually at any time with F.";
    }
  }

  // ── Update debug panel ──
  function updateDebugPanel(): void {
    debugPanel.visible = state.debugMode;
    if (!state.debugMode) return;
    const t = state.debugTile;
    if (t) {
      dbgEmpty.visible = false;
      dbgBody.visible = true;
      // Swatch
      dbgSwatch.clear();
      const hex = cssColorToHex(t.elementColor);
      dbgSwatch.roundRect(0, 0, 18, 18, 3).fill({ color: hex, alpha: 1 }).stroke({ width: 1, color: 0x555555 });
      dbgElementName.text = t.elementName;
      dbgElementId.text = `#${t.element}`;
      dbgLines[0].value.text = `col=${t.col} row=${t.row} layer=${t.layer}`;
      dbgLines[1].value.text = t.isTopmost ? "yes (selectable)" : "no (covered)";
      dbgLines[2].value.text = t.glyph;
      dbgLines[3].value.text = `${t.sandMaterialName} (id=${t.sandMaterialId})`;
      dbgLines[4].value.text = `${Math.round(t.screenX)},${Math.round(t.screenY)} ${Math.round(t.screenW)}×${Math.round(t.screenH)}`;
      dbgLines[5].value.text = `${t.sandCol.toFixed(1)},${t.sandRow.toFixed(1)} ${t.sandW.toFixed(1)}×${t.sandH.toFixed(1)}`;
      dbgLines[6].value.text = `${t.neighbors.n}/${t.neighbors.s}/${t.neighbors.e}/${t.neighbors.w}`;
    } else {
      dbgEmpty.visible = true;
      dbgBody.visible = false;
    }
  }

  // ── Update combo bar ──
  function updateComboBar(): void {
    comboBar.clear();
    if (state.combo <= 0 || state.lastMatchTime <= 0) return;
    const now = performance.now();
    const remaining = Math.max(0, Math.min(1, (COMBO_WINDOW_MS - (now - state.lastMatchTime)) / COMBO_WINDOW_MS));
    if (remaining <= 0) return;
    const barW = 80;
    comboBar.roundRect(0, 0, barW, 3, 1.5).fill({ color: 0x333355, alpha: 0.8 });
    comboBar.roundRect(0, 0, barW * remaining, 3, 1.5).fill({ color: COL_GOLD, alpha: 0.9 });
  }

  // ── Sync UI from state ──
  function syncUI(): void {
    // HUD
    hudItems[0].value.text = String(state.level);
    hudItems[1].value.text = state.score.toLocaleString();
    hudItems[2].value.text = state.highScore.toLocaleString();
    hudItems[3].value.text = `x${state.combo}`;
    hudItems[4].value.text = String(state.tilesLeft);
    hudItems[5].value.text = MODE_NAMES[state.mode];
    updateComboBar();

    // FPS
    fpsText.text = `${Math.floor(state.fps)} FPS`;

    // Pause button
    pauseBtn.visible = !state.showMainMenu;

    // Toolbar
    toolbar.visible = !state.showMainMenu && !state.showPauseMenu && !state.showHelp && !state.showSettings;
    setActive(debugBtn, state.debugMode);

    // Toast
    if (state.toast) {
      toast.visible = true;
      toastText.text = state.toast.message;
      const tw = toastText.width + 32;
      const th = toastText.height + 16;
      toastBg.clear();
      toastBg.roundRect(0, 0, tw, th, 6).fill({ color: COL_PANEL, alpha: 0.95 }).stroke({ width: 1, color: COL_ACCENT, alpha: 0.5 });
    } else {
      toast.visible = false;
    }

    // Level cleared
    const showLevelCleared = state.tilesLeft === 0 && !state.showPauseMenu && !state.showMainMenu && state.level > 0;
    levelCleared.visible = showLevelCleared;
    if (showLevelCleared) {
      levelClearedTitle.text = `Level ${state.level} Cleared!`;
      levelClearedSub.text = `Advancing to level ${state.level + 1}...`;
    }

    // Main menu
    mainMenu.visible = state.showMainMenu;
    if (state.showMainMenu) {
      for (let i = 0; i < modeCards.length; i++) {
        const m = modes[i];
        const cb = modeCards[i].continueBtn;
        if (cb) cb.visible = state.hasSave[m];
      }
    }

    // Pause menu
    pauseMenu.visible = state.showPauseMenu;
    if (state.showPauseMenu) {
      setBtnText(pmNoAdjacent, `No-Adjacent: ${state.noAdjacentSame ? "ON" : "OFF"}`);
      setActive(pmNoAdjacent, state.noAdjacentSame);
      setBtnText(pmSand, `Sand: ${state.sandEnabled ? "ON" : "OFF"}`);
      setActive(pmSand, !state.sandEnabled);
      pmModeLabel.text = `Mode: ${MODE_NAMES[state.mode]}`;
    }

    // Help
    helpModal.visible = state.showHelp;
    if (state.showHelp) updateHelpText();

    // Settings
    settingsModal.visible = state.showSettings;
    if (state.showSettings) {
      const isAuto = state.customCols === 0 && state.customRows === 0;
      setCheckboxChecked(autoSizeCb, isAuto);
      setCheckboxEnabled(autoSizeCb, true);
      setSliderEnabled(colsSlider, !isAuto);
      setSliderEnabled(rowsSlider, !isAuto);
      setSliderValue(colsSlider, state.customCols === 0 ? 16 : state.customCols);
      setSliderValue(rowsSlider, state.customRows === 0 ? 12 : state.customRows);
      setHint.text = `No-Adjacent is ${state.noAdjacentSame ? "ON" : "OFF"} (auto-on after level 10). Changing the size regenerates the current level.`;
    }

    // Debug
    updateDebugPanel();

    // Interactive mode: capture input when any modal/menu is open
    const interactive = state.showMainMenu || state.showPauseMenu || state.showHelp || state.showSettings || state.debugMode;
    ctx.setInteractive(interactive);
  }

  // ── Layout root children based on visibility ──
  syncUI();

  return {
    root,
    update({ stats, events }) {
      // Read SAB scalars
      state.fps = stats.fps ?? state.fps;
      state.score = stats.score ?? state.score;
      state.combo = stats.combo ?? state.combo;
      state.level = stats.level ?? state.level;
      state.tilesLeft = stats.tilesLeft ?? state.tilesLeft;
      state.highScore = stats.highScore ?? state.highScore;
      state.paused = (stats.paused ?? 0) !== 0;
      state.mode = (stats.mode ?? 0) === 1 ? "mahjongg" : "sandjongg";
      state.sandEnabled = (stats.sandEnabled ?? 1) !== 0;
      state.showMainMenu = (stats.showMainMenu ?? 0) !== 0;
      state.showPauseMenu = (stats.showPauseMenu ?? 0) !== 0;
      state.showHelp = (stats.showHelp ?? 0) !== 0;
      state.showSettings = (stats.showSettings ?? 0) !== 0;
      state.debugMode = (stats.debugMode ?? 0) !== 0;
      state.noAdjacentSame = (stats.noAdjacentSame ?? 0) !== 0;
      state.tileset = (stats.tileset ?? 0) === 1 ? "riichi" : "elements";
      state.tileTheme = (stats.tileTheme ?? 0) === 1 ? "dark" : "light";
      state.customCols = stats.customCols ?? state.customCols;
      state.customRows = stats.customRows ?? state.customRows;
      state.lastMatchTime = stats.lastMatchTime ?? state.lastMatchTime;
      state.canvasW = stats.canvasW ?? state.canvasW;
      state.canvasH = stats.canvasH ?? state.canvasH;

      // Process events
      for (const e of events) {
        if (e.kind === "setDebugTile") {
          state.debugTile = (e as any).tile ?? null;
        } else if (e.kind === "showToast") {
          const ev = e as any;
          state.toast = { message: ev.message, id: ev.id };
          // Auto-clear after 2s (host also clears, but this ensures the worker UI hides it)
          setTimeout(() => {
            if (state.toast?.id === ev.id) state.toast = null;
          }, 2000);
        } else if (e.kind === "setHasSave") {
          state.hasSave = (e as any).hasSave ?? state.hasSave;
        } else if (e.kind === "keydown") {
          // ESC closes the topmost overlay, or opens the pause menu when no
          // overlay is open (standard menu UX). The host forwards keydown as
          // a PixiUiEvent; the scene decides the action and posts it back.
          const key = (e as any).key as string;
          if (key === "Escape") {
            if (state.showPauseMenu) post({ kind: "closePauseMenu" });
            else if (state.showHelp) post({ kind: "closePanel", panel: "help" });
            else if (state.showSettings) post({ kind: "closePanel", panel: "settings" });
            else if (!state.showMainMenu) post({ kind: "openPauseMenu" });
          }
        }
      }

      syncUI();
    },
    resize(width, height) {
      layout(width, height);
    },
    getInteractiveRegions(): Rect[] {
      // Non-pass-through mode: when interactive, the whole canvas captures events.
      // Return a full-screen rect so the host knows to forward all events.
      if (state.showMainMenu || state.showPauseMenu || state.showHelp || state.showSettings) {
        return [{ x: 0, y: 0, width: state.canvasW, height: state.canvasH }];
      }
      // During gameplay (non-interactive), return small button regions so the
      // tile canvas still receives clicks for matching.
      const regions: Rect[] = [];
      if (pauseBtn.visible) {
        regions.push({ x: pauseBtn.x, y: pauseBtn.y, width: 36, height: 32 });
      }
      if (toolbar.visible) {
        regions.push({ x: toolbar.x, y: toolbar.y, width: 234, height: 28 });
      }
      if (debugPanel.visible) {
        regions.push({ x: debugPanel.x, y: debugPanel.y, width: 280, height: 260 });
      }
      return regions;
    },
    summarize() {
      return root.children.map((child) => ({
        name: child.label ?? "",
        type: child.constructor?.name ?? "unknown",
        visible: child.visible,
        x: child.x,
        y: child.y,
        width: child.width,
        height: child.height,
      }));
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}

// ── Helpers ──

function cssColorToHex(css: string): number {
  // Parse #rrggbb or rgb(r,g,b)
  if (css.startsWith("#")) {
    return parseInt(css.slice(1), 16);
  }
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    return ((parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3])) >>> 0;
  }
  return 0xffffff;
}
