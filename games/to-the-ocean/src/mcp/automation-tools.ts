// ============================================================================
// To The Ocean — MCP automation tools
// Standard tools (input injection, state reads, screenshots, wait-conditions,
// DOM inspection) come from createStandardAutomationTools() in @downdraft/app.
// This file only provides the game-specific state readers + test-state wiring.
// ============================================================================

import type { McpToolRegistration } from "@downdraft/app/renderer";
import { createStandardAutomationTools } from "@downdraft/app/renderer";
import { PLR, PLR_FLAG } from "@downdraft/core";
import { GAME_PLR } from "@shared/constants/buffer";
import type { SimWebWorker } from "../engine/sim-web-worker";
import type { WebGPURenderer } from "../engine/webgpu-renderer";

export interface AutomationContext {
  renderer: () => WebGPURenderer | null;
  worker: () => SimWebWorker | null;
  /** Lazy getter for the game store — avoids circular import issues. */
  store: () => { getState: () => any } | null;
}

function readPlayer(renderer: WebGPURenderer, playerIndex: number) {
  const reader = renderer.getSimReader();
  if (!reader?.isValid()) return null;
  const count = reader.getPlayerCount();
  if (playerIndex < 0 || playerIndex >= count) return null;
  const slot = reader.getPlayerSlot(playerIndex);
  if (!slot) return null;
  const flags = slot.u32[PLR.FLAGS];
  return {
    position: [slot.f32[PLR.POS_X], slot.f32[PLR.POS_Y], slot.f32[PLR.POS_Z]],
    heading: slot.f32[PLR.HEADING],
    pitch: slot.f32[PLR.PITCH],
    cameraMode: slot.f32[PLR.CAMERA_MODE],
    health: slot.f32[PLR.HEALTH],
    maxHealth: slot.f32[PLR.MAX_HEALTH],
    hunger: slot.f32[PLR.HUNGER],
    thirst: slot.f32[PLR.THIRST],
    oxygen: slot.f32[PLR.OXYGEN],
    gold: slot.f32[GAME_PLR.GOLD],
    flags: {
      dead: !!(flags & PLR_FLAG.DEAD),
      swimming: !!(flags & PLR_FLAG.SWIMMING),
      piloting: !!(flags & PLR_FLAG.PILOTING),
      onboard: !!(flags & PLR_FLAG.ONBOARD),
      grounded: !!(flags & PLR_FLAG.GROUNDED),
      noclip: !!(flags & PLR_FLAG.NOCLIP),
    },
  };
}

function readWorld(renderer: WebGPURenderer) {
  const reader = renderer.getSimReader();
  if (!reader?.isValid()) return null;
  return {
    tick: reader.getTick(),
    sequence: reader.getSequence(),
    entityCount: reader.getEntityCount(),
    playerCount: reader.getPlayerCount(),
    activePlayers: reader.getActivePlayers(),
    timeOfDay: reader.getTimeOfDay(),
    weatherType: reader.getWeatherType(),
    weatherIntensity: reader.getWeatherIntensity(),
    windSpeed: reader.getWindSpeed(),
    windDir: reader.getWindDir(),
    visibility: reader.getVisibility(),
    ambientTemp: reader.getAmbientTemp(),
    gamemode: reader.getGamemode(),
    physicsInitialized: reader.getPhysicsInitialized(),
    physicsFailed: reader.getPhysicsFailed(),
    physicsBodyCount: reader.getPhysicsBodyCount(),
    physicsTickCount: reader.getPhysicsTickCount(),
  };
}

export function createAutomationTools(ctx: AutomationContext): McpToolRegistration[] {
  return createStandardAutomationTools({
    canvas: () => ctx.renderer()?.getCanvas() ?? null,
    isRunning: () => ctx.renderer()?.isRunning() ?? false,
    renderOneFrame: () => ctx.renderer()?.renderOneFrame(),
    input: () => ctx.renderer()?.getInputHandler() ?? null,
    getPlayerState: (i) => {
      const r = ctx.renderer();
      return r ? readPlayer(r, i ?? 0) : null;
    },
    getWorldState: () => {
      const r = ctx.renderer();
      return r ? readWorld(r) : null;
    },
    getUiState: () => {
      const s = ctx.store()?.getState();
      if (!s) return null;
      return {
        showInventory: s.showInventory,
        showMap: s.showMap,
        showBuildMenu: s.showBuildMenu,
        showCraftMenu: s.showCraftMenu,
        showPauseMenu: s.showPauseMenu,
        showSettings: s.showSettings,
        showFishingMinigame: s.showFishingMinigame,
        showTradeMenu: s.showTradeMenu,
        showCharacterCustomization: s.showCharacterCustomization,
        showCredits: s.showCredits,
        showBuilderWheel: s.showBuilderWheel,
        pointerLocked: s.pointerLocked,
        suppressPauseMenu: s.suppressPauseMenu,
        playerDied: !!s.playerDied,
        ready: s.ready,
        simReady: s.simReady,
        lutReady: s.lutReady,
      };
    },
    setTestState: (params) => {
      const worker = ctx.worker();
      if (!worker) return;
      if (params.weatherType !== undefined) worker.setWeather(params.weatherType as number);
      if (params.timeOfDay !== undefined) worker.setTimeOfDay(params.timeOfDay as number);
      if (params.simSpeed !== undefined) worker.setSimSpeed(params.simSpeed as number);
      if (params.respawn) worker.respawnPlayer(0);
    },
    pauseRendering: () => ctx.renderer()?.stop(),
    resumeRendering: () => ctx.renderer()?.start(),
    setTargetFPS: (fps) => ctx.renderer()?.setTargetFPS(fps),
  });
}
