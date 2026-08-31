// ============================================================================
// falling-sand pixi-scene — the PixiJS UI scene for the falling-sand game.
//
// Replaces the React app.tsx overlay. Runs inside the pixi-ui Web Worker on
// an OffscreenCanvas. Reads per-frame scalars from the UiStatsSAB + events
// via postMessage; sends actions back to the main thread via postAction.
//
// Uses pass-through mode: the overlay canvas is always pointer-events: auto.
// Interactive regions (left panel, material toolbar, settings/saves panels)
// are reported via getInteractiveRegions() so the host can forward non-hit
// pointer events to the game canvas for painting.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, Rect } from "@downdraft/library-pixi-ui";
import { MATERIALS } from "@downdraft/library-sand";
import { Container, Graphics, Text } from "pixi.js";
import type { FallingSandAction } from "./pixi/bridge-protocol";

// ── Material names (must match the original app.tsx) ──
const MATERIAL_NAMES = [
  "Empty", "Sand", "Water", "Stone", "Wood", "Fire", "Smoke",
  "Oil", "Gunpowder", "Iron", "Lava", "Steam", "Plant", "Flesh",
  "Dirt", "Seed", "Leaf", "Antimatter", "???", "Flour",
  "Gasoline", "Gas Vapor", "Hydrogen", "Plastic", "Toast", "Salt",
  "Wall", "Fireflies", "Grass", "Snow", "Honey", "Mercury",
  "Fuse", "C4", "Dynamite", "Wax", "Concrete Powder", "Dry Ice",
  "Liquid Nitrogen", "Plasma", "Nanobots", "Magic Powder", "Glitter",
  "Popcorn", "Rubber", "Root", "Brine", "Molten Salt", "Concrete", "Tree Wood",
  "Fuse Fire", "Burning Oil",
  "Tin Ore", "Copper Ore", "Iron Ore", "Bauxite Ore", "Silver Ore", "Gold Ore", "Cobalt Ore",
  "Methane Gas", "Sulfur Gas", "Coal", "Gravel", "Loose Stone",
  "Ice", "Ether", "Blood", "Syrup", "Nightshade Extract", "Troll Blood",
  "Liquid Shadow", "Love Essence", "Hate Essence", "Dream Mist", "Void Essence",
  "Sulfur", "Ground Eye of Newt", "Ground Bat Wing", "Bone Dust", "Iron Filings",
  "Moonstone Dust", "Crystal Dust", "Mushroom Spores", "Dragon Scale", "Phoenix Feather",
  "Unicorn Horn", "Mandrake Root", "Spider Silk", "Grave Dust", "Star Shard", "Time Sand",
  "Ethereal Vapor", "Alchemical Slag",
  "Scaffolding", "Ladder", "Rope", "Torch", "Cold Vapor",
  "Acid", "Base",
  "Obsidian", "Spore", "Mold", "Glitch", "Tar", "Duplicator", "Void",
];

const FIELD_TYPE_NAMES = ["Gravity", "Temperature", "Wind X", "Wind Y"];

// ── Colors ──
const COL_BG = 0x000000;
const COL_BG_ALPHA = 0.8;
const COL_TEXT = 0xffffff;
const COL_TEXT_DIM = 0x999999;
const COL_ACCENT = 0x4fc3f7;
const COL_YELLOW = 0xffff00;
const COL_TRACK = 0x333333;
const COL_KNOB = 0xcccccc;

// ── Style presets ──
const FONT = "monospace";
const FONT_SIZE = 12;
const FONT_SIZE_SM = 10;
const FONT_SIZE_LG = 14;

function rgbToHex(r: number, g: number, b: number): number {
  return ((Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)) >>> 0;
}

function matColorHex(mat: number): number {
  const c = MATERIALS[mat]?.color;
  if (!c) return 0x000000;
  return rgbToHex(c[0], c[1], c[2]);
}

function matAlpha(mat: number): number {
  return MATERIALS[mat]?.color?.[3] ?? 1;
}

// ── UI helpers ──

interface Button extends Container {
  _bg: Graphics;
  _label: Text;
  _active: boolean;
  _accent: boolean;
  _danger: boolean;
  _onClick: () => void;
}

