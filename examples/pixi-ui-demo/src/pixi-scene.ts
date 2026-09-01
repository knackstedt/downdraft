// ============================================================================
// Sample PixiJS UI scene for the pixi-ui-demo example.
//
// This runs INSIDE the UI worker (not the main thread). It demonstrates:
//   - Reading per-frame scalars from the UiStatsSAB (health, fps).
//   - A health bar that animates based on SAB values.
//   - An FPS counter.
//   - An interactive "Pause" button that toggles interactive mode and
//     posts a game action back to the main thread.
//   - A large semi-transparent panel background so the HUD is clearly visible.
//
// The worker dynamically imports this module via the sceneModuleUrl config.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext } from "@downdraft/library-pixi-ui";
import { Container, Graphics, Text } from "pixi.js";

export default function createDemoScene(ctx: PixiUiSceneContext): PixiUiScene {
  const root = new Container();
  root.name = "hud-root";
  ctx.app.stage.addChild(root);

  // ── HUD panel background (semi-transparent, clearly visible) ──
  const panelBg = new Graphics();
  panelBg.name = "panel-bg";
  panelBg.roundRect(0, 0, 280, 160, 8).fill({ color: 0x1a1a2e, alpha: 0.85 });
  panelBg.stroke({ width: 2, color: 0x4a4a6a, alpha: 0.8 });
  root.addChild(panelBg);

  // ── Title ──
  const titleText = new Text({
    text: "PixiUI Demo Overlay",
    style: { fill: 0x88aaff, fontSize: Math.round(20 * ctx.fontScale), fontFamily: "monospace", fontWeight: "bold" },
  });
  titleText.name = "title-text";
  titleText.x = 16;
  titleText.y = 12;
  root.addChild(titleText);

  // ── Health bar ──
  const healthBarContainer = new Container();
  healthBarContainer.name = "health-bar";
  healthBarContainer.x = 16;
  healthBarContainer.y = 44;

  const healthBarBg = new Graphics();
  healthBarBg.name = "health-bar-bg";
  healthBarBg.roundRect(0, 0, 248, 28, 4).fill({ color: 0x333333, alpha: 0.9 });
  healthBarContainer.addChild(healthBarBg);

  const healthBarFill = new Graphics();
  healthBarFill.name = "health-bar-fill";
  healthBarContainer.addChild(healthBarFill);

  const healthText = new Text({
    text: "HP 100/100",
    style: { fill: 0xffffff, fontSize: Math.round(18 * ctx.fontScale), fontFamily: "monospace" },
  });
  healthText.name = "health-text";
  healthText.x = 8;
  healthText.y = 5;
  healthBarContainer.addChild(healthText);

  root.addChild(healthBarContainer);

  // ── FPS counter ──
  const fpsText = new Text({
    text: "FPS: --",
    style: { fill: 0x00ffaa, fontSize: Math.round(20 * ctx.fontScale), fontFamily: "monospace" },
  });
  fpsText.name = "fps-text";
  fpsText.x = 16;
  fpsText.y = 82;
  root.addChild(fpsText);

  // ── Pause button (interactive) ──
  const buttonContainer = new Container();
  buttonContainer.name = "pause-button";
  buttonContainer.x = 16;
  buttonContainer.y = 112;
  buttonContainer.eventMode = "static";
  buttonContainer.cursor = "pointer";

  const buttonBg = new Graphics();
  buttonBg.name = "pause-button-bg";
  buttonBg.roundRect(0, 0, 120, 36, 6).fill({ color: 0x4a4a6a, alpha: 0.95 });
  buttonBg.stroke({ width: 2, color: 0x8a8acc });
  buttonContainer.addChild(buttonBg);

  const buttonText = new Text({
    text: "Pause",
    style: { fill: 0xffffff, fontSize: Math.round(18 * ctx.fontScale), fontFamily: "monospace" },
  });
  buttonText.name = "pause-button-text";
  buttonText.x = 28;
  buttonText.y = 9;
  buttonContainer.addChild(buttonText);

  root.addChild(buttonContainer);

  // ── Button interaction ──
  let paused = false;
  buttonContainer.on("pointerdown", () => {
    paused = !paused;
    buttonText.text = paused ? "Resume" : "Pause";
    // Post a game action back to the main thread.
    ctx.postAction({ kind: paused ? "pause" : "resume" });
    // Keep interactive mode on so the button stays clickable.
    ctx.setInteractive(true);
  });

  // Start in interactive mode so the button is clickable.
  ctx.setInteractive(true);

  // ── Per-frame update ──
  let displayHealth = 100;
  let displayMaxHealth = 100;

  return {
    root,
    update({ stats }) {
      // FPS
      if (stats.fps !== undefined) {
        fpsText.text = `FPS: ${Math.floor(stats.fps)}`;
      }

      // Health bar — smooth interpolation toward the target value.
      const targetHealth = stats.health ?? 100;
      const targetMax = stats.maxHealth ?? 100;
      displayMaxHealth = targetMax;
      displayHealth += (targetHealth - displayHealth) * 0.1;

      // Update the fill width.
      const fillRatio = Math.max(0, Math.min(1, displayHealth / displayMaxHealth));
      const fillWidth = 244 * fillRatio;
      healthBarFill.clear();
      healthBarFill.roundRect(2, 2, fillWidth, 24, 3).fill({ color: 0xff4444, alpha: 0.9 });
      healthText.text = `HP ${Math.floor(displayHealth)}/${Math.floor(displayMaxHealth)}`;
    },
    resize(width, _height) {
      // Keep the HUD anchored to the top-left corner.
      root.x = 0;
      root.y = 0;
      void width;
    },
    summarize() {
      // Return a summary of the top-level children for MCP assertions.
      const summarizeNode = (obj: any): any => {
        const summary: any = {
          name: obj.name ?? "",
          type: obj.constructor?.name ?? "unknown",
          visible: obj.visible,
          x: obj.x,
          y: obj.y,
          width: obj.width,
          height: obj.height,
        };
        if (obj.text !== undefined) {
          summary.text = String(obj.text);
        }
        if (obj.children?.length) {
          summary.children = obj.children.slice(0, 20).map(summarizeNode);
        }
        return summary;
      };
      return root.children.map(summarizeNode);
    },
    dispose() {
      root.destroy({ children: true });
    },
  };
}
