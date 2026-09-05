// ============================================================================
// Andrew's Sandbox pixi-scene — direct PixiJS scene (no @pixi/react for now).
// Will be migrated to @pixi/react in Phase 7 when UI is fully built out.
// ============================================================================

import { Container, Graphics, Text, type Application } from "pixi.js";
import type { PixiUiScene, PixiUiSceneContext, PixiUiUpdateData } from "@downdraft/library-pixi-ui";
import { FunMode, ToolType } from "@sandbox/shared/types";
import type { SandboxAction, ContentListItem } from "./bridge-protocol";

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

  const helpText = new Text({ text: "[F5] Save  [F9] Load  [Q] Tools  [B] Browser", style: { fill: 0xaaaaaa, fontSize: 12, fontFamily: "Montserrat" } });
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

  rebuildBrowser();
  rebuildToolWheel();
  rebuildPaintPalette();
  rebuildFunMode();

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
    },
    resize(width: number, height: number) {
      helpText.y = height - 30;
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
