// ============================================================================
// to-the-ocean pixi-scene — @pixi/react adapter scene.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, Rect } from "@downdraft/library-pixi-ui";
import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
import React from "react";
import type { OceanAction, OceanEvent } from "./pixi/bridge-protocol";
import { OceanApp } from "./pixi/components/OceanApp";
import { FontScaleContext } from "./pixi/font-scale-context";
import { getWorkerState, setPostAction, setWorkerState } from "./pixi/worker-store";

export default async function createOceanScene(ctx: PixiUiSceneContext): Promise<PixiUiScene> {
  const root = await createPixiReactRoot(ctx);
  setPostAction((action: OceanAction) => ctx.postAction(action));

  let currentFontScale = ctx.fontScale;

  function renderApp(width: number, height: number) {
    root.render(
      React.createElement(
        FontScaleContext.Provider,
        { value: currentFontScale },
        React.createElement(OceanApp, { width, height }),
      ),
    );
  }

  renderApp(ctx.width, ctx.height);

  let w = ctx.width, h = ctx.height;

  return {
    root: ctx.app.stage,
    update({ stats, events }) {
      // Re-render if font scale changed (the worker updates ctx.fontScale
      // when a setFontScale message arrives from the host).
      if (ctx.fontScale !== currentFontScale) {
        currentFontScale = ctx.fontScale;
        renderApp(w, h);
      }
      setWorkerState({
        fps: stats.fps ?? 0,
        ready: (stats.ready ?? 0) !== 0,
        simReady: (stats.simReady ?? 0) !== 0,
        lutReady: (stats.lutReady ?? 0) !== 0,
        hudState: {
          health: stats.health ?? 100, maxHealth: stats.maxHealth ?? 100,
          hunger: stats.hunger ?? 100, thirst: stats.thirst ?? 100,
          oxygen: stats.oxygen ?? 100, maxOxygen: stats.maxOxygen ?? 100,
          temperature: stats.temperature ?? 20, timeOfDay: stats.timeOfDay ?? 0.5,
          weatherType: stats.weatherType ?? 0, biome: stats.biome ?? 0,
          security: stats.security ?? 0, cameraMode: stats.cameraMode ?? 0,
          isFishing: (stats.isFishing ?? 0) !== 0,
          fishingTension: stats.fishingTension ?? 0,
          fishingProgress: stats.fishingProgress ?? 0,
          activeSlot: stats.activeSlot ?? 0,
          isPiloting: (stats.isPiloting ?? 0) !== 0,
          isOnboard: (stats.isOnboard ?? 0) !== 0,
          gold: stats.gold ?? 0,
          playerX: stats.playerX ?? 0, playerZ: stats.playerZ ?? 0,
          heading: stats.heading ?? 0,
        },
        showInventory: (stats.showInventory ?? 0) !== 0,
        showMap: (stats.showMap ?? 0) !== 0,
        showBuildMenu: (stats.showBuildMenu ?? 0) !== 0,
        showCraftMenu: (stats.showCraftMenu ?? 0) !== 0,
        showFishingMinigame: (stats.showFishingMinigame ?? 0) !== 0,
        showTradeMenu: (stats.showTradeMenu ?? 0) !== 0,
        showSettings: (stats.showSettings ?? 0) !== 0,
        showPauseMenu: (stats.showPauseMenu ?? 0) !== 0,
        showCharacterCustomization: (stats.showCharacterCustomization ?? 0) !== 0,
        showCredits: (stats.showCredits ?? 0) !== 0,
        showBuilderWheel: (stats.showBuilderWheel ?? 0) !== 0,
        hudHidden: (stats.hudHidden ?? 0) !== 0,
        pointerLocked: (stats.pointerLocked ?? 0) !== 0,
        playerDied: (stats.playerDied ?? 0) !== 0,
        isDev: (stats.isDev ?? 0) !== 0,
        suppressPauseMenu: (stats.suppressPauseMenu ?? 0) !== 0,
        builderCellType: stats.builderCellType ?? 0,
        builderRotation: stats.builderRotation ?? 0,
        reticleSize: stats.reticleSize ?? 80,
        canvasW: stats.canvasW ?? w,
        canvasH: stats.canvasH ?? h,
      });

      for (const e of events) {
        const ev = e as OceanEvent;
        switch (ev.kind) {
          case "setShipHold": setWorkerState({ shipHoldData: ev.data }); break;
          case "setBookmarks": setWorkerState({ bookmarks: ev.bookmarks }); break;
          case "setWaypoint": setWorkerState({ waypoint: ev.waypoint }); break;
          case "setPlayerDied": setWorkerState({ playerDiedData: ev.data, playerDied: ev.data !== null }); break;
          case "setWeather": setWorkerState({ weather: ev.data }); break;
          case "addNotification": setWorkerState({ notifications: [...getWorkerState().notifications, ev.notification] }); break;
          case "removeNotification": setWorkerState({ notifications: getWorkerState().notifications.filter((n: any) => n.id !== ev.id) }); break;
          case "setNotifications": setWorkerState({ notifications: ev.notifications }); break;
          case "setEquipment": setWorkerState({ equipment: ev.equipment }); break;
          case "setRecipes": setWorkerState({ recipes: ev.recipes }); break;
          case "setCraftQueue": setWorkerState({ craftQueue: ev.queue }); break;
          case "setTradeItems": setWorkerState({ tradeItems: ev.items }); break;
          case "setBuildModules": setWorkerState({ buildModules: ev.modules }); break;
          case "setMapSnapshot": setWorkerState({ mapSnapshot: ev.snapshot }); break;
        }
      }
    },
    resize(width, height) {
      w = width; h = height;
      setWorkerState({ canvasW: width, canvasH: height });
      renderApp(width, height);
    },
    getInteractiveRegions(): Rect[] {
      return [{ x: 0, y: 0, width: w, height: h }];
    },
    getOpaqueRegions(): Rect[] {
      const s = getWorkerState();
      const regions: Rect[] = [];
      // Only report panels with opaque (alpha >= 0.9) backgrounds.
      // Translucent dim backdrops (alpha 0.6) are NOT opaque — the game
      // canvas is visible through them.
      const cx = s.canvasW, cy = s.canvasH;
      // Settings panel: 400×480, centered, alpha 0.95
      if (s.showSettings) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 480) / 2), width: 400, height: 480 });
      }
      // Pause menu panel body: 240×280, centered, alpha 0.95 (dim backdrop is 0.6, not opaque)
      if (s.showPauseMenu) {
        regions.push({ x: Math.round((cx - 240) / 2), y: Math.round((cy - 280) / 2), width: 240, height: 280 });
      }
      // Inventory: 400×360, centered, alpha 0.95
      if (s.showInventory) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 360) / 2), width: 400, height: 360 });
      }
      // Craft menu: 400×420, centered, alpha 0.95
      if (s.showCraftMenu) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 420) / 2), width: 400, height: 420 });
      }
      // Trade menu: 360×400, centered, alpha 0.95
      if (s.showTradeMenu) {
        regions.push({ x: Math.round((cx - 360) / 2), y: Math.round((cy - 400) / 2), width: 360, height: 400 });
      }
      // Build menu: 360×400, centered, alpha 0.95
      if (s.showBuildMenu) {
        regions.push({ x: Math.round((cx - 360) / 2), y: Math.round((cy - 400) / 2), width: 360, height: 400 });
      }
      // Character customization: 340×300, centered, alpha 0.95
      if (s.showCharacterCustomization) {
        regions.push({ x: Math.round((cx - 340) / 2), y: Math.round((cy - 300) / 2), width: 340, height: 300 });
      }
      // Map view: full-screen, alpha 0.9 (opaque enough to skip 3D)
      if (s.showMap) {
        regions.push({ x: 0, y: 0, width: cx, height: cy });
      }
      // Credits screen: full-screen, alpha 0.95
      if (s.showCredits) {
        regions.push({ x: 0, y: 0, width: cx, height: cy });
      }
      return regions;
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