function createButton(
  text: string,
  w: number,
  h: number,
  onClick: () => void,
  opts: { accent?: boolean; danger?: boolean; fontSize?: number } = {},
): Button {
  const c = new Container() as Button;
  c._accent = !!opts.accent;
  c._danger = !!opts.danger;
  c._active = false;
  c._onClick = onClick;

  const bg = new Graphics();
  c._bg = bg;
  c.addChild(bg);

  const label = new Text({
    text,
    style: { fill: COL_TEXT, fontSize: opts.fontSize ?? FONT_SIZE, fontFamily: FONT },
  });
  label.anchor.set(0.5);
  label.x = w / 2;
  label.y = h / 2;
  c._label = label;
  c.addChild(label);

  drawButtonBg(c);
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointerdown", () => onClick());

  // Hover effect
  c.on("pointerenter", () => { c._active = true; drawButtonBg(c); });
  c.on("pointerleave", () => { c._active = false; drawButtonBg(c); });

  return c;
}

function drawButtonBg(btn: Button): void {
  const w = btn.width || 80;
  const h = btn.height || 24;
  const bg = btn._bg;
  bg.clear();
  let fillCol = 0x222222;
  let alpha = 0.9;
  if (btn._active) { fillCol = 0x333333; alpha = 1; }
  if (btn._accent) { fillCol = btn._active ? 0x4fc3f7 : 0x2a5a7a; alpha = btn._active ? 0.5 : 0.3; }
  if (btn._danger) { fillCol = btn._active ? 0xf44336 : 0x882222; alpha = btn._active ? 0.4 : 0.2; }
  const strokeCol = btn._accent ? 0x4fc3f7 : btn._danger ? 0xf44336 : 0x555555;
  bg.roundRect(0, 0, w, h, 4).fill({ color: fillCol, alpha }).stroke({ width: 1, color: strokeCol, alpha: 0.6 });
}

function setActive(btn: Button, active: boolean): void {
  btn._active = active;
  drawButtonBg(btn);
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

  const label = new Text({
    text: labelText,
    style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT },
  });
  label.y = 0;
  c._label = label;
  c.addChild(label);

  const valueText = new Text({
    text: value.toString(),
    style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT },
  });
  valueText.x = trackW - 30;
  valueText.y = 0;
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

  // Drag handling
  knob.on("pointerdown", (e: any) => {
    c._dragging = true;
    knob.cursor = "grabbing";
    e.stopPropagation();
  });
  // Use global pointermove on the knob's parent chain
  knob.on("globalpointermove", (e: any) => {
    if (!c._dragging) return;
    const local = c.toLocal(e.global);
    setSliderValueFromX(c, local.x);
  });
  knob.on("pointerup", () => { c._dragging = false; knob.cursor = "grab"; });
  knob.on("pointerupoutside", () => { c._dragging = false; knob.cursor = "grab"; });

  // Also allow clicking on the track to jump
  track.eventMode = "static";
  track.on("pointerdown", (e: any) => {
    const local = c.toLocal(e.global);
    setSliderValueFromX(c, local.x);
    e.stopPropagation();
  });

  return c;
}

function drawSliderTrack(s: Slider): void {
  s._track.clear();
  s._track.roundRect(0, 0, s._trackW, 6, 3).fill({ color: COL_TRACK, alpha: 0.9 });
}

function updateSliderKnob(s: Slider): void {
  const ratio = (s._value - s._min) / (s._max - s._min);
  const x = Math.max(0, Math.min(1, ratio)) * s._trackW;
  s._knob.clear();
  s._knob.circle(x, 0, 7).fill({ color: COL_KNOB, alpha: 1 }).stroke({ width: 1, color: 0x888888 });
}

