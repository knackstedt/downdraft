// ============================================================================
// native-data-bridge — in-process data bridge for the native PixiJS UI.
//
// Replaces the browser's SAB (UiStatsSAB) + postMessage worker bridge with a
// direct main-thread bridge: each frame it reads the sim reader + game store
// and calls setWorkerState(...) — the same reactive store @pixi/react components
// already consume via useWorkerState. Event-driven fields (ship hold, bookmarks,
// recipes, etc.) are forwarded via a store subscription. UI actions flow back
// through postAction → game store / simBridge.
//
// This mirrors main.tsx's writeStats/postEvent/onAction logic but without the
// worker boundary, reusing worker-store.ts as the shared reactive state.
// ============================================================================

import { PLR, PLR_FLAG, SimBufferReader } from "@downdraft/core";
import { GAME_PLR } from "@shared/constants/buffer";
import { CameraMode } from "@shared/types";

import type { OceanAction } from "./bridge-protocol";
import { getWorkerState, setPostAction, setWorkerState } from "./worker-store";
import { useGameStore } from "../stores/game-store";

export interface NativeDataBridgeDeps {
  /** The WebGPURenderer (or any object exposing getSimReader()). */
  renderer: any;
  canvasW: number;
  canvasH: number;
}

export class NativeOceanDataBridge {
  private renderer: any;
  private canvasW: number;
  private canvasH: number;
  private unsub: (() => void) | null = null;
  // Last-seen references for event-driven change detection.
  private lastShipHold: any = undefined;
  private lastBookmarks: any = undefined;
  private lastWaypoint: any = undefined;
  private lastPlayerDied: any = undefined;
  private lastWeather: any = undefined;
  private lastEquipment: any = undefined;
  private lastNotifications: any = undefined;

  constructor(deps: NativeDataBridgeDeps) {
    this.renderer = deps.renderer;
    this.canvasW = deps.canvasW;
    this.canvasH = deps.canvasH;
  }

  /** Wire action routing + store subscription. Call once after the store exists. */
  start(): void {
    setPostAction((action: any) => this.handleAction(action as OceanAction));
    this.unsub = useGameStore.subscribe((s) => this.onStoreChange(s));
    // Seed event-driven fields from the current store state.
    this.onStoreChange(useGameStore.getState());
    // Seed canvas size + readiness into the worker store.
    setWorkerState({ canvasW: this.canvasW, canvasH: this.canvasH });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    setPostAction(() => {});
  }

  resize(width: number, height: number): void {
    this.canvasW = width;
    this.canvasH = height;
    setWorkerState({ canvasW: width, canvasH: height });
  }

  /** Per-frame: read sim reader + store scalars → worker store. */
  update(): void {
    const simReader = this.renderer.getSimReader?.() as SimBufferReader | null;
    if (!simReader || !simReader.isValid()) return;
    const playerSlot = simReader.getPlayerSlot(0);
    if (!playerSlot) return;
    const flags = playerSlot.u32[PLR.FLAGS];
    const s = useGameStore.getState();

    // Mirror pixi-scene.tsx's update() mapping (SAB scalars → worker store).
    setWorkerState({
      fps: s.fps ?? 0,
      ready: s.ready,
      simReady: s.simReady,
      lutReady: s.lutReady,
      hudState: {
        health: playerSlot.f32[PLR.HEALTH],
        maxHealth: playerSlot.f32[PLR.MAX_HEALTH],
        hunger: playerSlot.f32[PLR.HUNGER],
        thirst: playerSlot.f32[PLR.THIRST],
        oxygen: playerSlot.f32[PLR.OXYGEN],
        maxOxygen: playerSlot.f32[PLR.MAX_OXYGEN],
        temperature: playerSlot.f32[PLR.TEMPERATURE],
        timeOfDay: simReader.getTimeOfDay(),
        weatherType: simReader.getWeatherType(),
        biome: 0, security: 0,
        cameraMode: playerSlot.u32[PLR.CAMERA_MODE] as CameraMode,
        isFishing: (flags & PLR_FLAG.FISHING) !== 0,
        fishingTension: playerSlot.f32[GAME_PLR.FISHING_TENSION] ?? 50,
        fishingProgress: playerSlot.f32[GAME_PLR.FISHING_PROGRESS] ?? 0,
        activeSlot: playerSlot.u32[PLR.ACTIVE_SLOT] ?? 0,
        isPiloting: (flags & PLR_FLAG.PILOTING) !== 0,
        isOnboard: (flags & PLR_FLAG.ONBOARD) !== 0,
        gold: playerSlot.f32[GAME_PLR.GOLD] ?? 0,
        playerX: playerSlot.f32[PLR.POS_X],
        playerZ: playerSlot.f32[PLR.POS_Z],
        heading: playerSlot.f32[PLR.HEADING],
      },
      showInventory: s.showInventory,
      showMap: s.showMap,
      showBuildMenu: s.showBuildMenu,
      showCraftMenu: s.showCraftMenu,
      showFishingMinigame: s.showFishingMinigame,
      showTradeMenu: s.showTradeMenu,
      showSettings: s.showSettings,
      showPauseMenu: s.showPauseMenu,
      showCharacterCustomization: s.showCharacterCustomization,
      showCredits: s.showCredits,
      showBuilderWheel: s.showBuilderWheel,
      hudHidden: s.hudHidden,
      pointerLocked: !!globalThis.document?.pointerLockElement,
      playerDied: !!s.playerDied,
      isDev: s.isDev,
      suppressPauseMenu: s.suppressPauseMenu,
      builderCellType: s.builderCellType,
      builderRotation: s.builderRotation,
      reticleSize: s.reticleSize,
      canvasW: this.canvasW,
      canvasH: this.canvasH,
    });
  }

