// ============================================================================
// falling-sand game UI — imui scene mounted via createGameUi.
//
// Replaces the PixiJS-in-worker scene (src/pixi-scene.ts + bridge protocol).
// State flows directly: the store drives widgets via ui.bind / onUpdate, and
// actions call store setters / save-system handlers in place — no UiStatsSAB,
// postEvent, or postAction bridge.
// ============================================================================

import {
    createGameUi,
    getEffectiveFontScale,
    loadUserFontScale,
    saveUserFontScale,
    setUIFontScale,
    UI_COLORS,
    uiButton,
    UIButton,
    uiButtonActive,
    UILine,
    UIPanel,
    UIScrollPanel,
    uiSliderRow,
    uiText,
    UIText,
    type GameUiContext,
    type RendererModule,
    type UIColor
} from "@downdraft/core";
import { MATERIALS } from "@downdraft/library-sand";
import { useGameStore, type FieldType } from "../stores/game-store";
import type { SaveMetadata } from "../stores/save-system";

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
const FIELD_TYPES: FieldType[] = ["gravity", "temperature", "windX", "windY"];

const COL_YELLOW: UIColor = [1, 1, 0, 1];

const FONT_SIZE = 14;
const FONT_SIZE_SM = 12;
const FONT_SIZE_LG = 16;

function applyPanelStyle(panel: UIPanel): void {
  panel.style.backgroundColor = [...UI_COLORS.bg] as UIColor;
  panel.style.borderColor = [...UI_COLORS.border] as UIColor;
  panel.style.borderWidth = 1;
  panel.style.borderRadius = 4;
}

function matColor(i: number): UIColor {
  const c = MATERIALS[i]?.color;
  if (!c) return [0, 0, 0, 1];
  return [c[0], c[1], c[2], c[3] ?? 1];
}

export interface FallingSandUiDeps {
  onSave(): void;
  onLoad(id: string): void;
  onDeleteSave(id: string): void;
  onRefreshSaves(): void;
}

export function createFallingSandUi(deps: FallingSandUiDeps): RendererModule {
  return createGameUi({
    name: "falling-sand-ui",
    build(ui) {
      const s = () => useGameStore.getState();
      buildHud(ui, deps, s);

      // Apply the persisted font scale (system + user preference).
      setUIFontScale(ui.root, getEffectiveFontScale(loadUserFontScale()));
    },
  });
}

