// ============================================================================
// mining-rpg pixi-scene — @pixi/react adapter scene.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, Rect } from "@downdraft/library-pixi-ui";
import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
import React from "react";
import type { MainToWorkerEvent } from "./pixi/bridge-protocol";
import { MiningApp } from "./pixi/components/MiningApp";
import { getWorkerState, setPostAction, setWorkerState } from "./pixi/worker-store";

export default async function createMiningScene(ctx: PixiUiSceneContext): Promise<PixiUiScene> {
  const root = await createPixiReactRoot(ctx);
  setPostAction((action: any) => ctx.postAction(action));
  root.render(React.createElement(MiningApp, { width: ctx.width, height: ctx.height }));

  let w = ctx.width, h = ctx.height;

  return {
    root: ctx.app.stage,
    update({ stats, events }) {
      setWorkerState({
        fps: stats.fps ?? 0,
        health: stats.health ?? 100,
        oxygen: stats.oxygen ?? 0,
        depth: stats.depth ?? 0,
        loadedChunks: stats.loadedChunks ?? 0,
        activeChunks: stats.activeChunks ?? 0,
        nearSignpost: (stats.nearSignpost ?? 0) !== 0,
        onGround: (stats.onGround ?? 0) !== 0,
        playerFacing: stats.playerFacing ?? 1,
        playerX: stats.playerX ?? 0, playerY: stats.playerY ?? 0,
        playerVx: stats.playerVx ?? 0, playerVy: stats.playerVy ?? 0,
        deathCause: stats.deathCause ?? 0,
        simReady: (stats.simReady ?? 0) !== 0,
        tick: stats.tick ?? 0,
        gameOver: (stats.gameOver ?? 0) !== 0,
        zoom: stats.zoom ?? 1,
        glowstickCount: stats.glowstickCount ?? 0,
        bombCount: stats.bombCount ?? 0,
        teleportCooldown: stats.teleportCooldown ?? 1,
        playerSpeed: stats.playerSpeed ?? 0,
        showTitleScreen: (stats.showTitleScreen ?? 1) !== 0,
        showInventory: (stats.showInventory ?? 0) !== 0,
        showEscapeMenu: (stats.showEscapeMenu ?? 0) !== 0,
        showStats: (stats.showStats ?? 0) !== 0,
        showAchievements: (stats.showAchievements ?? 0) !== 0,
        showMinimap: (stats.showMinimap ?? 1) !== 0,
        showShop: (stats.showShop ?? 0) !== 0,
        showHUD: (stats.showHUD ?? 1) !== 0,
        showFPS: (stats.showFPS ?? 0) !== 0,
        showHelp: (stats.showHelp ?? 0) !== 0,
        paused: (stats.paused ?? 0) !== 0,
        buildMode: (stats.buildMode ?? 0) !== 0,
        headlampOn: (stats.headlampOn ?? 0) !== 0,
        noclip: (stats.noclip ?? 0) !== 0,
        currency: stats.currency ?? 0,
        digRadius: stats.digRadius ?? 3,
        goldFlashTime: stats.goldFlashTime ?? 0,
        maxInventory: stats.maxInventory ?? 24,
        inventoryCount: stats.inventoryCount ?? 0,
        canvasW: stats.canvasW ?? w,
        canvasH: stats.canvasH ?? h,
      });

      for (const e of events) {
        const ev = e as unknown as MainToWorkerEvent;
        switch (ev.kind) {
          case "collected": break; // handled by setInventory
          case "saveLoaded":
            setWorkerState({
              inventory: ev.inventory, upgrades: ev.upgrades,
              currency: ev.currency, buildMaterials: ev.buildMaterials,
              health: ev.health, stats: ev.stats,
              unlockedAchievements: ev.unlockedAchievements,
              craftedItems: ev.craftedItems, welcomeBack: ev.welcomeBack,
            });
            break;
          case "savedAt": setWorkerState({ lastSaveTime: ev.time }); break;
          case "achievement":
            setWorkerState({ recentAchievement: { id: ev.id, name: ev.id, description: "" }, unlockedAchievements: [...getWorkerState().unlockedAchievements, ev.id] });
            break;
          case "floatingText": break; // handled via addFloatingText
          case "screenShake": setWorkerState({ screenShakeIntensity: ev.intensity }); break;
          case "death": setWorkerState({ deathQuip: ev.quip, deathCause: ev.cause, gameOver: true }); break;
          case "buildMaterials": setWorkerState({ buildMaterials: ev.mats }); break;
          case "setInventory": setWorkerState({ inventory: ev.inventory }); break;
          case "rendererSnapshot": setWorkerState({ rendererSnapshot: ev }); break;
        }
      }
    },
    resize(width, height) {
      w = width; h = height;
      setWorkerState({ canvasW: width, canvasH: height });
      root.render(React.createElement(MiningApp, { width, height }));
    },
    getInteractiveRegions(): Rect[] {
      return [{ x: 0, y: 0, width: w, height: h }];
    },
    summarize() {
      return ctx.app.stage.children.map((c) => ({
        name: c.label ?? "", type: c.constructor?.name ?? "unknown",
        visible: c.visible, x: c.x, y: c.y, width: c.width, height: c.height,
      }));
    },
    dispose() { root.unmount(); },
  };
}
