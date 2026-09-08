// ============================================================================
// native-scene — @pixi/react scene factory for native mode.
//
// Reuses the browser's OceanApp component tree but runs it in-process on the
// NativePixiUiHost's PIXI.Application. The NativeOceanDataBridge feeds state
// directly into worker-store (the same reactive store OceanApp reads via
// useWorkerState), so this scene's update() is a no-op — React re-renders
// automatically when setWorkerState fires.
//
// This mirrors pixi-scene.tsx but skips the worker/SAB stats mapping (the
// native bridge handles that) and the worker-context assumptions.
// ============================================================================

import { createPixiReactRoot } from "@downdraft/library-pixi-ui/react";
import type { Application } from "pixi.js";
import React from "react";

import { OceanApp } from "./components/OceanApp";
import { FontScaleContext } from "./font-scale-context";
import { getWorkerState } from "./worker-store";

export interface NativeOceanScene {
  update(): void;
  resize(width: number, height: number): void;
  getOpaqueRegions(): { x: number; y: number; width: number; height: number }[];
  dispose(): void;
}

export interface NativeOceanSceneContext {
  app: Application;
  width: number;
  height: number;
  fontScale: number;
  postAction: (action: any) => void;
}

export async function createNativeOceanScene(
  ctx: NativeOceanSceneContext,
): Promise<NativeOceanScene> {
  const root = await createPixiReactRoot(ctx as any);

  let currentFontScale = ctx.fontScale;
  let w = ctx.width;
  let h = ctx.height;

  function renderApp(width: number, height: number) {
    root.render(
      React.createElement(
        FontScaleContext.Provider,
        { value: currentFontScale },
        React.createElement(OceanApp, { width, height }),
      ),
    );
  }

  renderApp(w, h);

  return {
    update() {
      // React re-renders automatically via useWorkerState when the native
      // bridge calls setWorkerState. Only re-render if font scale changed.
      if (ctx.fontScale !== currentFontScale) {
        currentFontScale = ctx.fontScale;
        renderApp(w, h);
      }
    },
    resize(width, height) {
      w = width;
      h = height;
      renderApp(width, height);
    },
    getOpaqueRegions() {
      // Mirror pixi-scene.tsx's getOpaqueRegions — only report panels with
      // opaque (alpha >= 0.9) backgrounds so the 3D renderer can skip work.
      const s = getWorkerState();
      const regions: { x: number; y: number; width: number; height: number }[] = [];
      const cx = s.canvasW, cy = s.canvasH;
      if (s.showSettings) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 480) / 2), width: 400, height: 480 });
      }
      if (s.showPauseMenu) {
        regions.push({ x: Math.round((cx - 240) / 2), y: Math.round((cy - 280) / 2), width: 240, height: 280 });
      }
      if (s.showInventory) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 360) / 2), width: 400, height: 360 });
      }
      if (s.showCraftMenu) {
        regions.push({ x: Math.round((cx - 400) / 2), y: Math.round((cy - 420) / 2), width: 400, height: 420 });
      }
      if (s.showTradeMenu) {
        regions.push({ x: Math.round((cx - 360) / 2), y: Math.round((cy - 400) / 2), width: 360, height: 400 });
      }
      if (s.showBuildMenu) {
        regions.push({ x: Math.round((cx - 360) / 2), y: Math.round((cy - 400) / 2), width: 360, height: 400 });
      }
      if (s.showCharacterCustomization) {
        regions.push({ x: Math.round((cx - 340) / 2), y: Math.round((cy - 300) / 2), width: 340, height: 300 });
      }
      if (s.showMap) {
        regions.push({ x: 0, y: 0, width: cx, height: cy });
      }
      if (s.showCredits) {
        regions.push({ x: 0, y: 0, width: cx, height: cy });
      }
      return regions;
    },
    dispose() {
      root.unmount();
    },
  };
}
