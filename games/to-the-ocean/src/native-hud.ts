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

    this.root.addChild(this.statusPanel);
    this.root.addChild(this.vitalsPanel);
    this.root.addChild(this.controlsPanel);
    this.root.addChild(this.crosshairPanel);
    this.root.addChild(this.helpPanel);
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
    title.style.fontFamily = ""; // use glyph atlas
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
    title.style.fontFamily = "";
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
    title.style.fontFamily = "";
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
    this.statsButton.style.fontFamily = "";
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
    this.controlsButton.style.fontFamily = "";
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
    this.screenshotButton.style.fontFamily = "";
    this.screenshotButton.callbacks.onClick = () => {
      // Dispatch a synthetic F12 keydown
      (globalThis as any).window?.dispatchEvent?.(new Event("keydown"));
    };
    panel.addChild(this.screenshotButton);

    this.exitButton = new UIButton("Exit (ESC)", 115, 28);
    this.exitButton.x = 135; this.exitButton.y = 182;
    this.exitButton.style.fontSize = FONT_SIZE_SM;
    this.exitButton.style.fontFamily = "";
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
    const infoText4 = this.makeLabel("F1: freecam | F5: 3rd person", 10, 268, FONT_SIZE_SM, COL_TEXT_DIM);
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
    const panel = new UIPanel(220, 120);
    panel.x = 1050; panel.y = 590;
    panel.style.backgroundColor = COL_BG_DARK;
    panel.style.borderColor = COL_BORDER;
    panel.style.borderWidth = 1;
    panel.style.borderRadius = 6;

    const title = this.makeLabel("CONTROLS", 10, 6, FONT_SIZE, COL_ACCENT);
    panel.addChild(title);

    const lines = [
      "WASD - Move",
      "Mouse - Look",
      "Space - Up",
      "Shift - Down",
      "F12 - Screenshot",
      "ESC - Exit",
    ];
    let y = 24;
    for (const line of lines) {
      const t = this.makeLabel(line, 10, y, FONT_SIZE_SM, COL_TEXT);
      panel.addChild(t);
      y += 14;
    }

    return panel;
  }

  private makeLabel(text: string, x: number, y: number, fontSize: number = FONT_SIZE_SM, color: UIColor = COL_TEXT): UIText {
    const label = new UIText(text, 200, fontSize + 2);
    label.x = x; label.y = y;
    label.style.fontSize = fontSize;
    label.style.textColor = color;
    label.style.fontFamily = ""; // force glyph atlas path
    return label;
  }

  // ── Per-frame update ──
  update(dt: number): void {
    const s = this.state;

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
