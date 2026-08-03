// ============================================================================
// App — root React component with canvas + HUD overlay
// ============================================================================

import { useDebugStore } from "@downdraft/plugin-devtools";
import { WeatherType } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import BuilderWheel from "./components/builder-wheel";
import BuildMenu from "./components/build-menu";
import CharacterCustomization from "./components/character-customization";
import CraftMenu from "./components/craft-menu";
import CreditsScreen from "./components/credits-screen";
import DeathScreen from "./components/death-screen";
import DebugPage from "./components/debug-page";
import FishingMinigame from "./components/fishing-minigame";
import HUD from "./components/hud";
import Inventory from "./components/inventory";
import LoadingScreen from "./components/loading-screen";
import MapView from "./components/map-view";
import NotificationStack from "./components/notification-stack";
import PauseMenu from "./components/pause-menu";
import SettingsPanel from "./components/settings-panel";
import TradeMenu from "./components/trade-menu";
import { simBridge } from "./sim-bridge";
import { useGameStore } from "./stores/game-store";

export default function App() {
  const { ready, simReady, lutReady, renderer, showInventory, showMap, showBuildMenu,
    showCraftMenu, showFishingMinigame, showTradeMenu, showSettings, showPauseMenu,
    showCharacterCustomization, showCredits, playerDied, hudHidden, showBuilderWheel, isDev } = useGameStore();
  const showDebugPage = useDebugStore((s) => s.showDebugPage);
  const [pointerLocked, setPointerLocked] = useState(document.pointerLockElement !== null);
  const [f1Devtools, setF1Devtools] = useState(false);
  const [osrForcedFocus, setOsrForcedFocus] = useState(false);
  const osrForcedFocusRef = useRef(false);

  // FPS polling
  useEffect(() => {
    if (!renderer) return;
    const interval = setInterval(() => {
      useGameStore.getState().setFPS(renderer.getFPS());
    }, 500);
    return () => clearInterval(interval);
  }, [renderer]);

  // Global ESC handler — open pause menu or close topmost overlay
  useEffect(() => {
    if (!ready || !lutReady || !simReady) return;
    // Track whether TAB triggered the pointer lock exit
    let tabRequested = false;

    const onKey = (e: KeyboardEvent) => {
      // During OSR forced focus, suppress all game keyboard shortcuts
      if (osrForcedFocusRef.current && e.key !== "F8" && e.key !== "F9") return;
      // TAB toggles craft/inventory menu
      if (e.key === "Tab") {
        e.preventDefault();
        const s = useGameStore.getState();
        // If a panel is already open, close it (TAB acts as toggle)
        const anyPanelOpen = s.showSettings || s.showPauseMenu || s.showInventory ||
            s.showMap || s.showBuildMenu || s.showCraftMenu || s.showFishingMinigame ||
            s.showTradeMenu || s.showCharacterCustomization ||
            s.showCredits || s.showBuilderWheel;
        if (anyPanelOpen) {
          if (s.showSettings) s.toggleSettings();
          else if (s.showPauseMenu) s.togglePauseMenu();
          else if (s.showInventory) s.toggleInventory();
          else if (s.showMap) s.toggleMap();
          else if (s.showBuildMenu) s.toggleBuildMenu();
          else if (s.showCraftMenu) s.toggleCraftMenu();
          else if (s.showFishingMinigame) s.toggleFishingMinigame();
          else if (s.showTradeMenu) s.toggleTradeMenu();
          else if (s.showCharacterCustomization) s.toggleCharacterCustomization();
          else if (s.showCredits) s.toggleCredits();
          else if (s.showBuilderWheel) s.setShowBuilderWheel(false);
          return;
        }
        // No panel open — exit pointer lock first; the pointerlockchange
        // handler will open the craft menu once lock is released.
        if (document.pointerLockElement) {
          tabRequested = true;
          document.exitPointerLock();
        } else {
          s.toggleCraftMenu();
        }
        return;
      }
      // Single-key panel toggles (M=map, I=inventory, B=build)
      if (!e.repeat) {
        const key = e.key.toLowerCase();
        const s = useGameStore.getState();
        const anyPanelOpen = s.showSettings || s.showPauseMenu || s.showInventory ||
            s.showMap || s.showBuildMenu || s.showCraftMenu || s.showFishingMinigame ||
            s.showTradeMenu || s.showCharacterCustomization ||
            s.showCredits || s.showBuilderWheel;
        if (key === "m" && (s.showMap || !anyPanelOpen)) {
          e.preventDefault();
          s.toggleMap();
          if (!s.showMap) document.exitPointerLock();
          return;
        }
        if (key === "i" && (s.showInventory || !anyPanelOpen)) {
          e.preventDefault();
          s.toggleInventory();
          if (!s.showInventory) document.exitPointerLock();
          return;
        }
        if (key === "b" && (s.showBuildMenu || !anyPanelOpen)) {
          e.preventDefault();
          s.toggleBuildMenu();
          if (!s.showBuildMenu) document.exitPointerLock();
          return;
        }
        if (key === "f" && !anyPanelOpen) {
          e.preventDefault();
          s.renderer?.toggleFlashlight();
          return;
        }
      }
      // H — toggle HUD visibility (only in freecam, for screenshots/recording)
      if (!e.repeat && e.key.toLowerCase() === "h") {
        const s = useGameStore.getState();
        const simReader = (s.renderer as any)?.simReader;
        if (simReader?.isValid?.()) {
          const slot = simReader.getPlayerSlot(0);
          if (slot) {
            const camMode = slot.u32[2]; // PLR.CAMERA_MODE offset
            if (camMode === 2) { // CameraMode.FreeCam
              s.setHudHidden(!s.hudHidden);
            }
          }
        }
        return;
      }
      // F1 — toggle pointer lock for devtools without opening any overlay
      if (e.key === "F1") {
        e.preventDefault();
        if (document.pointerLockElement) {
          const s = useGameStore.getState();
          s.setSuppressPauseMenu(true);
          setF1Devtools(true);
          document.exitPointerLock();
        } else if (f1Devtools) {
          const r = useGameStore.getState().renderer;
          if (r) r.lockPointer();
        }
        return;
      }
      if (e.key !== "Escape") return;
      const s = useGameStore.getState();
      if (s.showSettings) s.toggleSettings();
      else if (s.showPauseMenu) s.togglePauseMenu();
      else if (s.showInventory) s.toggleInventory();
      else if (s.showMap) s.toggleMap();
      else if (s.showBuildMenu) s.toggleBuildMenu();
      else if (s.showCraftMenu) s.toggleCraftMenu();
      else if (s.showFishingMinigame) s.toggleFishingMinigame();
      else if (s.showTradeMenu) s.toggleTradeMenu();
      else if (s.showCharacterCustomization) s.toggleCharacterCustomization();
      else if (s.showCredits) s.toggleCredits();
      else if (s.showBuilderWheel) s.setShowBuilderWheel(false);
      else s.togglePauseMenu();
    };
    // F3 toggles debug page
    const onF3 = (e: KeyboardEvent) => {
      if (e.key === "F3") {
        e.preventDefault();
        useDebugStore.getState().toggleDebugPage();
      }
    };
    // F7 toggles profiling overlay (dev only)
    const onF7 = (e: KeyboardEvent) => {
      if (e.key === "F7" && isDev) {
        e.preventDefault();
        const r = useGameStore.getState().renderer;
        r?.toggleProfilingOverlay();
      }
    };
    // F2 toggles hitbox visualization
    const onF2 = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        useDebugStore.getState().toggleHitboxes();
      }
    };
    // F6 toggles debug raycast visualization
    const onF6 = (e: KeyboardEvent) => {
      if (e.key === "F6") {
        e.preventDefault();
        useDebugStore.getState().toggleRaycast();
      }
    };
    // F11 toggles fullscreen
    const onF11 = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        simBridge.toggleFullscreen();
      }
    };
    // F12 toggles DevTools
    const onF12 = (e: KeyboardEvent) => {
      if (e.key === "F12") {
        e.preventDefault();
        simBridge.toggleDevtools();
      }
    };
    // Numpad 0-9: force weather modes
    const onNumpad = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const map: Record<string, WeatherType> = {
        "Numpad0": WeatherType.Clear,
        "Numpad1": WeatherType.PartlyCloudy,
        "Numpad2": WeatherType.Overcast,
        "Numpad3": WeatherType.Rain,
        "Numpad4": WeatherType.Storm,
        "Numpad5": WeatherType.Fog,
        "Numpad6": WeatherType.Eclipse,
        "Numpad7": WeatherType.FullMoon,
        "Numpad8": WeatherType.HellStorm,
        "Numpad9": WeatherType.Snow,
      };
      const wt = map[e.code] ?? map[`Numpad${e.key}`];
      if (wt !== undefined) {
        e.preventDefault();
        simBridge.setWeather(wt);
      }
      // Numpad divide/asterisk/minus: set time of day
      const timeMap: Record<string, number> = {
        "NumpadDivide": 0.5,   // noon
        "NumpadMultiply": 0.75, // evening
        "NumpadSubtract": 0.0,  // midnight
      };
      const tod = timeMap[e.code];
      if (tod !== undefined) {
        e.preventDefault();
        simBridge.setTimeOfDay(tod);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onF3);
    window.addEventListener("keydown", onF7);
    window.addEventListener("keydown", onF2);
    window.addEventListener("keydown", onF6);
    window.addEventListener("keydown", onF11);
    window.addEventListener("keydown", onF12);
    window.addEventListener("keydown", onNumpad);

    // When pointer lock is active, the browser consumes the first Escape
    // to exit pointer lock — the keydown event never reaches JS. Listen
    // for pointerlockchange so one Escape opens the pause menu.
    const onPointerLockChange = () => {
      const locked = document.pointerLockElement !== null;
      setPointerLocked(locked);
      if (locked) {
        setF1Devtools(false);
        const s = useGameStore.getState();
        if (s.suppressPauseMenu) s.setSuppressPauseMenu(false);
      } else {
        const s = useGameStore.getState();
        if (s.suppressPauseMenu) return;
        if (s.playerDied) return;
        if (!s.showSettings && !s.showPauseMenu && !s.showInventory &&
            !s.showMap && !s.showBuildMenu && !s.showCraftMenu && !s.showFishingMinigame &&
            !s.showTradeMenu && !s.showCharacterCustomization &&
            !s.showCredits && !s.showBuilderWheel) {
          if (tabRequested) {
            s.toggleCraftMenu();
            tabRequested = false;
          } else {
            s.togglePauseMenu();
          }
        }
      }
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setPointerLocked(document.pointerLockElement !== null);
        const s = useGameStore.getState();
        const anyOpen = s.showSettings || s.showPauseMenu || s.showInventory ||
            s.showMap || s.showBuildMenu || s.showCraftMenu || s.showFishingMinigame ||
            s.showTradeMenu || s.showCharacterCustomization ||
            s.showCredits || s.showBuilderWheel;
        if (!anyOpen && !document.pointerLockElement) {
          const r = useGameStore.getState().renderer;
          if (r) r.lockPointer();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const onOSRFocusChange = (e: Event) => {
      const val = (e as CustomEvent).detail;
      osrForcedFocusRef.current = val;
      setOsrForcedFocus(val);
    };
    window.addEventListener("osr-forced-focus-change", onOSRFocusChange);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onF3);
      window.removeEventListener("keydown", onF7);
      window.removeEventListener("keydown", onF2);
      window.removeEventListener("keydown", onF6);
      window.removeEventListener("keydown", onF11);
      window.removeEventListener("keydown", onF12);
      window.removeEventListener("keydown", onNumpad);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("osr-forced-focus-change", onOSRFocusChange);
    };
  }, [ready, lutReady, simReady, isDev]);

  if (!ready || !lutReady || !simReady) {
    return <LoadingScreen />;
  }

  const anyOverlayOpen = showInventory || showMap || showBuildMenu || showCraftMenu ||
    showFishingMinigame || showTradeMenu || showSettings || showPauseMenu ||
    showCharacterCustomization || showCredits || showBuilderWheel;

  return (
    <div className="w-full h-full relative overflow-hidden pointer-events-none">
      {/* HUD Overlay — canvas is in index.html, managed by WebGPURenderer */}
      {!hudHidden && (
        <div className="absolute inset-0 pointer-events-none">
          <HUD />
          <NotificationStack />
        </div>
      )}

      {/* Click-to-resume overlay — shown when pointer lock is lost but no menu is open */}
      {ready && lutReady && simReady && !pointerLocked && !anyOverlayOpen && !playerDied && !f1Devtools && !osrForcedFocus && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-auto bg-ocean-950/60 cursor-pointer"
          onClick={() => {
            const r = useGameStore.getState().renderer;
            if (r) r.lockPointer();
          }}
        >
          <div className="text-center">
            <p className="text-ocean-100 text-xl font-bold mb-2">Click to resume</p>
            <p className="text-ocean-300 text-sm">Camera controls will be restored</p>
          </div>
        </div>
      )}

      {/* Modal Panels */}
      <div className="absolute inset-0 pointer-events-none">
        {showInventory && <Inventory />}
        {showMap && <MapView />}
        {showBuildMenu && <BuildMenu />}
        {showCraftMenu && <CraftMenu />}
        {showFishingMinigame && <FishingMinigame />}
        {showTradeMenu && <TradeMenu />}
        {showSettings && <SettingsPanel />}
        {showPauseMenu && <PauseMenu />}
        {showCharacterCustomization && <CharacterCustomization />}
        {showCredits && <CreditsScreen />}
      </div>

      {/* Builder wheel — radial menu for cell type selection */}
      {showBuilderWheel && <BuilderWheel />}

      {/* Debug page — F3 toggle */}
      {showDebugPage && <DebugPage />}

      {/* Death screen — shown when player dies, above all other UI */}
      {playerDied && <DeathScreen />}
    </div>
  );
}
