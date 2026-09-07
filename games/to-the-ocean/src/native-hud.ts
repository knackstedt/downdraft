// ============================================================================
// native-hud.ts — IMUI-based HUD for the native to-the-ocean entry point
//
// Builds a game HUD using @downdraft/core's IMUI system (UIPanel, UIText,
// UIProgressBar, UISlider, UIButton, UIToggle) and updates it per frame
// with live sim state (health, hunger, thirst, position, FPS, weather, etc.).
//
// The HUD includes interactive elements (sliders, buttons, toggles) that
// update game state in real time, proving the IMUI both renders AND updates.
// ============================================================================

import {
    PLR, SimBufferReader,
    UIButton,
    UIPanel,
    UIProgressBar,
    UIRoot,
    UISlider,
    UIText,
    UIToggle,
    type UIColor,
    type UIInputRouter
} from "@downdraft/core";
import { useGameStore } from "./stores/game-store";

// ── Colors ──
const COL_BG: UIColor = [0.06, 0.08, 0.12, 0.85];
const COL_BG_DARK: UIColor = [0.04, 0.05, 0.08, 0.9];
const COL_BORDER: UIColor = [0.2, 0.3, 0.45, 0.8];
const COL_TEXT: UIColor = [0.85, 0.9, 1.0, 1.0];
const COL_TEXT_DIM: UIColor = [0.5, 0.55, 0.65, 0.9];
const COL_ACCENT: UIColor = [0.3, 0.6, 1.0, 1.0];
const COL_HEALTH: UIColor = [0.8, 0.2, 0.25, 1.0];
const COL_HUNGER: UIColor = [0.9, 0.6, 0.2, 1.0];
const COL_THIRST: UIColor = [0.2, 0.5, 0.9, 1.0];
const COL_OXYGEN: UIColor = [0.3, 0.8, 0.9, 1.0];
const COL_STAMINA: UIColor = [0.2, 0.8, 0.3, 1.0];

const FONT_SIZE = 14;
const FONT_SIZE_SM = 11;
const FONT_SIZE_LG = 18;

export interface NativeHudState {
  fps: number;
  frameCount: number;
  // Toggled by button clicks — proves UI interactivity
  showStats: boolean;
  showControls: boolean;
  // Slider-controlled values — proves UI updates
  timeScale: number;
  fovOverride: number;
  enableFpsCap: boolean;
  fpsCap: number;
}

export class NativeHud {
  private root: UIRoot;
  private inputRouter: UIInputRouter;
  private simReader: SimBufferReader | null = null;

  // Top-left status panel
  statusPanel: UIPanel;
  private fpsText: UIText;
  private posText: UIText;
  private headingText: UIText;
  private tickText: UIText;
  private entityText: UIText;
  private weatherText: UIText;
  private timeText: UIText;

  // Bottom-left vitals panel
  vitalsPanel: UIPanel;
  private healthBar: UIProgressBar;
  private healthLabel: UIText;
  private hungerBar: UIProgressBar;
  private hungerLabel: UIText;
  private thirstBar: UIProgressBar;
  private thirstLabel: UIText;
  private oxygenBar: UIProgressBar;
  private oxygenLabel: UIText;

  // Top-right controls panel
  controlsPanel: UIPanel;
  statsButton: UIButton;
  private controlsButton: UIButton;
  private timeScaleSlider: UISlider;
  private timeScaleLabel: UIText;
  private timeScaleValue: UIText;
  private fpsCapToggle: UIToggle;
  private fpsCapLabel: UIText;
  private fpsCapSlider: UISlider;
  private fpsCapValue: UIText;
  private screenshotButton: UIButton;
  private exitButton: UIButton;

  // Bottom-center crosshair
  private crosshairPanel: UIPanel;

  // Bottom-right controls help
  private helpPanel: UIPanel;
  private helpText: UIText;