function setSliderValueFromX(s: Slider, x: number): void {
  const ratio = Math.max(0, Math.min(1, x / s._trackW));
  let v = s._min + ratio * (s._max - s._min);
  if (s._step > 0) {
    v = Math.round(v / s._step) * s._step;
  }
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

// ── Panel background ──

function createPanelBg(w: number, h: number, radius = 4): Graphics {
  const g = new Graphics();
  g.roundRect(0, 0, w, h, radius).fill({ color: COL_BG, alpha: COL_BG_ALPHA }).stroke({ width: 1, color: 0x333333, alpha: 0.6 });
  return g;
}

// ── The scene ──

export default function createFallingSandScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = new Container();
  root.name = "hud-root";
  ctx.app.stage.addChild(root);

  // ── State (updated from SAB + events) ──
  const state = {
    fps: 0,
    health: 100,
    paused: false,
    selectedMaterial: 1,
    brushMode: 0, // 0=material, 1=field
    fieldType: 0,
    fieldGravity: 128,
    fieldTemperature: 128,
    fieldWindX: 0,
    fieldWindY: 0,
    showFieldOverlay: false,
    brushRadius: 3,
    showSettings: false,
    showSaves: false,
    impulseChance: 0.02,
    impulseStrength: 1,
    inspector: { valid: false, gx: -1, gy: -1, mat: 0, lifetime: 0, shade: 0, gravity: 128, temperature: 128, windX: 0, windY: 0 },
    saves: [] as Array<{ id: string; name: string; timestamp: number; gridW: number; gridH: number }>,
    mouseX: 0,
    mouseY: 0,
    mouseValid: false,
    gridW: 1,
    gridH: 1,
    canvasW: 1280,
    canvasH: 720,
  };

  function post(action: FallingSandAction): void {
    ctx.postAction(action);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Left panel (top-left)
  // ════════════════════════════════════════════════════════════════════════
  const leftPanel = new Container();
  leftPanel.name = "left-panel";
  leftPanel.x = 8;
  leftPanel.y = 8;
  const LP_W = 210;
  const LP_H = 300;
  leftPanel.addChild(createPanelBg(LP_W, LP_H));

  const fpsText = new Text({ text: "FPS: 0", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT } });
  fpsText.x = 10; fpsText.y = 8;
  leftPanel.addChild(fpsText);

  const healthText = new Text({ text: "Health: 100", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT } });
  healthText.x = 10; healthText.y = 24;
  leftPanel.addChild(healthText);

  // Brush mode toggle (segmented control)
  const matBtn = createButton("Material", 92, 22, () => post({ kind: "setBrushMode", mode: 0 }), { accent: true });
  matBtn.x = 10; matBtn.y = 46;
  leftPanel.addChild(matBtn);

  const fieldBtn = createButton("Field", 92, 22, () => post({ kind: "setBrushMode", mode: 1 }), { accent: true });
  fieldBtn.x = 108; fieldBtn.y = 46;
  leftPanel.addChild(fieldBtn);

  // Material name (shown in material mode)
  const matNameText = new Text({ text: "Material: Sand", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT } });
  matNameText.x = 10; matNameText.y = 74;
  leftPanel.addChild(matNameText);

  // Field type segmented control (shown in field mode)
  const fieldTypeContainer = new Container();
  fieldTypeContainer.x = 10; fieldTypeContainer.y = 74;
  fieldTypeContainer.visible = false;
  leftPanel.addChild(fieldTypeContainer);

  const fieldTypeBtns: Button[] = [];
  for (let i = 0; i < 4; i++) {
    const btn = createButton(FIELD_TYPE_NAMES[i], 46, 20, () => post({ kind: "setFieldType", fieldType: i }), { accent: true, fontSize: FONT_SIZE_SM });
    btn.x = i * 48;
    fieldTypeBtns.push(btn);
    fieldTypeContainer.addChild(btn);
  }

  // Field value slider (shown in field mode, for gravity/temperature)
  const fieldSlider = createSlider("Value", 0, 255, 1, 128, 180, (v) => {
    if (state.fieldType === 0) post({ kind: "setFieldValue", field: "gravity", value: v });
    else if (state.fieldType === 1) post({ kind: "setFieldValue", field: "temperature", value: v });
    else if (state.fieldType === 2) post({ kind: "setFieldValue", field: "windX", value: v });
    else post({ kind: "setFieldValue", field: "windY", value: v });
  });
  fieldSlider.x = 10; fieldSlider.y = 100;
  fieldSlider.visible = false;
  leftPanel.addChild(fieldSlider);

  // Show/hide fields button
  const showFieldsBtn = createButton("Show Fields", 190, 22, () => post({ kind: "setShowFieldOverlay", show: !state.showFieldOverlay }), { accent: true });
  showFieldsBtn.x = 10; showFieldsBtn.y = 128;
  showFieldsBtn.visible = false;
  leftPanel.addChild(showFieldsBtn);

  // Brush radius slider
  const brushSlider = createSlider("Brush", 0, 20, 1, 3, 180, (v) => post({ kind: "setBrushRadius", radius: v }));
  brushSlider.x = 10; brushSlider.y = 158;
  leftPanel.addChild(brushSlider);

  // PAUSED indicator
  const pausedText = new Text({ text: "PAUSED", style: { fill: COL_YELLOW, fontSize: FONT_SIZE_LG, fontFamily: FONT, fontWeight: "bold" } });
  pausedText.x = 10; pausedText.y = 188;
  pausedText.visible = false;
  leftPanel.addChild(pausedText);

  // Save / Load / Clear buttons
  const saveBtn = createButton("Save", 58, 22, () => post({ kind: "save" }));
  saveBtn.x = 10; saveBtn.y = 210;
  leftPanel.addChild(saveBtn);

  const loadBtn = createButton("Load", 58, 22, () => post({ kind: "togglePanel", panel: "saves" }));
  loadBtn.x = 72; loadBtn.y = 210;
  leftPanel.addChild(loadBtn);

  const clearBtn = createButton("Clear", 58, 22, () => post({ kind: "clear" }), { danger: true });
  clearBtn.x = 134; clearBtn.y = 210;
  leftPanel.addChild(clearBtn);

  // Settings button
  const settingsBtn = createButton("Settings", 190, 22, () => post({ kind: "togglePanel", panel: "settings" }));
  settingsBtn.x = 10; settingsBtn.y = 238;
  leftPanel.addChild(settingsBtn);

  root.addChild(leftPanel);

  // ════════════════════════════════════════════════════════════════════════
  // Material toolbar (top-center, scrollable swatch grid)
  // ════════════════════════════════════════════════════════════════════════
  const toolbar = new Container();
  toolbar.name = "material-toolbar";
  toolbar.visible = false;
  root.addChild(toolbar);

  const SWATCH_SIZE = 22;
  const SWATCH_GAP = 2;
  const TOOLBAR_PAD = 4;
  const TOOLBAR_MAX_W = 600;
  const cols = Math.floor((TOOLBAR_MAX_W - TOOLBAR_PAD * 2 + SWATCH_GAP) / (SWATCH_SIZE + SWATCH_GAP));
  const toolbarW = cols * (SWATCH_SIZE + SWATCH_GAP) - SWATCH_GAP + TOOLBAR_PAD * 2;
  const rows = Math.ceil(MATERIAL_NAMES.length / cols);
  const toolbarH = Math.min(rows, 5) * (SWATCH_SIZE + SWATCH_GAP) - SWATCH_GAP + TOOLBAR_PAD * 2;

  toolbar.addChild(createPanelBg(toolbarW, toolbarH));

  const swatchContainer = new Container();
  swatchContainer.x = TOOLBAR_PAD;
  swatchContainer.y = TOOLBAR_PAD;
  // Mask to clip overflow (scrollable)
  const maskG = new Graphics();
  maskG.rect(0, 0, toolbarW - TOOLBAR_PAD * 2, toolbarH - TOOLBAR_PAD * 2).fill({ color: 0xffffff });
  swatchContainer.addChild(maskG);
  swatchContainer.mask = maskG;

  const swatches: Container[] = [];
  for (let i = 0; i < MATERIAL_NAMES.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sw = new Container();
    sw.x = col * (SWATCH_SIZE + SWATCH_GAP);
    sw.y = row * (SWATCH_SIZE + SWATCH_GAP);
    sw.eventMode = "static";
    sw.cursor = "pointer";

    const bg = new Graphics();
    bg.roundRect(0, 0, SWATCH_SIZE, SWATCH_SIZE, 3).fill({ color: matColorHex(i), alpha: matAlpha(i) }).stroke({ width: 1, color: 0x333333, alpha: 0.5 });
    sw.addChild(bg);

    sw.on("pointerdown", () => post({ kind: "selectMaterial", mat: i }));
    sw.on("pointerenter", () => {
      tooltipText.text = `${i}: ${MATERIAL_NAMES[i] ?? "Unknown"}`;
      tooltip.visible = true;
    });
    sw.on("pointerleave", () => { tooltip.visible = false; });

    swatches.push(sw);
    swatchContainer.addChild(sw);
  }
  toolbar.addChild(swatchContainer);

  // Selected swatch highlight (drawn on top)
  const swatchHighlight = new Graphics();
  swatchHighlight.x = TOOLBAR_PAD;
  swatchHighlight.y = TOOLBAR_PAD;
  toolbar.addChild(swatchHighlight);

  // ════════════════════════════════════════════════════════════════════════
  // Tooltip (follows mouse on swatch hover)
  // ════════════════════════════════════════════════════════════════════════
  const tooltip = new Container();
  tooltip.name = "tooltip";
  tooltip.visible = false;
  root.addChild(tooltip);

  const tooltipBg = new Graphics();
  tooltip.addChild(tooltipBg);
  const tooltipText = new Text({ text: "", style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
  tooltipText.x = 6; tooltipText.y = 3;
  tooltip.addChild(tooltipText);

  // ════════════════════════════════════════════════════════════════════════
  // Brush circle (follows mouse over game canvas)
  // ════════════════════════════════════════════════════════════════════════
  const brushCircle = new Graphics();
  brushCircle.name = "brush-circle";
  brushCircle.visible = false;
  root.addChild(brushCircle);

  // ════════════════════════════════════════════════════════════════════════
  // Cell inspector (bottom-right)
  // ════════════════════════════════════════════════════════════════════════
  const inspector = new Container();
  inspector.name = "inspector";
  inspector.x = 8;
  const INS_W = 220;
  const INS_H = 200;
  inspector.addChild(createPanelBg(INS_W, INS_H));

  const insTitle = new Text({ text: "Cell Inspector", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT, fontWeight: "bold" } });
  insTitle.x = 10; insTitle.y = 8;
  inspector.addChild(insTitle);

  const insLines: Text[] = [];
  const insLineLabels = ["Position", "Material", "Lifetime", "Shade", "Gravity", "Temp", "Wind X", "Wind Y"];
  for (let i = 0; i < insLineLabels.length; i++) {
    const y = 28 + i * 16;
    const label = new Text({ text: insLineLabels[i], style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
    label.x = 10; label.y = y;
    inspector.addChild(label);
    const val = new Text({ text: "—", style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
    val.x = 90; val.y = y;
    inspector.addChild(val);
    insLines.push(val);
  }

  const insHint = new Text({ text: "Hover over the grid", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
  insHint.x = 10; insHint.y = 28;
  inspector.addChild(insHint);

  root.addChild(inspector);

  // ════════════════════════════════════════════════════════════════════════
  // Settings panel (top-right)
  // ════════════════════════════════════════════════════════════════════════
  const settingsPanel = new Container();
  settingsPanel.name = "settings-panel";
  settingsPanel.visible = false;
  const SET_W = 280;
  const SET_H = 120;
  settingsPanel.addChild(createPanelBg(SET_W, SET_H));

  const set_title = new Text({ text: "Impulse Settings", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT, fontWeight: "bold" } });
  set_title.x = 12; set_title.y = 8;
  settingsPanel.addChild(set_title);

  const chanceSlider = createSlider("Chance", 0, 0.2, 0.005, 0.02, 240, (v) => post({ kind: "setSettings", impulseChance: v }));
  chanceSlider.x = 12; chanceSlider.y = 34;
  settingsPanel.addChild(chanceSlider);

  const forceSlider = createSlider("Force", 0, 5, 0.5, 1, 240, (v) => post({ kind: "setSettings", impulseStrength: v }));
  forceSlider.x = 12; forceSlider.y = 74;
  settingsPanel.addChild(forceSlider);

  root.addChild(settingsPanel);

  // ════════════════════════════════════════════════════════════════════════
  // Saves panel (top-right, below settings)
  // ════════════════════════════════════════════════════════════════════════
  const savesPanel = new Container();
  savesPanel.name = "saves-panel";
  savesPanel.visible = false;
  root.addChild(savesPanel);

  // Panel background must be children[0] — updateSavesPanel() clears and
  // redraws it to resize with the save list. (Matches the settingsPanel
  // pattern where createPanelBg is added before the title.)
  savesPanel.addChild(createPanelBg(360, 60));

  const savesTitle = new Text({ text: "Saves", style: { fill: COL_TEXT, fontSize: FONT_SIZE, fontFamily: FONT, fontWeight: "bold" } });
  savesTitle.x = 12; savesTitle.y = 8;
  savesPanel.addChild(savesTitle);

  const savesContent = new Container();
  savesContent.x = 12; savesContent.y = 32;
  savesPanel.addChild(savesContent);

  const savesEmpty = new Text({ text: "No saves yet.", style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM, fontFamily: FONT } });
  savesContent.addChild(savesEmpty);

  // ════════════════════════════════════════════════════════════════════════
  // Help text (bottom-left)
  // ════════════════════════════════════════════════════════════════════════
  const helpText = new Text({
    text: "WASD / Space • Left-click paint • Right-click ignite • Middle-click pick material",
    style: { fill: 0x999999, fontSize: FONT_SIZE_SM, fontFamily: FONT },
  });
  helpText.x = 8;
  root.addChild(helpText);

  // ── Layout (depends on canvas size) ──
  function layout(width: number, height: number): void {
    // Material toolbar: top-center
    toolbar.x = Math.round((width - toolbarW) / 2);
    toolbar.y = 8;

    // Inspector: bottom-right
    inspector.x = width - INS_W - 8;
    inspector.y = height - INS_H - 8;

    // Settings/saves: top-right
    settingsPanel.x = width - SET_W - 8;
    settingsPanel.y = 8;
    savesPanel.x = width - 360 - 8;
    savesPanel.y = 8;

    // Help text: bottom-left
    helpText.y = height - 24;

    state.canvasW = width;
    state.canvasH = height;
  }
  layout(ctx.width, ctx.height);

  // ── Update saves panel content ──
  function updateSavesPanel(): void {
    savesContent.removeChildren();
    const panelBg = savesPanel.children[0] as Graphics;
    if (state.saves.length === 0) {
      savesContent.addChild(savesEmpty);
      panelBg.clear();
      panelBg.roundRect(0, 0, 360, 60, 4).fill({ color: COL_BG, alpha: COL_BG_ALPHA }).stroke({ width: 1, color: 0x333333, alpha: 0.6 });
      return;
    }
    const entryH = 28;
    const panelH = 40 + state.saves.length * entryH;
    panelBg.clear();
    panelBg.roundRect(0, 0, 360, panelH, 4).fill({ color: COL_BG, alpha: COL_BG_ALPHA }).stroke({ width: 1, color: 0x333333, alpha: 0.6 });

    for (let i = 0; i < state.saves.length; i++) {
      const save = state.saves[i];
      const row = new Container();
      row.y = i * entryH;

      const nameText = new Text({
        text: save.name,
        style: { fill: COL_TEXT, fontSize: FONT_SIZE_SM, fontFamily: FONT },
      });
      nameText.x = 0; nameText.y = 0;
      row.addChild(nameText);

      const dateText = new Text({
        text: `${new Date(save.timestamp).toLocaleString()} • ${save.gridW}×${save.gridH}`,
        style: { fill: COL_TEXT_DIM, fontSize: FONT_SIZE_SM - 1, fontFamily: FONT },
      });
      dateText.x = 0; dateText.y = 13;
      row.addChild(dateText);

      const loadB = createButton("Load", 50, 20, () => post({ kind: "load", id: save.id }));
      loadB.x = 250; loadB.y = 0;
      row.addChild(loadB);

      const delB = createButton("Del", 40, 20, () => post({ kind: "deleteSave", id: save.id }), { danger: true });
      delB.x = 304; delB.y = 0;
      row.addChild(delB);

      savesContent.addChild(row);
    }
  }

  // ── Update brush circle ──
  function updateBrushCircle(): void {
    if (!state.mouseValid || state.mouseX < 0 || state.mouseY < 0) {
      brushCircle.visible = false;
      return;
    }
    brushCircle.visible = true;
    const cellW = state.canvasW / state.gridW;
    const cellH = state.canvasH / state.gridH;
    const cellSize = Math.min(cellW, cellH);
    const diameter = (state.brushRadius + 0.5) * 2 * cellSize;
    brushCircle.clear();
    brushCircle.circle(state.mouseX, state.mouseY, diameter / 2)
      .fill({ color: 0xffffff, alpha: 0.08 })
      .stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
  }

  // ── Update selected swatch highlight ──
  function updateSwatchHighlight(): void {
    swatchHighlight.clear();
    if (state.brushMode !== 0) return;
    const i = state.selectedMaterial;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (SWATCH_SIZE + SWATCH_GAP) - 1;
    const y = row * (SWATCH_SIZE + SWATCH_GAP) - 1;
    swatchHighlight.roundRect(x, y, SWATCH_SIZE + 2, SWATCH_SIZE + 2, 4)
      .stroke({ width: 2, color: COL_ACCENT, alpha: 1 });
  }

  // ── Sync UI from state ──
  function syncUI(): void {
    fpsText.text = `FPS: ${Math.floor(state.fps)}`;
    healthText.text = `Health: ${state.health}`;
    pausedText.visible = state.paused;

    // Brush mode toggle
    setActive(matBtn, state.brushMode === 0);
    setActive(fieldBtn, state.brushMode === 1);

    // Material name vs field controls
    matNameText.visible = state.brushMode === 0;
    matNameText.text = `Material: ${MATERIAL_NAMES[state.selectedMaterial] ?? "Unknown"}`;
    fieldTypeContainer.visible = state.brushMode === 1;
    fieldSlider.visible = state.brushMode === 1 && (state.fieldType === 0 || state.fieldType === 1);
    showFieldsBtn.visible = state.brushMode === 1;
    setActive(showFieldsBtn, state.showFieldOverlay);

    // Field type buttons
    for (let i = 0; i < 4; i++) {
      setActive(fieldTypeBtns[i], state.fieldType === i);
    }

    // Field slider value
    if (state.brushMode === 1) {
      if (state.fieldType === 0) { setSliderValue(fieldSlider, state.fieldGravity); fieldSlider._label.text = "Gravity"; fieldSlider._min = 0; fieldSlider._max = 255; }
      else if (state.fieldType === 1) { setSliderValue(fieldSlider, state.fieldTemperature); fieldSlider._label.text = "Temp"; fieldSlider._min = 0; fieldSlider._max = 255; }
      else if (state.fieldType === 2) { setSliderValue(fieldSlider, state.fieldWindX); fieldSlider._label.text = "Wind X"; fieldSlider._min = -128; fieldSlider._max = 127; }
      else { setSliderValue(fieldSlider, state.fieldWindY); fieldSlider._label.text = "Wind Y"; fieldSlider._min = -128; fieldSlider._max = 127; }
      updateSliderKnob(fieldSlider);
    }

    // Brush slider
    setSliderValue(brushSlider, state.brushRadius);

    // Toolbar visibility
    toolbar.visible = state.brushMode === 0;
    updateSwatchHighlight();

    // Settings panel
    settingsPanel.visible = state.showSettings;
    setSliderValue(chanceSlider, state.impulseChance);
    setSliderValue(forceSlider, state.impulseStrength);

    // Saves panel
    savesPanel.visible = state.showSaves;

    // Inspector
    const ins = state.inspector;
    if (ins.valid) {
      insHint.visible = false;
      for (const l of insLines) l.visible = true;
      insLines[0].text = `(${ins.gx}, ${ins.gy})`;
      insLines[1].text = `${ins.mat}: ${MATERIALS[ins.mat]?.name ?? "Unknown"}`;
      insLines[2].text = `${ins.lifetime}`;
      insLines[3].text = `${ins.shade}/3`;
      insLines[4].text = `${(ins.gravity / 128).toFixed(2)}× (${ins.gravity})`;
      insLines[5].text = `${(ins.temperature / 128).toFixed(2)} (${ins.temperature})`;
      insLines[6].text = `${ins.windX}`;
      insLines[7].text = `${ins.windY}`;
    } else {
      insHint.visible = true;
      for (const l of insLines) l.visible = false;
    }

    // Brush circle
    updateBrushCircle();

    // Tooltip follows mouse (roughly — updated from SAB mouseX/mouseY)
    if (tooltip.visible) {
      tooltipBg.clear();
      const tw = tooltipText.width + 12;
      const th = tooltipText.height + 6;
      tooltipBg.roundRect(0, 0, tw, th, 4).fill({ color: 0x000000, alpha: 0.9 }).stroke({ width: 1, color: 0x555555, alpha: 0.5 });
      tooltip.x = state.mouseX + 14;
      tooltip.y = state.mouseY + 14;
    }
  }

  // Start in interactive mode (pass-through handles region checking)
  ctx.setInteractive(true);

  return {
    root,
    update({ stats, events }) {
      // Read SAB scalars
      state.fps = stats.fps ?? state.fps;
      state.health = stats.health ?? state.health;
      state.paused = (stats.paused ?? 0) !== 0;
      state.selectedMaterial = stats.selectedMaterial ?? state.selectedMaterial;
      state.brushMode = stats.brushMode ?? state.brushMode;
      state.fieldType = stats.fieldType ?? state.fieldType;
      state.fieldGravity = stats.fieldGravity ?? state.fieldGravity;
      state.fieldTemperature = stats.fieldTemperature ?? state.fieldTemperature;
      state.fieldWindX = stats.fieldWindX ?? state.fieldWindX;
      state.fieldWindY = stats.fieldWindY ?? state.fieldWindY;
      state.showFieldOverlay = (stats.showFieldOverlay ?? 0) !== 0;
      state.brushRadius = stats.brushRadius ?? state.brushRadius;
      state.showSettings = (stats.showSettings ?? 0) !== 0;
      state.showSaves = (stats.showSaves ?? 0) !== 0;
      state.impulseChance = stats.impulseChance ?? state.impulseChance;
      state.impulseStrength = stats.impulseStrength ?? state.impulseStrength;
      state.inspector.valid = (stats.inspectorValid ?? 0) !== 0;
      state.inspector.gx = stats.inspectorGx ?? -1;
      state.inspector.gy = stats.inspectorGy ?? -1;
      state.inspector.mat = stats.inspectorMat ?? 0;
      state.inspector.lifetime = stats.inspectorLifetime ?? 0;
      state.inspector.shade = stats.inspectorShade ?? 0;
      state.inspector.gravity = stats.inspectorGravity ?? 128;
      state.inspector.temperature = stats.inspectorTemperature ?? 128;
      state.inspector.windX = stats.inspectorWindX ?? 0;
      state.inspector.windY = stats.inspectorWindY ?? 0;
      state.mouseX = stats.mouseX ?? 0;
      state.mouseY = stats.mouseY ?? 0;
      state.mouseValid = (stats.mouseValid ?? 0) !== 0;
      state.gridW = stats.gridW ?? state.gridW;
      state.gridH = stats.gridH ?? state.gridH;
      state.canvasW = stats.canvasW ?? state.canvasW;
      state.canvasH = stats.canvasH ?? state.canvasH;

      // Process events
      for (const e of events) {
        if (e.kind === "setSaves") {
          state.saves = (e as any).saves ?? [];
          updateSavesPanel();
        }
      }

      syncUI();
    },
    resize(width, height) {
      layout(width, height);
    },
    getInteractiveRegions(): Rect[] {
      const regions: Rect[] = [];
      // Left panel is always interactive
      if (leftPanel.visible) {
        regions.push({ x: leftPanel.x, y: leftPanel.y, width: LP_W, height: LP_H });
      }
      // Material toolbar (when visible)
      if (toolbar.visible) {
        regions.push({ x: toolbar.x, y: toolbar.y, width: toolbarW, height: toolbarH });
      }
      // Settings panel
      if (settingsPanel.visible) {
        regions.push({ x: settingsPanel.x, y: settingsPanel.y, width: SET_W, height: SET_H });
      }
      // Saves panel
      if (savesPanel.visible) {
        const h = 40 + Math.max(1, state.saves.length) * 28;
        regions.push({ x: savesPanel.x, y: savesPanel.y, width: 360, height: h });
      }
      return regions;
    },
    summarize() {
      return root.children.map((child) => {
        const summary: any = {
          name: child.name ?? "",
          type: child.constructor?.name ?? "unknown",
          visible: child.visible,
          x: child.x,
          y: child.y,
          width: child.width,
          height: child.height,
        };
        return summary;
      });
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
