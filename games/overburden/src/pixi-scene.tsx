// ============================================================================
// overburden pixi-scene — @pixi/react adapter scene for the overburden game.
//
// Uses @pixi/react to render React components to PixiJS inside the UI worker.
// The worker store (worker-store.ts) is updated from SAB + events; React
// components read from it via useSyncExternalStore and re-render automatically.
// Actions are sent back to the main thread via postAction.
// ============================================================================

import type { PixiUiScene, PixiUiSceneContext, Rect } from "@downdraft/library-pixi-ui";
import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
import React from "react";
import type { OverburdenAction, OverburdenEvent } from "./pixi/bridge-protocol";
import { OverburdenApp } from "./pixi/components/OverburdenApp";
import { FontScaleContext } from "./pixi/font-scale-context";
import { MapOverlay } from "./pixi/map-overlay";
import { setPostAction, setWorkerState } from "./pixi/worker-store";

export default async function createOverburdenScene(ctx: PixiUiSceneContext): Promise<PixiUiScene> {
  const root = await createPixiReactRoot(ctx);

  setPostAction((action: OverburdenAction) => ctx.postAction(action));

  let currentFontScale = ctx.fontScale;

  function renderApp(width: number, height: number) {
    root.render(
      React.createElement(
        FontScaleContext.Provider,
        { value: currentFontScale },
        React.createElement(OverburdenApp, { width, height }),
      ),
    );
  }

  renderApp(ctx.width, ctx.height);

  let currentWidth = ctx.width;
  let currentHeight = ctx.height;

  // Imperative map overlay (managed outside @pixi/react to avoid GC issues
  // from per-frame Graphics draw callbacks during the crossfade transition).
  // Pass the extraSharedBuffers (contains the map SAB) so the overlay can
  // read per-block data directly from the SAB.
  const mapOverlay = new MapOverlay(ctx.app.stage, ctx.extraSharedBuffers);

  return {
    root: ctx.app.stage,
    update({ stats, events }) {
      // Re-render if font scale changed.
      if (ctx.fontScale !== currentFontScale) {
        currentFontScale = ctx.fontScale;
        renderApp(currentWidth, currentHeight);
      }
      // Update SAB scalars → worker store. Map-mode stats (camWorldX/Y,
      // camZoom, mapOpacity, playerWorldX/Y, playerFacing) are NOT stored
      // here — they change every frame and would notify all React
      // subscribers unnecessarily. The MapOverlay reads them directly from
      // the SAB stats passed to mapOverlay.update() below.
      setWorkerState({
        fps: stats.fps ?? 0,
        health: stats.health ?? 100,
        hunger: stats.hunger ?? 100,
        energy: stats.energy ?? 100,
        air: stats.air ?? 100,
        happiness: stats.happiness ?? 100,
        environment: stats.environment ?? 100,
        activeBhIndex: stats.activeBhIndex ?? 0,
        blockheadCount: stats.blockheadCount ?? 1,
        selectedSlot: stats.selectedSlot ?? 0,
        inventoryTab: (["inventory", "crafting", "creative"] as const)[stats.inventoryTab ?? 0] ?? "inventory",
        showTitleScreen: (stats.showTitleScreen ?? 1) !== 0,
        paused: (stats.paused ?? 0) !== 0,
        showInventoryPanel: (stats.showInventoryPanel ?? 0) !== 0,
        showCraftPanel: (stats.showCraftPanel ?? 0) !== 0,
        showTaskQueue: (stats.showTaskQueue ?? 0) !== 0,
        taskMode: (stats.taskMode ?? 0) !== 0,
        deterministic: (stats.deterministic ?? 0) !== 0,
        hasSelectedStation: (stats.hasSelectedStation ?? 0) !== 0,
        selectedStationAx: stats.selectedStationAx ?? 0,
        selectedStationAy: stats.selectedStationAy ?? 0,
        season: (["spring", "summer", "autumn", "winter"] as const)[stats.season ?? 0] ?? "spring",
        dayInSeason: stats.dayInSeason ?? 1,
        year: stats.year ?? 1,
        characterGender: (stats.characterGender ?? 0) === 1 ? "female" : "male",
        cameraDetached: (stats.cameraDetached ?? 0) !== 0,
        debugNoShadows: (stats.debugNoShadows ?? 0) !== 0,
        debugInspect: (stats.debugInspect ?? 0) !== 0,
        canvasW: stats.canvasW ?? currentWidth,
        canvasH: stats.canvasH ?? currentHeight,
      });

      // Process events
      for (const e of events) {
        const ev = e as OverburdenEvent;
        switch (ev.kind) {
          case "setInventory": setWorkerState({ inventory: ev.inventory }); break;
          case "setBlockheads": setWorkerState({ blockheads: ev.blockheads }); break;
          case "setRecipes": setWorkerState({ recipes: ev.recipes }); break;
          case "setPickups": setWorkerState({ pickups: ev.pickups }); break;
          case "setNotification": setWorkerState({ notification: ev.message }); break;
          case "setCraftQueue": setWorkerState({ craftQueue: ev.queue }); break;
          case "setTasks": setWorkerState({ tasks: ev.tasks }); break;
          case "setTaskMarkers": setWorkerState({ taskMarkers: ev.markers }); break;
          // setMapRegion is handled by mapOverlay.update() below — it
          // processes the event directly and redraws the bitmap imperatively.
        }
      }

      // Update the imperative map overlay (background + bitmap + markers).
      // This is outside @pixi/react to avoid GC issues from per-frame
      // Graphics draw callbacks during the crossfade transition.
      mapOverlay.update(
        {
          camWorldX: stats.camWorldX ?? 0,
          camWorldY: stats.camWorldY ?? 0,
          camZoom: stats.camZoom ?? 96,
          mapOpacity: stats.mapOpacity ?? 0,
          playerWorldX: stats.playerWorldX ?? 0,
          playerWorldY: stats.playerWorldY ?? 0,
          playerFacing: stats.playerFacing ?? 1,
        },
        events as OverburdenEvent[],
        currentWidth,
        currentHeight,
      );
    },
    resize(width, height) {
      currentWidth = width;
      currentHeight = height;
      setWorkerState({ canvasW: width, canvasH: height });
      renderApp(width, height);
    },
    getInteractiveRegions(): Rect[] {
      // @pixi/react manages interactivity via eventMode on individual components.
      // Return a full-screen rect so the host forwards all events when interactive.
      const s = ctx.app.stage;
      // Check if any interactive elements are visible by looking at the store
      // For pass-through mode, we need to report regions where interactive
      // elements exist. @pixi/react sets eventMode on individual components,
      // so the host's pass-through hit-testing will check PixiJS's own
      // event system. Return full-screen to let PixiJS handle hit-testing.
      return [{ x: 0, y: 0, width: currentWidth, height: currentHeight }];
    },
    summarize() {
      return ctx.app.stage.children.map((child) => ({
        name: child.label ?? "",
        type: child.constructor?.name ?? "unknown",
        visible: child.visible,
        x: child.x, y: child.y,
        width: child.width, height: child.height,
      }));
    },
    dispose() {
      mapOverlay.dispose();
      root.unmount();
    },
  };
}