  // Overlay panels (shown/hidden via keyboard shortcuts)
  private inventoryPanel: UIPanel;
  private craftPanel: UIPanel;
  private mapPanel: UIPanel;
  private buildPanel: UIPanel;
  private pausePanel: UIPanel;
  private settingsPanel: UIPanel;
  private settingsBackBtn: UIButton;
  // Settings state
  private settingsFovSlider: UISlider;
  private settingsFovValue: UIText;
  private settingsMouseSensSlider: UISlider;
  private settingsMouseSensValue: UIText;
  private settingsVsyncToggle: UIToggle;
  private settingsShowHudToggle: UIToggle;
  private settingsShowFpsToggle: UIToggle;

  state: NativeHudState;

  constructor(root: UIRoot, inputRouter: UIInputRouter) {
    this.root = root;
    this.inputRouter = inputRouter;
    this.state = {
      fps: 0,
      frameCount: 0,
      showStats: true,
      showControls: true,
      timeScale: 1.0,
      fovOverride: 70,
      enableFpsCap: false,
      fpsCap: 60,
    };

    this.statusPanel = this.createStatusPanel();
    this.vitalsPanel = this.createVitalsPanel();
    this.controlsPanel = this.createControlsPanel();
    this.crosshairPanel = this.createCrosshair();
    this.helpPanel = this.createHelpPanel();
    this.inventoryPanel = this.createInventoryPanel();
    this.craftPanel = this.createCraftPanel();
    this.mapPanel = this.createMapPanel();
    this.buildPanel = this.createBuildPanel();
    this.pausePanel = this.createPausePanel();
    this.settingsPanel = this.createSettingsPanel();

    this.root.addChild(this.statusPanel);
    this.root.addChild(this.vitalsPanel);
    this.root.addChild(this.controlsPanel);
    this.root.addChild(this.crosshairPanel);
    this.root.addChild(this.helpPanel);
    this.root.addChild(this.inventoryPanel);
    this.root.addChild(this.craftPanel);
    this.root.addChild(this.mapPanel);
    this.root.addChild(this.buildPanel);
    this.root.addChild(this.pausePanel);
    this.root.addChild(this.settingsPanel);
  }

  setSimReader(reader: SimBufferReader): void {
    this.simReader = reader;
  }

  // ── Status panel (top-left) ──
  private createStatusPanel(): UIPanel {
    const panel = new UIPanel(280, 180);
    panel.x = 10; panel.y = 10;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 1;
    panel.style.borderRadius = 6;

    const title = new UIText("TO THE OCEAN — Native", 260, 20);
    title.x = 10; title.y = 6;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(260, 1);
    sep.x = 10; sep.y = 30;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    this.fpsText = this.makeLabel("FPS: --", 10, 38);
    this.posText = this.makeLabel("Pos: (0, 0, 0)", 10, 54);
    this.headingText = this.makeLabel("Heading: 0  Pitch: 0", 10, 70);
    this.tickText = this.makeLabel("Tick: 0", 10, 86);
    this.entityText = this.makeLabel("Entities: 0", 10, 102);
    this.weatherText = this.makeLabel("Weather: Clear", 10, 118);
    this.timeText = this.makeLabel("Time: 06:00", 10, 134);

    panel.addChild(this.fpsText);
    panel.addChild(this.posText);
    panel.addChild(this.headingText);
    panel.addChild(this.tickText);
    panel.addChild(this.entityText);
    panel.addChild(this.weatherText);
    panel.addChild(this.timeText);

    return panel;
  }

