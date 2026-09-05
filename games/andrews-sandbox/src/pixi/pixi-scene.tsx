// ============================================================================
// Andrew's Sandbox pixi-scene — direct PixiJS scene (no @pixi/react for now).
// Will be migrated to @pixi/react in Phase 7 when UI is fully built out.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, PixiUiUpdateData } from "@downdraft/library-pixi-ui";
import { FunMode, ToolType } from "@sandbox/shared/types";
import { Container, Graphics, Text, type Application } from "pixi.js";
import type { ContentListItem, SandboxAction } from "./bridge-protocol";

export default async function createSandboxScene(ctx: PixiUiSceneContext): Promise<PixiUiScene> {
  const app: Application = ctx.app;
  const root = new Container();
  app.stage.addChild(root);

  // UI state
  let showBrowser = true;
  let showToolWheel = false;
  let showPaintPalette = false;
  let activeTool = ToolType.Physgun;
  let funMode = FunMode.Normal;
  let contentItems: ContentListItem[] = [];
  let fps = 0;
  let propCount = 0;

  // UI elements
  const fpsText = new Text({ text: "FPS: 0  Props: 0", style: { fill: 0xffffff, fontSize: 14, fontFamily: "Montserrat" } });
  fpsText.x = 10; fpsText.y = 10;
  root.addChild(fpsText);

  const browserPanel = new Container();
  browserPanel.x = 10; browserPanel.y = 50;
  root.addChild(browserPanel);

  const toolWheelPanel = new Container();
  root.addChild(toolWheelPanel);

  const paintPalettePanel = new Container();
  root.addChild(paintPalettePanel);

  const funModePanel = new Container();
  funModePanel.x = 800; funModePanel.y = 10;
  root.addChild(funModePanel);

  // Graphics settings panel
  const graphicsPanel = new Container();
  graphicsPanel.x = 550; graphicsPanel.y = 50;
  graphicsPanel.visible = false;
  root.addChild(graphicsPanel);

  // Graphics settings state (mirrored from stats)
  let showGraphics = false;
  let gfxBloom = true;
  let gfxBloomStrength = 0.6;
  let gfxBloomThreshold = 0.85;
  let gfxFXAA = true;
  let gfxTonemap = true;
  let gfxExposure = 1.1;
  let gfxVignette = true;
  let gfxVignetteStrength = 0.25;
  let gfxShadows = true;
  let gfxMipmaps = true;
  let gfxPointLights = true;
  let gfxSunR = 1.0;
  let gfxSunG = 0.95;
  let gfxSunB = 0.85;
  let gfxAmbient = 0.4;

  const helpText = new Text({ text: "[F5] Save  [F9] Load  [Q] Tools  [B] Browser  [F6] Graphics", style: { fill: 0xaaaaaa, fontSize: 12, fontFamily: "Montserrat" } });
  helpText.x = 10; helpText.y = (app.renderer.height ?? 720) - 30;
  root.addChild(helpText);

  const postAction = (action: SandboxAction) => ctx.postAction(action);

  function rebuildBrowser(): void {
    browserPanel.removeChildren();
    const bg = new Graphics();
    bg.rect(0, 0, 250, 400);
    bg.fill({ color: 0x141428, alpha: 0.85 });
    bg.stroke({ color: 0x4e9af1, width: 2 });
    browserPanel.addChild(bg);

    const title = new Text({ text: "Content Browser [B]", style: { fill: 0x4e9af1, fontSize: 16, fontFamily: "Montserrat" } });
    title.x = 10; title.y = 8;
    browserPanel.addChild(title);

    if (contentItems.length === 0) {
      const empty = new Text({ text: "No content loaded.\nDrop GLB/PNG files or add plugins.", style: { fill: 0x888888, fontSize: 12, fontFamily: "Montserrat" } });
      empty.x = 10; empty.y = 40;
      browserPanel.addChild(empty);
    } else {
      contentItems.forEach((item, i) => {
        const entry = new Text({ text: `[${item.category}] ${item.name}`, style: { fill: 0xe0e0e0, fontSize: 13, fontFamily: "Montserrat" } });
        entry.x = 10; entry.y = 40 + i * 22;
        entry.eventMode = "static";
        entry.onclick = () => postAction({ kind: "spawn", contentId: item.id });
        browserPanel.addChild(entry);
      });
    }
  }

  function rebuildToolWheel(): void {
    toolWheelPanel.removeChildren();
    if (!showToolWheel) return;
    const tools = [
      { tool: ToolType.Physgun, label: "Physgun", x: 400, y: 220 },
      { tool: ToolType.Toolgun, label: "Toolgun", x: 480, y: 300 },
      { tool: ToolType.Pistol, label: "Pistol", x: 400, y: 380 },
      { tool: ToolType.Paintgun, label: "Paintgun", x: 320, y: 300 },
    ];
    for (const t of tools) {
      const txt = new Text({ text: t.label, style: { fill: t.tool === activeTool ? 0x4e9af1 : 0xe0e0e0, fontSize: 16, fontFamily: "Montserrat" } });
      txt.x = t.x; txt.y = t.y;
      txt.eventMode = "static";
      txt.onclick = () => postAction({ kind: "setTool", tool: t.tool });
      toolWheelPanel.addChild(txt);
    }
  }

  function rebuildPaintPalette(): void {
    paintPalettePanel.removeChildren();
    if (!showPaintPalette) return;
    paintPalettePanel.x = 300; paintPalettePanel.y = 600;

    const bg = new Graphics();
    bg.rect(0, 0, 300, 60);
    bg.fill({ color: 0x141428, alpha: 0.85 });
    bg.stroke({ color: 0x4e9af1, width: 2 });
    paintPalettePanel.addChild(bg);

    const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#ffffff", "#000000"];
    colors.forEach((c, i) => {
      const swatch = new Graphics();
      swatch.rect(10 + i * 35, 10, 30, 30);
      swatch.fill({ color: c });
      swatch.eventMode = "static";
      swatch.onclick = () => postAction({ kind: "setPaintColor", color: c });
      paintPalettePanel.addChild(swatch);
    });
  }

  function rebuildFunMode(): void {
    funModePanel.removeChildren();
    const label = new Text({ text: "Fun Mode:", style: { fill: 0x4e9af1, fontSize: 14, fontFamily: "Montserrat" } });
    funModePanel.addChild(label);

    const modes = [
      { mode: FunMode.Normal, label: "Normal" },
      { mode: FunMode.Moon, label: "Moon" },
      { mode: FunMode.ZeroG, label: "ZeroG" },
      { mode: FunMode.Bouncy, label: "Bouncy" },
    ];
    modes.forEach((m, i) => {
      const txt = new Text({ text: m.mode === funMode ? `[${m.label}]` : m.label, style: { fill: m.mode === funMode ? 0x4e9af1 : 0xe0e0e0, fontSize: 13, fontFamily: "Montserrat" } });
      txt.x = 80 + i * 70; txt.y = 0;
      txt.eventMode = "static";
      txt.onclick = () => postAction({ kind: "setFunMode", mode: m.mode });
      funModePanel.addChild(txt);
    });
  }

  function rebuildGraphics(): void {
    graphicsPanel.removeChildren();
    if (!showGraphics) return;

    const bg = new Graphics();
    bg.rect(0, 0, 280, 420);
    bg.fill({ color: 0x141428, alpha: 0.9 });
    bg.stroke({ color: 0x4e9af1, width: 2 });
    graphicsPanel.addChild(bg);

    const title = new Text({ text: "Graphics Settings [F6]", style: { fill: 0x4e9af1, fontSize: 16, fontFamily: "Montserrat" } });
    title.x = 10; title.y = 8;
    graphicsPanel.addChild(title);

    let y = 36;
    const rowH = 26;

    const addToggle = (label: string, value: boolean, onClick: () => void) => {
      const txt = new Text({ text: `${label}: ${value ? "ON" : "OFF"}`, style: { fill: value ? 0x4e9af1 : 0x888888, fontSize: 13, fontFamily: "Montserrat" } });
      txt.x = 12; txt.y = y;
      txt.eventMode = "static";
      txt.onclick = onClick;
      graphicsPanel.addChild(txt);
      y += rowH;
    };

    const addSlider = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void) => {
      const lbl = new Text({ text: `${label}: ${value.toFixed(2)}`, style: { fill: 0xe0e0e0, fontSize: 12, fontFamily: "Montserrat" } });
      lbl.x = 12; lbl.y = y;
      graphicsPanel.addChild(lbl);
      y += 16;
      // Slider track
      const trackW = 250;
      const track = new Graphics();
      track.rect(12, y, trackW, 6);
      track.fill({ color: 0x333355 });
      track.stroke({ color: 0x555577, width: 1 });
      graphicsPanel.addChild(track);
      // Knob
      const knobX = 12 + ((value - min) / (max - min)) * trackW;
      const knob = new Graphics();
      knob.circle(knobX, y + 3, 7);
      knob.fill({ color: 0x4e9af1 });
      knob.eventMode = "static";
      knob.cursor = "pointer";
      let dragging = false;
      const updateKnob = (clientX: number) => {
        const localX = clientX - 12; // approximate (panel x offset handled by Pixi)
        const t = Math.max(0, Math.min(1, localX / trackW));
        const newVal = min + t * (max - min);
        const snapped = Math.round(newVal / step) * step;
        lbl.text = `${label}: ${snapped.toFixed(2)}`;
        onChange(snapped);
      };
      knob.on("pointerdown", (e) => { dragging = true; });
      knob.on("pointermove", (e) => { if (dragging) updateKnob(e.clientX); });
      knob.on("pointerup", () => { dragging = false; });
      knob.on("pointerupoutside", () => { dragging = false; });
      graphicsPanel.addChild(knob);
      y += rowH;
    };

    const addColorRow = (label: string, r: number, g: number, b: number, onChange: (r: number, g: number, b: number) => void) => {
      const lbl = new Text({ text: `${label}: R=${r.toFixed(2)} G=${g.toFixed(2)} B=${b.toFixed(2)}`, style: { fill: 0xe0e0e0, fontSize: 12, fontFamily: "Montserrat" } });
      lbl.x = 12; lbl.y = y;
      graphicsPanel.addChild(lbl);
      y += 16;
      // Three mini sliders for R, G, B
      const channels = [["R", r], ["G", g], ["B", b]] as const;
      for (const [ch, val] of channels) {
        const chLbl = new Text({ text: ch, style: { fill: 0xaaaaaa, fontSize: 10, fontFamily: "Montserrat" } });
        chLbl.x = 12; chLbl.y = y;
        graphicsPanel.addChild(chLbl);
        const trackW = 220;
        const track = new Graphics();
        track.rect(30, y + 2, trackW, 4);
        track.fill({ color: 0x333355 });
        graphicsPanel.addChild(track);
        const knobX = 30 + val * trackW;
        const knob = new Graphics();
        knob.circle(knobX, y + 4, 5);
        knob.fill({ color: ch === "R" ? 0xff4444 : ch === "G" ? 0x44ff44 : 0x4444ff });
        knob.eventMode = "static";
        knob.cursor = "pointer";
        let dragging = false;
        const updateKnob = (clientX: number) => {
          const localX = clientX - 30;
          const t = Math.max(0, Math.min(1, localX / trackW));
          const newVal = Math.round(t * 100) / 100;
          if (ch === "R") { gfxSunR = newVal; onChange(newVal, gfxSunG, gfxSunB); }
          else if (ch === "G") { gfxSunG = newVal; onChange(gfxSunR, newVal, gfxSunB); }
          else { gfxSunB = newVal; onChange(gfxSunR, gfxSunG, newVal); }
          lbl.text = `${label}: R=${gfxSunR.toFixed(2)} G=${gfxSunG.toFixed(2)} B=${gfxSunB.toFixed(2)}`;
        };
        knob.on("pointerdown", () => { dragging = true; });
        knob.on("pointermove", (e) => { if (dragging) updateKnob(e.clientX); });
        knob.on("pointerup", () => { dragging = false; });
        knob.on("pointerupoutside", () => { dragging = false; });
        graphicsPanel.addChild(knob);
        y += 14;
      }
      y += 6;
    };

    // Post-processing toggles
    addToggle("Bloom", gfxBloom, () => postAction({ kind: "setBloom", enabled: !gfxBloom }));
    if (gfxBloom) {
      addSlider("  Strength", gfxBloomStrength, 0, 3, 0.05, (v) => { gfxBloomStrength = v; postAction({ kind: "setBloomStrength", value: v }); });
      addSlider("  Threshold", gfxBloomThreshold, 0, 2, 0.05, (v) => { gfxBloomThreshold = v; postAction({ kind: "setBloomThreshold", value: v }); });
    }
    addToggle("FXAA", gfxFXAA, () => postAction({ kind: "setFXAA", enabled: !gfxFXAA }));
    addToggle("Tonemap", gfxTonemap, () => postAction({ kind: "setTonemap", enabled: !gfxTonemap }));
    if (gfxTonemap) {
      addSlider("  Exposure", gfxExposure, 0.1, 4, 0.05, (v) => { gfxExposure = v; postAction({ kind: "setExposure", value: v }); });
    }
    addToggle("Vignette", gfxVignette, () => postAction({ kind: "setVignette", enabled: !gfxVignette }));
    if (gfxVignette) {
      addSlider("  Strength", gfxVignetteStrength, 0, 1, 0.05, (v) => { gfxVignetteStrength = v; postAction({ kind: "setVignetteStrength", value: v }); });
    }

    // Rendering toggles
    addToggle("Shadows", gfxShadows, () => postAction({ kind: "setShadows", enabled: !gfxShadows }));
    addToggle("Mipmaps", gfxMipmaps, () => postAction({ kind: "setMipmaps", enabled: !gfxMipmaps }));
    addToggle("Point Lights", gfxPointLights, () => postAction({ kind: "setPointLights", enabled: !gfxPointLights }));

    // Lighting controls
    addColorRow("Sun Color", gfxSunR, gfxSunG, gfxSunB, (r, g, b) => postAction({ kind: "setSunColor", r, g, b }));
    addSlider("Ambient", gfxAmbient, 0, 2, 0.05, (v) => { gfxAmbient = v; postAction({ kind: "setAmbientIntensity", value: v }); });
  }

  rebuildBrowser();
  rebuildToolWheel();
  rebuildPaintPalette();
  rebuildFunMode();
  rebuildGraphics();

  return {
    root,
    update(data: PixiUiUpdateData) {
      const stats = data.stats as Record<string, number> | undefined;
      const events = data.events as any[] | undefined;

      fps = stats?.fps ?? fps;
      propCount = stats?.propCount ?? propCount;
      const newBrowser = (stats?.showBrowser ?? (showBrowser ? 1 : 0)) !== 0;
      const newToolWheel = (stats?.showToolWheel ?? 0) !== 0;
      const newPaintPalette = (stats?.showPaintPalette ?? 0) !== 0;
      const newTool = stats?.activeTool ?? activeTool;
      const newFunMode = stats?.funMode ?? funMode;

      let needsBrowserRebuild = false;
      let needsToolWheelRebuild = false;
      let needsPaintPaletteRebuild = false;
      let needsFunModeRebuild = false;

      if (newBrowser !== showBrowser) { showBrowser = newBrowser; browserPanel.visible = showBrowser; }
      if (newToolWheel !== showToolWheel) { showToolWheel = newToolWheel; needsToolWheelRebuild = true; }
      if (newPaintPalette !== showPaintPalette) { showPaintPalette = newPaintPalette; needsPaintPaletteRebuild = true; }
      if (newTool !== activeTool) { activeTool = newTool; needsToolWheelRebuild = true; }
      if (newFunMode !== funMode) { funMode = newFunMode; needsFunModeRebuild = true; }

      // Graphics settings state from stats
      let needsGraphicsRebuild = false;
      const newShowGraphics = (stats?.showGraphics ?? 0) !== 0;
      if (newShowGraphics !== showGraphics) {
        showGraphics = newShowGraphics;
        graphicsPanel.visible = showGraphics;
        needsGraphicsRebuild = true;
      }
      const newBloom = (stats?.bloomEnabled ?? 1) !== 0;
      if (newBloom !== gfxBloom) { gfxBloom = newBloom; needsGraphicsRebuild = true; }
      const newFXAA = (stats?.fxaaEnabled ?? 1) !== 0;
      if (newFXAA !== gfxFXAA) { gfxFXAA = newFXAA; needsGraphicsRebuild = true; }
      const newTonemap = (stats?.tonemapEnabled ?? 1) !== 0;
      if (newTonemap !== gfxTonemap) { gfxTonemap = newTonemap; needsGraphicsRebuild = true; }
      const newVignette = (stats?.vignetteEnabled ?? 1) !== 0;
      if (newVignette !== gfxVignette) { gfxVignette = newVignette; needsGraphicsRebuild = true; }
      const newShadows = (stats?.shadowsEnabled ?? 1) !== 0;
      if (newShadows !== gfxShadows) { gfxShadows = newShadows; needsGraphicsRebuild = true; }
      const newMipmaps = (stats?.mipmapsEnabled ?? 1) !== 0;
      if (newMipmaps !== gfxMipmaps) { gfxMipmaps = newMipmaps; needsGraphicsRebuild = true; }
      const newPointLights = (stats?.pointLightsEnabled ?? 1) !== 0;
      if (newPointLights !== gfxPointLights) { gfxPointLights = newPointLights; needsGraphicsRebuild = true; }
      const newBloomStr = stats?.bloomStrength ?? gfxBloomStrength;
      if (Math.abs(newBloomStr - gfxBloomStrength) > 0.01) { gfxBloomStrength = newBloomStr; }
      const newBloomThr = stats?.bloomThreshold ?? gfxBloomThreshold;
      if (Math.abs(newBloomThr - gfxBloomThreshold) > 0.01) { gfxBloomThreshold = newBloomThr; }
      const newExposure = stats?.exposure ?? gfxExposure;
      if (Math.abs(newExposure - gfxExposure) > 0.01) { gfxExposure = newExposure; }
      const newVignetteStr = stats?.vignetteStrength ?? gfxVignetteStrength;
      if (Math.abs(newVignetteStr - gfxVignetteStrength) > 0.01) { gfxVignetteStrength = newVignetteStr; }
      const newSunR = stats?.sunColorR ?? gfxSunR;
      if (Math.abs(newSunR - gfxSunR) > 0.01) { gfxSunR = newSunR; }
      const newSunG = stats?.sunColorG ?? gfxSunG;
      if (Math.abs(newSunG - gfxSunG) > 0.01) { gfxSunG = newSunG; }
      const newSunB = stats?.sunColorB ?? gfxSunB;
      if (Math.abs(newSunB - gfxSunB) > 0.01) { gfxSunB = newSunB; }
      const newAmbient = stats?.ambientIntensity ?? gfxAmbient;
      if (Math.abs(newAmbient - gfxAmbient) > 0.01) { gfxAmbient = newAmbient; }

      // Process events
      if (events) {
        for (const evt of events) {
          if (evt.kind === "contentList") {
            contentItems = evt.items as ContentListItem[];
            needsBrowserRebuild = true;
          }
        }
      }

      fpsText.text = `FPS: ${fps.toFixed(0)}  Props: ${propCount}`;

      if (needsBrowserRebuild) rebuildBrowser();
      if (needsToolWheelRebuild) rebuildToolWheel();
      if (needsPaintPaletteRebuild) rebuildPaintPalette();
      if (needsFunModeRebuild) rebuildFunMode();
      if (needsGraphicsRebuild) rebuildGraphics();
    },
    resize(width: number, height: number) {
      helpText.y = height - 30;
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