function buildHud(ui: GameUiContext, deps: FallingSandUiDeps, s: () => ReturnType<typeof useGameStore.getState>): void {
  const root = ui.root;

  // ══════════════════════════════════════════════════════════════════
  // Left panel
  // ══════════════════════════════════════════════════════════════════
  const leftPanel = new UIPanel(210, 300);
  leftPanel.name = "left-panel";
  leftPanel.x = 8;
  leftPanel.y = 8;
  leftPanel.pointerThrough = true;
  applyPanelStyle(leftPanel);

  const fpsText = uiText("FPS: 0", 10, 8);
  const healthText = uiText("Health: 100", 10, 24);
  leftPanel.addChild(fpsText);
  leftPanel.addChild(healthText);

  const matBtn = uiButton("Material", 92, 22, () => {}, { accent: true });
  matBtn.x = 10; matBtn.y = 46;
  matBtn.callbacks.onClick = () => s().setBrushMode("material");
  const fieldBtn = uiButton("Field", 92, 22, () => {}, { accent: true });
  fieldBtn.x = 108; fieldBtn.y = 46;
  fieldBtn.callbacks.onClick = () => s().setBrushMode("field");
  leftPanel.addChild(matBtn);
  leftPanel.addChild(fieldBtn);

  const matNameText = uiText("Material: Sand", 10, 74);
  leftPanel.addChild(matNameText);

  const fieldTypeRow = new UIPanel(190, 22);
  fieldTypeRow.x = 10; fieldTypeRow.y = 74;
  fieldTypeRow.pointerThrough = true;
  fieldTypeRow.style.backgroundColor = [0, 0, 0, 0];
  fieldTypeRow.style.borderWidth = 0;
  fieldTypeRow.visible = false;
  const fieldTypeBtns: UIButton[] = [];
  for (let i = 0; i < 4; i++) {
    const b = uiButton(FIELD_TYPE_NAMES[i], 46, 20, () => {}, { accent: true, fontSize: FONT_SIZE_SM });
    b.x = i * 48;
    const ft = FIELD_TYPES[i];
    b.callbacks.onClick = () => s().setFieldType(ft);
    fieldTypeBtns.push(b);
    fieldTypeRow.addChild(b);
  }
  leftPanel.addChild(fieldTypeRow);

  const fieldSlider = uiSliderRow("Value", 0, 255, 128, 180, (v) => {
    const st = s();
    if (st.fieldType === "gravity") st.setFieldGravity(v);
    else if (st.fieldType === "temperature") st.setFieldTemperature(v);
    else if (st.fieldType === "windX") st.setFieldWindX(v);
    else st.setFieldWindY(v);
  });
  fieldSlider.row.x = 10; fieldSlider.row.y = 100;
  fieldSlider.row.visible = false;
  leftPanel.addChild(fieldSlider.row);

  const showFieldsBtn = uiButton("Show Fields", 190, 22, () => {}, { accent: true });
  showFieldsBtn.x = 10; showFieldsBtn.y = 128;
  showFieldsBtn.visible = false;
  showFieldsBtn.callbacks.onClick = () => s().setShowFieldOverlay(!s().showFieldOverlay);
  leftPanel.addChild(showFieldsBtn);

  const brushSlider = uiSliderRow("Brush", 0, 20, 3, 180, (v) => s().setBrushRadius(Math.round(v)));
  brushSlider.row.x = 10; brushSlider.row.y = 158;
  leftPanel.addChild(brushSlider.row);

  const pausedText = uiText("PAUSED", 10, 188, { color: COL_YELLOW, size: FONT_SIZE_LG, bold: true });
  pausedText.visible = false;
  leftPanel.addChild(pausedText);

  const saveBtn = uiButton("Save", 58, 22, () => {});
  saveBtn.x = 10; saveBtn.y = 210;
  saveBtn.callbacks.onClick = () => deps.onSave();
  const loadBtn = uiButton("Load", 58, 22, () => {});
  loadBtn.x = 72; loadBtn.y = 210;
  loadBtn.callbacks.onClick = () => {
    const st = s();
    st.setShowSaves(!st.showSaves);
    if (st.showSaves !== false) deps.onRefreshSaves();
  };
  const clearBtn = uiButton("Clear", 58, 22, () => {}, { danger: true });
  clearBtn.x = 134; clearBtn.y = 210;
  clearBtn.callbacks.onClick = () => s().renderer?.clearAll();
  leftPanel.addChild(saveBtn);
  leftPanel.addChild(loadBtn);
  leftPanel.addChild(clearBtn);

  const settingsBtn = uiButton("Settings", 190, 22, () => {});
  settingsBtn.x = 10; settingsBtn.y = 238;
  settingsBtn.callbacks.onClick = () => s().setShowSettings(!s().showSettings);
  leftPanel.addChild(settingsBtn);

  root.addChild(leftPanel);

  // ══════════════════════════════════════════════════════════════════
  // Material toolbar (top-center, scrollable swatch grid)
  // ══════════════════════════════════════════════════════════════════
  const SWATCH = 22;
  const GAP = 2;
  const PAD = 4;
  const TOOLBAR_MAX_W = 600;
  const cols = Math.floor((TOOLBAR_MAX_W - PAD * 2 + GAP) / (SWATCH + GAP));
  const toolbarW = cols * (SWATCH + GAP) - GAP + PAD * 2;
  const rows = Math.ceil(MATERIAL_NAMES.length / cols);
  const toolbarH = Math.min(rows, 5) * (SWATCH + GAP) - GAP + PAD * 2;

  const toolbar = new UIPanel(toolbarW, toolbarH);
  toolbar.name = "material-toolbar";
  toolbar.visible = false;
  applyPanelStyle(toolbar);

  const swatchScroll = new UIScrollPanel(toolbarW - PAD * 2, toolbarH - PAD * 2);
  swatchScroll.x = PAD;
  swatchScroll.y = PAD;
  swatchScroll.style.borderWidth = 0;
  toolbar.addChild(swatchScroll);

  // Tooltip (created before swatches so callbacks can reference it).
  const tooltip = new UIPanel(0, 0);
  tooltip.name = "tooltip";
  tooltip.visible = false;
  tooltip.pointerThrough = true;
  tooltip.style.backgroundColor = [0, 0, 0, 0.9];
  tooltip.style.borderColor = [0.33, 0.33, 0.33, 0.5];
  tooltip.style.borderWidth = 1;
  tooltip.style.borderRadius = 4;
  const tooltipText = uiText("", 6, 3, { size: FONT_SIZE_SM });
  tooltip.addChild(tooltipText);
  root.addChild(tooltip);

  const swatches: UIPanel[] = [];
  for (let i = 0; i < MATERIAL_NAMES.length; i++) {
    const sw = new UIPanel(SWATCH, SWATCH);
    sw.x = (i % cols) * (SWATCH + GAP);
    sw.y = Math.floor(i / cols) * (SWATCH + GAP);
    sw.style.backgroundColor = matColor(i);
    sw.style.borderColor = [0.2, 0.2, 0.2, 0.5];
    sw.style.borderWidth = 1;
    sw.style.borderRadius = 3;
    const mat = i;
    sw.callbacks.onClick = () => s().setSelectedMaterial(mat);
    sw.callbacks.onHover = () => {
      tooltipText.setText(`${mat}: ${MATERIAL_NAMES[mat] ?? "Unknown"}`);
      tooltip.visible = true;
    };
    sw.callbacks.onHoverEnd = () => { tooltip.visible = false; };
    swatches.push(sw);
    swatchScroll.addChild(sw);
  }
  root.addChild(toolbar);

  // Selected swatch highlight — a bordered overlay repositioned in syncUI.
  const swatchHighlight = new UIPanel(SWATCH + 2, SWATCH + 2);
  swatchHighlight.pointerThrough = true;
  swatchHighlight.style.backgroundColor = [0, 0, 0, 0];
  swatchHighlight.style.borderColor = [...UI_COLORS.accent] as UIColor;
  swatchHighlight.style.borderWidth = 2;
  swatchHighlight.style.borderRadius = 4;
  swatchHighlight.visible = false;
  toolbar.addChild(swatchHighlight);

  // ══════════════════════════════════════════════════════════════════
  // Brush circle (follows mouse over canvas)
  // ══════════════════════════════════════════════════════════════════
  const brushCircle = new UILine();
  brushCircle.visible = false;
  brushCircle.lineWidth = 1.5;
  brushCircle.lineColor = [1, 1, 1, 0.6];
  root.addChild(brushCircle);

  // ══════════════════════════════════════════════════════════════════
  // Cell inspector (bottom-right)
  // ══════════════════════════════════════════════════════════════════
  const INS_W = 220;
  const INS_H = 200;
  const inspector = new UIPanel(INS_W, INS_H);
  inspector.name = "inspector";
  inspector.pointerThrough = true;
  applyPanelStyle(inspector);

  inspector.addChild(uiText("Cell Inspector", 10, 8, { bold: true }));
  const insHint = uiText("Hover over the grid", 10, 28, { dim: true, size: FONT_SIZE_SM });
  inspector.addChild(insHint);

  const insLabels = ["Position", "Material", "Lifetime", "Shade", "Gravity", "Temp", "Wind X", "Wind Y"];
  const insVals: UIText[] = [];
  for (let i = 0; i < insLabels.length; i++) {
    const y = 28 + i * 16;
    inspector.addChild(uiText(insLabels[i], 10, y, { dim: true, size: FONT_SIZE_SM }));
    const v = uiText("—", 90, y, { size: FONT_SIZE_SM });
    inspector.addChild(v);
    insVals.push(v);
  }
  root.addChild(inspector);

  // ══════════════════════════════════════════════════════════════════
  // Settings panel (top-right)
  // ══════════════════════════════════════════════════════════════════
  const SET_W = 280;
  const SET_H = 200;
  const settingsPanel = new UIPanel(SET_W, SET_H);
  settingsPanel.name = "settings-panel";
  settingsPanel.visible = false;
  applyPanelStyle(settingsPanel);

  settingsPanel.addChild(uiText("Impulse Settings", 12, 8, { bold: true }));

  const chanceSlider = uiSliderRow("Chance", 0, 0.2, 0.02, 240, (v) =>
    s().setSettings({ horizontalImpulseChance: v }));
  chanceSlider.row.x = 12; chanceSlider.row.y = 34;
  settingsPanel.addChild(chanceSlider.row);

  const forceSlider = uiSliderRow("Force", 0, 5, 1, 240, (v) =>
    s().setSettings({ horizontalImpulseStrength: v }));
  forceSlider.row.x = 12; forceSlider.row.y = 74;
  settingsPanel.addChild(forceSlider.row);

  settingsPanel.addChild(uiText("UI Font Scale", 12, 114, { bold: true }));

  const fontScaleSlider = uiSliderRow("Scale", 1, 2.5, loadUserFontScale() ?? 1, 240, (v) => {
    saveUserFontScale(v);
    setUIFontScale(ui.root, getEffectiveFontScale(v));
    ui.invalidate();
  });
  fontScaleSlider.row.x = 12; fontScaleSlider.row.y = 140;
  settingsPanel.addChild(fontScaleSlider.row);
  root.addChild(settingsPanel);

  // ══════════════════════════════════════════════════════════════════
  // Saves panel (top-right)
  // ══════════════════════════════════════════════════════════════════
  const SAVES_W = 360;
  const savesPanel = new UIPanel(SAVES_W, 60);
  savesPanel.name = "saves-panel";
  savesPanel.visible = false;
  applyPanelStyle(savesPanel);
  savesPanel.addChild(uiText("Saves", 12, 8, { bold: true }));
  const savesContent = new UIPanel(SAVES_W - 24, 0);
  savesContent.x = 12;
  savesContent.y = 32;
  savesContent.pointerThrough = true;
  savesContent.style.backgroundColor = [0, 0, 0, 0];
  savesContent.style.borderWidth = 0;
  savesPanel.addChild(savesContent);
  root.addChild(savesPanel);

  function rebuildSavesList(saves: SaveMetadata[]): void {
    savesContent.removeChildren();
    if (saves.length === 0) {
      savesPanel.height = 60;
      savesContent.addChild(uiText("No saves yet.", 0, 0, { dim: true, size: FONT_SIZE_SM }));
      return;
    }
    const entryH = 28;
    savesPanel.height = 40 + saves.length * entryH;
    for (let i = 0; i < saves.length; i++) {
      const save = saves[i];
      const row = new UIPanel(SAVES_W - 24, entryH);
      row.y = i * entryH;
      row.pointerThrough = true;
      row.style.backgroundColor = [0, 0, 0, 0];
      row.style.borderWidth = 0;
      row.addChild(uiText(save.name, 0, 0, { size: FONT_SIZE_SM }));
      row.addChild(uiText(
        `${new Date(save.timestamp).toLocaleString()} • ${save.gridW}×${save.gridH}`,
        0, 13, { dim: true, size: FONT_SIZE_SM - 1 }));
      const loadB = uiButton("Load", 50, 20, () => {}, { fontSize: FONT_SIZE_SM });
      loadB.x = 250;
      const saveId = save.id;
      loadB.callbacks.onClick = () => deps.onLoad(saveId);
      const delB = uiButton("Del", 40, 20, () => {}, { danger: true, fontSize: FONT_SIZE_SM });
      delB.x = 304;
      delB.callbacks.onClick = () => deps.onDeleteSave(saveId);
      row.addChild(loadB);
      row.addChild(delB);
      savesContent.addChild(row);
    }
  }
  ui.bind(useGameStore, (st) => st.saves, rebuildSavesList,
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id) });

  // ══════════════════════════════════════════════════════════════════
  // Help text (bottom-left)
  // ══════════════════════════════════════════════════════════════════
  const helpText = uiText(
    "WASD / Space • Left-click paint • Right-click ignite • Middle-click pick material",
    8, 0, { dim: true, size: FONT_SIZE_SM });
  root.addChild(helpText);

  // ══════════════════════════════════════════════════════════════════
  // Layout + per-frame sync
  // ══════════════════════════════════════════════════════════════════
  function layout(): void {
    const w = root.width;
    const h = root.height;
    toolbar.x = Math.round((w - toolbarW) / 2);
    toolbar.y = 8;
    inspector.x = w - INS_W - 8;
    inspector.y = h - INS_H - 8;
    settingsPanel.x = w - SET_W - 8;
    settingsPanel.y = 8;
    savesPanel.x = w - SAVES_W - 8;
    savesPanel.y = 8;
    helpText.y = h - 24;
  }
  layout();
  ui.onResize(() => { layout(); ui.invalidate(); });

  const pointerOverUI = () => ui.isPointerOverUI();

  ui.onUpdate(() => {
    const st = s();

    fpsText.setText(`FPS: ${st.fps ?? 0}`);
    healthText.setText(`Health: ${st.health}`);
    pausedText.visible = st.paused;

    uiButtonActive(matBtn, st.brushMode === "material", true);
    uiButtonActive(fieldBtn, st.brushMode === "field", true);

    matNameText.visible = st.brushMode === "material";
    matNameText.setText(`Material: ${MATERIAL_NAMES[st.selectedMaterial] ?? "Unknown"}`);
    fieldTypeRow.visible = st.brushMode === "field";
    fieldSlider.row.visible = st.brushMode === "field" &&
      (st.fieldType === "gravity" || st.fieldType === "temperature");
    showFieldsBtn.visible = st.brushMode === "field";
    uiButtonActive(showFieldsBtn, st.showFieldOverlay, true);

    for (let i = 0; i < 4; i++) {
      uiButtonActive(fieldTypeBtns[i], FIELD_TYPES[i] === st.fieldType, true);
    }
    if (st.brushMode === "field") {
      if (st.fieldType === "gravity") { fieldSlider.slider.minValue = 0; fieldSlider.slider.maxValue = 255; fieldSlider.slider.setValue(st.fieldGravity); fieldSlider.label.setText("Gravity"); }
      else if (st.fieldType === "temperature") { fieldSlider.slider.minValue = 0; fieldSlider.slider.maxValue = 255; fieldSlider.slider.setValue(st.fieldTemperature); fieldSlider.label.setText("Temp"); }
    }
    brushSlider.slider.setValue(st.brushRadius);

    toolbar.visible = st.brushMode === "material";
    if (toolbar.visible) {
      const i = st.selectedMaterial;
      swatchHighlight.visible = true;
      swatchHighlight.x = PAD + (i % cols) * (SWATCH + GAP) - 1;
      swatchHighlight.y = PAD + Math.floor(i / cols) * (SWATCH + GAP) - 1;
    } else {
      swatchHighlight.visible = false;
    }

    settingsPanel.visible = st.showSettings;
    if (settingsPanel.visible) {
      chanceSlider.slider.setValue(st.settings.horizontalImpulseChance);
      forceSlider.slider.setValue(st.settings.horizontalImpulseStrength);
    }
    savesPanel.visible = st.showSaves;

    // Inspector
    const ins = st.inspector;
    if (ins.valid) {
      insHint.visible = false;
      for (const v of insVals) v.visible = true;
      insVals[0].setText(`(${ins.gx}, ${ins.gy})`);
      insVals[1].setText(`${ins.mat}: ${ins.matName}`);
      insVals[2].setText(`${ins.lifetime}`);
      insVals[3].setText(`${ins.shade}/3`);
      insVals[4].setText(`${ins.gravityMult.toFixed(2)}× (${ins.gravity})`);
      insVals[5].setText(`${ins.temperatureMult.toFixed(2)} (${ins.temperature})`);
      insVals[6].setText(`${ins.windX}`);
      insVals[7].setText(`${ins.windY}`);
    } else {
      insHint.visible = true;
      for (const v of insVals) v.visible = false;
    }

    // Tooltip follows the pointer.
    const router = st.renderer?.getUIInputRouter();
    const [mx, my] = router?.getPointerPos() ?? [-1, -1];
    if (tooltip.visible) {
      tooltip.width = tooltipText.text.length * (FONT_SIZE_SM * 0.62) + 12;
      tooltip.height = 20;
      tooltip.x = mx + 14;
      tooltip.y = my + 14;
    }

    // Brush circle follows the pointer (canvas backing pixels).
    const r = st.renderer;
    const canvas = r?.getCanvas();
    if (mx < 0 || !r || !canvas || pointerOverUI()) {
      brushCircle.visible = false;
    } else {
      const cellSize = Math.min(canvas.width / r.getGridW(), canvas.height / r.getGridH());
      const radius = (st.brushRadius + 0.5) * cellSize;
      const segs: number[] = [];
      const N = 32;
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2;
        const a1 = ((i + 1) / N) * Math.PI * 2;
        segs.push(mx + Math.cos(a0) * radius, my + Math.sin(a0) * radius,
                  mx + Math.cos(a1) * radius, my + Math.sin(a1) * radius);
      }
      brushCircle.setSegments(segs);
      brushCircle.visible = true;
    }
  });
}