  // ── Vitals panel (bottom-left) ──
  private createVitalsPanel(): UIPanel {
    const panel = new UIPanel(240, 150);
    panel.x = 10; panel.y = 560;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 1;
    panel.style.borderRadius = 6;

    const title = new UIText("VITALS", 220, 16);
    title.x = 10; title.y = 6;
    title.style.fontSize = FONT_SIZE;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    // Health
    this.healthLabel = this.makeLabel("Health", 10, 28, FONT_SIZE_SM, COL_TEXT_DIM);
    this.healthBar = new UIProgressBar(220, 12);
    this.healthBar.x = 10; this.healthBar.y = 42;
    this.healthBar.barColor = COL_HEALTH;
    this.healthBar.trackColor = [0.15, 0.08, 0.08, 0.8];
    this.healthBar.style.borderRadius = 3;
    panel.addChild(this.healthLabel);
    panel.addChild(this.healthBar);

    // Hunger
    this.hungerLabel = this.makeLabel("Hunger", 10, 60, FONT_SIZE_SM, COL_TEXT_DIM);
    this.hungerBar = new UIProgressBar(220, 12);
    this.hungerBar.x = 10; this.hungerBar.y = 74;
    this.hungerBar.barColor = COL_HUNGER;
    this.hungerBar.trackColor = [0.15, 0.12, 0.08, 0.8];
    this.hungerBar.style.borderRadius = 3;
    panel.addChild(this.hungerLabel);
    panel.addChild(this.hungerBar);

    // Thirst
    this.thirstLabel = this.makeLabel("Thirst", 10, 92, FONT_SIZE_SM, COL_TEXT_DIM);
    this.thirstBar = new UIProgressBar(220, 12);
    this.thirstBar.x = 10; this.thirstBar.y = 106;
    this.thirstBar.barColor = COL_THIRST;
    this.thirstBar.trackColor = [0.08, 0.1, 0.15, 0.8];
    this.thirstBar.style.borderRadius = 3;
    panel.addChild(this.thirstLabel);
    panel.addChild(this.thirstBar);

    // Oxygen
    this.oxygenLabel = this.makeLabel("Oxygen", 10, 124, FONT_SIZE_SM, COL_TEXT_DIM);
    this.oxygenBar = new UIProgressBar(220, 12);
    this.oxygenBar.x = 10; this.oxygenBar.y = 138;
    this.oxygenBar.barColor = COL_OXYGEN;
    this.oxygenBar.trackColor = [0.08, 0.12, 0.15, 0.8];
    this.oxygenBar.style.borderRadius = 3;
    // Oxygen bar is hidden unless underwater — start hidden
    this.oxygenLabel.visible = false;
    this.oxygenBar.visible = false;
    panel.addChild(this.oxygenLabel);
    panel.addChild(this.oxygenBar);

    return panel;
  }