  /** Forward event-driven store fields to the worker store on change. */
  private onStoreChange(s: any): void {
    if (s.shipHoldData !== this.lastShipHold) {
      this.lastShipHold = s.shipHoldData;
      setWorkerState({ shipHoldData: s.shipHoldData });
    }
    if (s.bookmarks !== this.lastBookmarks) {
      this.lastBookmarks = s.bookmarks;
      setWorkerState({ bookmarks: s.bookmarks });
    }
    if (s.waypoint !== this.lastWaypoint) {
      this.lastWaypoint = s.waypoint;
      setWorkerState({ waypoint: s.waypoint });
    }
    if (s.playerDied !== this.lastPlayerDied) {
      this.lastPlayerDied = s.playerDied;
      setWorkerState({ playerDiedData: s.playerDied, playerDied: !!s.playerDied });
    }
    if (s.weather !== this.lastWeather) {
      this.lastWeather = s.weather;
      setWorkerState({ weather: s.weather });
    }
    if (s.equipment !== this.lastEquipment) {
      this.lastEquipment = s.equipment;
      setWorkerState({ equipment: s.equipment });
    }
    if (s.notifications !== this.lastNotifications) {
      this.lastNotifications = s.notifications;
      setWorkerState({ notifications: s.notifications });
    }
  }

  /** Route a UI action to the game store / simBridge. Mirrors main.tsx onAction. */
  private handleAction(a: OceanAction): void {
    const s = useGameStore.getState();
    switch (a.kind) {
      case "toggleMenu":
        switch (a.menu) {
          case "inventory": s.toggleInventory(); break;
          case "map": s.toggleMap(); break;
          case "buildMenu": s.toggleBuildMenu(); break;
          case "craftMenu": s.toggleCraftMenu(); break;
          case "fishingMinigame": s.toggleFishingMinigame(); break;
          case "tradeMenu": s.toggleTradeMenu(); break;
          case "settings": s.toggleSettings(); break;
          case "pauseMenu": s.togglePauseMenu(); break;
          case "characterCustomization": s.toggleCharacterCustomization(); break;
          case "credits": s.toggleCredits(); break;
          case "builderWheel": s.setShowBuilderWheel(!s.showBuilderWheel); break;
        }
        break;
      case "closeMenu":
        switch (a.menu) {
          case "inventory": if (s.showInventory) s.toggleInventory(); break;
          case "map": if (s.showMap) s.toggleMap(); break;
          case "buildMenu": if (s.showBuildMenu) s.toggleBuildMenu(); break;
          case "craftMenu": if (s.showCraftMenu) s.toggleCraftMenu(); break;
          case "fishingMinigame": if (s.showFishingMinigame) s.toggleFishingMinigame(); break;
          case "tradeMenu": if (s.showTradeMenu) s.toggleTradeMenu(); break;
          case "settings": if (s.showSettings) s.toggleSettings(); break;
          case "pauseMenu": if (s.showPauseMenu) s.togglePauseMenu(); break;
          case "characterCustomization": if (s.showCharacterCustomization) s.toggleCharacterCustomization(); break;
          case "credits": if (s.showCredits) s.toggleCredits(); break;
          case "builderWheel": s.setShowBuilderWheel(false); break;
        }
        break;
      case "equipItem": s.equipItem(a.slot, a.itemId); break;
      case "addBookmark": s.addBookmark(a.x, a.z, a.label); break;
      case "removeBookmark": s.removeBookmark(a.id); break;
      case "setWaypoint": s.setWaypoint(a.waypoint); break;
      case "setBuilderCellType": s.setBuilderCellType(a.idx); break;
      case "setBuilderRotation": s.setBuilderRotation(a.rotation); break;
      case "setReticleSize": s.setReticleSize(a.size); break;
      // simBridge-dependent actions: no-op in native until a native simBridge is wired.
      case "sendCommand": s.simBridge?.sendCommand(a.data); break;
      case "saveGame": s.simBridge?.saveGame("autosave"); break;
      case "loadGame": s.simBridge?.loadGame("autosave"); break;
      case "resetGame": s.simBridge?.resetGame(); break;
      case "quit": s.simBridge?.quit(); break;
      case "respawn": s.simBridge?.respawnPlayer(s.playerDied?.playerId ?? 0); s.setPlayerDied(null); break;
      case "setSetting": s.simBridge?.setSetting(a.key, a.value); break;
      case "lockPointer": this.renderer.lockPointer?.(); break;
      case "craft": s.simBridge?.sendCommand({ type: "craft", recipeId: a.recipeId }); break;
      case "abortCraft": s.simBridge?.sendCommand({ type: "abortCraft", jobId: a.jobId }); break;
      case "trade": s.simBridge?.sendCommand({ type: "trade", itemId: a.itemId, quantity: a.quantity, buy: a.buy }); break;
      case "build": s.simBridge?.sendCommand({ type: "build", moduleId: a.moduleId }); break;
      case "transferItem":
        s.simBridge?.sendCommand({ type: `transfer_to_${a.direction === "to_ship" ? "ship" : "from_ship"}`, itemId: a.itemId, quantity: a.quantity });
        break;
      case "openExternal": /* no-op in native (no Electron shell) */ break;
      case "setFontScale": /* handled by the native host directly */ break;
    }
  }
}