  // ── Controls panel (top-right) ──
  private createControlsPanel(): UIPanel {
    const panel = new UIPanel(260, 290);
    panel.x = 1010; panel.y = 10;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 1;
    panel.style.borderRadius = 6;

    const title = new UIText("CONTROLS", 240, 20);
    title.x = 10; title.y = 6;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(240, 1);
    sep.x = 10; sep.y = 30;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    // Toggle buttons
    this.statsButton = new UIButton("Hide Stats", 110, 24);
    this.statsButton.x = 10; this.statsButton.y = 38;
    this.statsButton.style.fontSize = FONT_SIZE_SM;
    this.statsButton.style.fontFamily = "sans-serif";
    this.statsButton.callbacks.onClick = () => {
      this.state.showStats = !this.state.showStats;
      this.statsButton.setLabel(this.state.showStats ? "Hide Stats" : "Show Stats");
      this.statusPanel.visible = this.state.showStats;
      this.vitalsPanel.visible = this.state.showStats;
    };
    panel.addChild(this.statsButton);

    this.controlsButton = new UIButton("Hide Help", 110, 24);
    this.controlsButton.x = 130; this.controlsButton.y = 38;
    this.controlsButton.style.fontSize = FONT_SIZE_SM;
    this.controlsButton.style.fontFamily = "sans-serif";
    this.controlsButton.callbacks.onClick = () => {
      this.state.showControls = !this.state.showControls;
      this.controlsButton.setLabel(this.state.showControls ? "Hide Help" : "Show Help");
      this.helpPanel.visible = this.state.showControls;
    };
    panel.addChild(this.controlsButton);

    // Time scale slider
    this.timeScaleLabel = this.makeLabel("Time Scale", 10, 70, FONT_SIZE_SM, COL_TEXT_DIM);
    this.timeScaleValue = this.makeLabel("1.0x", 200, 70, FONT_SIZE_SM, COL_ACCENT);
    this.timeScaleSlider = new UISlider(240, 20);
    this.timeScaleSlider.x = 10; this.timeScaleSlider.y = 84;
    this.timeScaleSlider.minValue = 0.1;
    this.timeScaleSlider.maxValue = 5.0;
    this.timeScaleSlider.value = 1.0;
    this.timeScaleSlider.onValueChange = (v: number) => {
      this.state.timeScale = v;
    };
    panel.addChild(this.timeScaleLabel);
    panel.addChild(this.timeScaleValue);
    panel.addChild(this.timeScaleSlider);

    // FPS cap toggle
    this.fpsCapLabel = this.makeLabel("FPS Cap", 10, 112, FONT_SIZE_SM, COL_TEXT_DIM);
    this.fpsCapToggle = new UIToggle(40, 20);
    this.fpsCapToggle.x = 10; this.fpsCapToggle.y = 126;
    this.fpsCapToggle.checked = false;
    this.fpsCapToggle.label = "Enable";
    this.fpsCapToggle.onToggle = (checked: boolean) => {
      this.state.enableFpsCap = checked;
      this.fpsCapSlider.visible = checked;
      this.fpsCapValue.visible = checked;
    };
    panel.addChild(this.fpsCapLabel);
    panel.addChild(this.fpsCapToggle);

    // FPS cap slider
    this.fpsCapValue = this.makeLabel("60", 200, 126, FONT_SIZE_SM, COL_ACCENT);
    this.fpsCapSlider = new UISlider(240, 20);
    this.fpsCapSlider.x = 10; this.fpsCapSlider.y = 150;
    this.fpsCapSlider.minValue = 30;
    this.fpsCapSlider.maxValue = 240;
    this.fpsCapSlider.value = 60;
    this.fpsCapSlider.visible = false;
    this.fpsCapValue.visible = false;
    this.fpsCapSlider.onValueChange = (v: number) => {
      this.state.fpsCap = Math.round(v);
    };
    panel.addChild(this.fpsCapValue);
    panel.addChild(this.fpsCapSlider);

    // Action buttons
    this.screenshotButton = new UIButton("Screenshot (F12)", 115, 28);
    this.screenshotButton.x = 10; this.screenshotButton.y = 182;
    this.screenshotButton.style.fontSize = FONT_SIZE_SM;
    this.screenshotButton.style.fontFamily = "sans-serif";
    this.screenshotButton.callbacks.onClick = () => {
      // Dispatch a synthetic F12 keydown
      (globalThis as any).window?.dispatchEvent?.(new Event("keydown"));
    };
    panel.addChild(this.screenshotButton);

    this.exitButton = new UIButton("Exit", 115, 28);
    this.exitButton.x = 135; this.exitButton.y = 182;
    this.exitButton.style.fontSize = FONT_SIZE_SM;
    this.exitButton.style.fontFamily = "sans-serif";
    this.exitButton.style.backgroundColor = [0.3, 0.12, 0.12, 0.95];
    this.exitButton.style.borderColor = [0.6, 0.2, 0.2, 1.0];
    this.exitButton.callbacks.onClick = () => {
      // Dispatch ESC — the native entry handles this
      (globalThis as any).__nativeExit?.();
    };
    panel.addChild(this.exitButton);

    // Info text
    const infoText = this.makeLabel("Click + drag sliders to adjust", 10, 220, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(infoText);
    const infoText2 = this.makeLabel("Mouse: look | WASD: move", 10, 236, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(infoText2);
    const infoText3 = this.makeLabel("Space: up | Shift: down", 10, 252, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(infoText3);
    const infoText4 = this.makeLabel("F1: freecam | F5: 3rd person | V: cycle cam", 10, 268, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(infoText4);

    return panel;
  }

  // ── Crosshair (center) ──
  private createCrosshair(): UIPanel {
    const panel = new UIPanel(8, 8);
    panel.x = 636; panel.y = 356; // center of 1280x720
    panel.style.backgroundColor = [1, 1, 1, 0.6];
    panel.style.borderRadius = 4;
    panel.style.borderWidth = 0;
    return panel;
  }

  // ── Help panel (bottom-right) ──
  private createHelpPanel(): UIPanel {
    const panel = new UIPanel(220, 240);
    panel.x = 1050; panel.y = 470;
    panel.style.backgroundColor = COL_BG_DARK;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 1;
    panel.style.borderRadius = 6;

    const title = this.makeLabel("CONTROLS", 10, 6, FONT_SIZE, COL_ACCENT);
    panel.addChild(title);

    const lines = [
      "WASD - Move",
      "Mouse - Look",
      "Space - Up/Jump",
      "Shift - Down/Run",
      "V - Cycle Camera",
      "F1 - Freecam",
      "F5 - 3rd Person",
      "I - Inventory",
      "Tab - Crafting",
      "M - Map",
      "B - Build",
      "C - Character",
      "P - Pause",
      "F12 - Screenshot",
      "ESC - Pause/Unlock",
    ];
    let y = 24;
    for (const line of lines) {
      const t = this.makeLabel(line, 10, y, FONT_SIZE_SM, COL_TEXT);
      panel.addChild(t);
      y += 14;
    }

    return panel;
  }

  // ── Overlay panels (toggled by keyboard shortcuts) ──

  private createInventoryPanel(): UIPanel {
    const w = 400, h = 360;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("INVENTORY", w - 40, 24);
    title.x = 16; title.y = 8;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(w - 40, 1);
    sep.x = 16; sep.y = 34;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    const empty = this.makeLabel("Inventory is empty", 16, 48, FONT_SIZE, COL_TEXT_DIM);
    panel.addChild(empty);

    const hint = this.makeLabel("Press I to close", 16, h - 28, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(hint);

    return panel;
  }

  private createCraftPanel(): UIPanel {
    const w = 400, h = 420;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("CRAFTING", w - 40, 24);
    title.x = 16; title.y = 8;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(w - 40, 1);
    sep.x = 16; sep.y = 34;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    const empty = this.makeLabel("No recipes available", 16, 48, FONT_SIZE, COL_TEXT_DIM);
    panel.addChild(empty);

    const hint = this.makeLabel("Press Tab to close", 16, h - 28, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(hint);

    return panel;
  }

  private createMapPanel(): UIPanel {
    const w = 600, h = 480;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG_DARK;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("MAP", w - 40, 24);
    title.x = 16; title.y = 8;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const hint = this.makeLabel("Press M to close", 16, h - 28, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(hint);

    return panel;
  }

  private createBuildPanel(): UIPanel {
    const w = 360, h = 400;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("BUILD", w - 40, 24);
    title.x = 16; title.y = 8;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const hint = this.makeLabel("Press B to close", 16, h - 28, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(hint);

    return panel;
  }

  private createPausePanel(): UIPanel {
    const w = 260, h = 360;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("PAUSED", w - 40, 28);
    title.x = 16; title.y = 14;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(w - 40, 1);
    sep.x = 16; sep.y = 44;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    // Resume button
    const resumeBtn = new UIButton("Resume", w - 40, 34);
    resumeBtn.x = 20; resumeBtn.y = 58;
    resumeBtn.style.fontSize = FONT_SIZE;
    resumeBtn.style.fontFamily = "sans-serif";
    resumeBtn.callbacks.onClick = () => {
      useGameStore.getState().togglePauseMenu();
    };
    panel.addChild(resumeBtn);

    // Settings button
    const settingsBtn = new UIButton("Settings", w - 40, 34);
    settingsBtn.x = 20; settingsBtn.y = 98;
    settingsBtn.style.fontSize = FONT_SIZE;
    settingsBtn.style.fontFamily = "sans-serif";
    settingsBtn.callbacks.onClick = () => {
      useGameStore.getState().toggleSettings();
    };
    panel.addChild(settingsBtn);

    // Screenshot button
    const ssBtn = new UIButton("Screenshot (F12)", w - 40, 34);
    ssBtn.x = 20; ssBtn.y = 138;
    ssBtn.style.fontSize = FONT_SIZE;
    ssBtn.style.fontFamily = "sans-serif";
    ssBtn.callbacks.onClick = () => {
      (globalThis as any).__nativeScreenshot?.();
    };
    panel.addChild(ssBtn);

    // Exit button
    const exitBtn = new UIButton("Exit Game", w - 40, 34);
    exitBtn.x = 20; exitBtn.y = 178;
    exitBtn.style.fontSize = FONT_SIZE;
    exitBtn.style.fontFamily = "sans-serif";
    exitBtn.style.backgroundColor = [0.3, 0.12, 0.12, 0.95];
    exitBtn.style.borderColor = [0.6, 0.2, 0.2, 1.0];
    exitBtn.callbacks.onClick = () => {
      (globalThis as any).__nativeExit?.();
    };
    panel.addChild(exitBtn);

    // Info
    const info = this.makeLabel("ESC or P to resume", 16, h - 28, FONT_SIZE_SM, COL_TEXT_DIM);
    panel.addChild(info);

    return panel;
  }

  private createSettingsPanel(): UIPanel {
    const w = 320, h = 380;
    const panel = new UIPanel(w, h);
    panel.x = (1280 - w) / 2;
    panel.y = (720 - h) / 2;
    panel.style.backgroundColor = COL_BG;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 2;
    panel.style.borderRadius = 8;
    panel.visible = false;

    const title = new UIText("SETTINGS", w - 40, 28);
    title.x = 16; title.y = 14;
    title.style.fontSize = FONT_SIZE_LG;
    title.style.textColor = COL_ACCENT;
    title.style.fontFamily = "sans-serif";
    panel.addChild(title);

    const sep = new UIPanel(w - 40, 1);
    sep.x = 16; sep.y = 44;
    sep.style.backgroundColor = COL_BORDER;
    sep.style.borderWidth = 0;
    panel.addChild(sep);

    // FOV slider
    const fovLabel = this.makeLabel("Field of View", 20, 60, FONT_SIZE, COL_TEXT);
    panel.addChild(fovLabel);
    this.settingsFovSlider = new UISlider(w - 80, 20);
    this.settingsFovSlider.x = 20; this.settingsFovSlider.y = 80;
    this.settingsFovSlider.minValue = 60;
    this.settingsFovSlider.maxValue = 120;
    this.settingsFovSlider.value = this.state.fovOverride;
    panel.addChild(this.settingsFovSlider);
    this.settingsFovValue = this.makeLabel(`${this.state.fovOverride}`, w - 50, 60, FONT_SIZE, COL_TEXT_DIM);
    panel.addChild(this.settingsFovValue);

    // Mouse sensitivity slider
    const sensLabel = this.makeLabel("Mouse Sensitivity", 20, 115, FONT_SIZE, COL_TEXT);
    panel.addChild(sensLabel);
    this.settingsMouseSensSlider = new UISlider(w - 80, 20);
    this.settingsMouseSensSlider.x = 20; this.settingsMouseSensSlider.y = 135;
    this.settingsMouseSensSlider.minValue = 0.1;
    this.settingsMouseSensSlider.maxValue = 3.0;
    this.settingsMouseSensSlider.value = 1.0;
    panel.addChild(this.settingsMouseSensSlider);
    this.settingsMouseSensValue = this.makeLabel("1.0", w - 50, 115, FONT_SIZE, COL_TEXT_DIM);
    panel.addChild(this.settingsMouseSensValue);

    // VSync toggle
    this.settingsVsyncToggle = new UIToggle(200, 20);
    this.settingsVsyncToggle.label = "VSync";
    this.settingsVsyncToggle.checked = false;
    this.settingsVsyncToggle.x = 20; this.settingsVsyncToggle.y = 180;
    this.settingsVsyncToggle.style.fontSize = FONT_SIZE;
    this.settingsVsyncToggle.style.fontFamily = "sans-serif";
    panel.addChild(this.settingsVsyncToggle);

    // Show HUD toggle
    this.settingsShowHudToggle = new UIToggle(200, 20);
    this.settingsShowHudToggle.label = "Show HUD";
    this.settingsShowHudToggle.checked = true;
    this.settingsShowHudToggle.x = 20; this.settingsShowHudToggle.y = 215;
    this.settingsShowHudToggle.style.fontSize = FONT_SIZE;
    this.settingsShowHudToggle.style.fontFamily = "sans-serif";
    panel.addChild(this.settingsShowHudToggle);

    // Show FPS toggle
    this.settingsShowFpsToggle = new UIToggle(200, 20);
    this.settingsShowFpsToggle.label = "Show FPS";
    this.settingsShowFpsToggle.checked = true;
    this.settingsShowFpsToggle.x = 20; this.settingsShowFpsToggle.y = 250;
    this.settingsShowFpsToggle.style.fontSize = FONT_SIZE;
    this.settingsShowFpsToggle.style.fontFamily = "sans-serif";
    panel.addChild(this.settingsShowFpsToggle);

    // Back button
    this.settingsBackBtn = new UIButton("Back", w - 40, 34);
    this.settingsBackBtn.x = 20; this.settingsBackBtn.y = h - 52;
    this.settingsBackBtn.style.fontSize = FONT_SIZE;
    this.settingsBackBtn.style.fontFamily = "sans-serif";
    this.settingsBackBtn.callbacks.onClick = () => {
      useGameStore.getState().toggleSettings();
    };
    panel.addChild(this.settingsBackBtn);

    return panel;
  }

  private makeLabel(text: string, x: number, y: number, fontSize: number = FONT_SIZE_SM, color: UIColor = COL_TEXT): UIText {
    const label = new UIText(text, 200, fontSize + 4);
    label.x = x; label.y = y;
    label.style.fontSize = fontSize;
    label.style.textColor = color;
    label.style.fontFamily = "sans-serif";
    return label;
  }

  // ── Per-frame update ──
  update(dt: number): void {
    const s = this.state;

    // Sync overlay panels with the game store state (toggled by keyboard
    // shortcuts wired in native-entry.ts).
    const gs = useGameStore.getState();
    if (this.inventoryPanel.visible !== gs.showInventory) this.inventoryPanel.visible = gs.showInventory;
    if (this.craftPanel.visible !== gs.showCraftMenu) this.craftPanel.visible = gs.showCraftMenu;
    if (this.mapPanel.visible !== gs.showMap) this.mapPanel.visible = gs.showMap;
    if (this.buildPanel.visible !== gs.showBuildMenu) this.buildPanel.visible = gs.showBuildMenu;
    if (this.pausePanel.visible !== gs.showPauseMenu) this.pausePanel.visible = gs.showPauseMenu;
    if (this.settingsPanel.visible !== gs.showSettings) this.settingsPanel.visible = gs.showSettings;

    // Apply settings
    this.state.fovOverride = Math.round(this.settingsFovSlider.value);
    this.settingsFovValue.setText(`${this.state.fovOverride}`);
    const sens = this.settingsMouseSensSlider.value;
    this.settingsMouseSensValue.setText(`${sens.toFixed(1)}`);
    (globalThis as any).__nativeMouseSens = sens;

    // Show/hide HUD elements based on settings
    const showHud = this.settingsShowHudToggle.checked;
    this.statusPanel.visible = showHud && this.state.showStats;
    this.vitalsPanel.visible = showHud;
    this.controlsPanel.visible = showHud && this.state.showControls;
    this.helpPanel.visible = showHud;
    this.crosshairPanel.visible = showHud;

    // FPS text visibility
    this.fpsText.visible = this.settingsShowFpsToggle.checked;

    // Update slider value labels
    s.timeScale = this.timeScaleSlider.value;
    s.fpsCap = Math.round(this.fpsCapSlider.value);
    s.enableFpsCap = this.fpsCapToggle.checked;
    this.timeScaleValue.setText(`${s.timeScale.toFixed(1)}x`);
    this.fpsCapValue.setText(`${s.fpsCap}`);

    // Update status panel
    this.fpsText.setText(`FPS: ${s.fps}`);
    this.tickText.setText(`Tick: ${this.simReader?.getTick() ?? 0}`);
    this.entityText.setText(`Entities: ${this.simReader?.getEntityCount() ?? 0}`);

    // Weather
    const wt = this.simReader?.getWeatherType() ?? 0;
    const weatherNames = ["Clear", "Cloudy", "Rain", "Storm", "Fog", "Snow", "HellStorm"];
    this.weatherText.setText(`Weather: ${weatherNames[wt] ?? wt}`);

    // Time of day
    const tod = this.simReader?.getTimeOfDay() ?? 6;
    const hours = Math.floor(tod) % 24;
    const mins = Math.floor((tod % 1) * 60);
    this.timeText.setText(`Time: ${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`);

    // Player data
    if (this.simReader && this.simReader.isValid()) {
      const ps0 = this.simReader.getPlayerSlot(0);
      if (ps0) {
        const px = ps0.f32[PLR.POS_X];
        const py = ps0.f32[PLR.POS_Y];
        const pz = ps0.f32[PLR.POS_Z];
        const hdg = ps0.f32[PLR.HEADING];
        const pch = ps0.f32[PLR.PITCH] ?? 0;
        this.posText.setText(`Pos: (${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)})`);
        this.headingText.setText(`Heading: ${(hdg * 180 / Math.PI).toFixed(0)}  Pitch: ${(pch * 180 / Math.PI).toFixed(0)}`);

        // Vitals
        const health = ps0.f32[PLR.HEALTH];
        const maxHealth = ps0.f32[PLR.MAX_HEALTH];
        const hunger = ps0.f32[PLR.HUNGER];
        const thirst = ps0.f32[PLR.THIRST];
        const oxygen = ps0.f32[PLR.OXYGEN];
        const maxOxygen = ps0.f32[PLR.MAX_OXYGEN];

        this.healthBar.maxValue = maxHealth || 100;
        this.healthBar.setValue(health);
        this.healthBar.showLabel = true;
        this.healthBar.label = `${Math.round(health)}/${Math.round(maxHealth || 100)}`;

        this.hungerBar.maxValue = 100;
        this.hungerBar.setValue(hunger * 100);
        this.hungerBar.showLabel = true;
        this.hungerBar.label = `${Math.round(hunger * 100)}%`;

        this.thirstBar.maxValue = 100;
        this.thirstBar.setValue(thirst * 100);
        this.thirstBar.showLabel = true;
        this.thirstBar.label = `${Math.round(thirst * 100)}%`;

        // Oxygen — only show if underwater (below max)
        const showOxygen = oxygen < (maxOxygen || 100) - 0.5;
        this.oxygenBar.visible = showOxygen;
        this.oxygenLabel.visible = showOxygen;
        if (showOxygen) {
          this.oxygenBar.maxValue = maxOxygen || 100;
          this.oxygenBar.setValue(oxygen);
          this.oxygenBar.showLabel = true;
          this.oxygenBar.label = `${Math.round(oxygen)}`;
        }
      }
    }
  }

  getRoot(): UIRoot { return this.root; }
}
