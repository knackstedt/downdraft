// ============================================================================
// SolidApp — SolidJS root component for the worker-side UI.
//
// Mirrors the React App component but uses the Solid game store + Solid
// components. Runs entirely in the UI worker via the undertow DOM proxy.
// ============================================================================

import type { JSX } from "solid-js";
import { Show, onCleanup, onMount } from "solid-js";
import { createCraftedItems, createPlayerStats } from "../shared/types";
import { AchievementNotification } from "./components/achievement-notification";
import { AchievementsPanel } from "./components/achievements-panel";
import { BombOverlay } from "./components/bomb-overlay";
import { ChunkDebugOverlay } from "./components/chunk-debug-overlay";
import { DangerVignette } from "./components/danger-vignette";
import { DeathMenu } from "./components/death-menu";
import { DepthNotification } from "./components/depth-notification";
import { EscapeMenu } from "./components/escape-menu";
import { HUD } from "./components/hud";
import { InventoryPanel } from "./components/inventory-panel";
import { KeyBindingsOverlay } from "./components/key-bindings-overlay";
import { Minimap } from "./components/minimap";
import { OreTooltip } from "./components/ore-tooltip";
import { ParticleEffects } from "./components/particle-effects";
import { ScreenShake } from "./components/screen-shake";
import { ShopPanel } from "./components/shop-panel";
import { SignpostOverlay } from "./components/signpost-overlay";
import { SignpostPrompt } from "./components/signpost-prompt";
import { StatsPanel } from "./components/stats-panel";
import { TitleScreen } from "./components/title-screen";
import { VillageOverlay } from "./components/village-overlay";
import { WelcomeBack } from "./components/welcome-back";
import { actions, gameStore } from "./stores/game-store";

const helpStyle: JSX.CSSProperties = {
  position: "absolute",
  bottom: "8px",
  left: "8px",
  color: "rgba(255,255,255,0.6)",
  "font-family": "monospace",
  "font-size": "12px",
  padding: "8px",
  background: "rgba(0,0,0,0.5)",
  "border-radius": "4px",
  "pointer-events": "none",
  "z-index": "10",
};

export default function SolidApp() {
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        actions.setPaused(!gameStore.paused);
      }
      if (e.key === "i" || e.key === "I") {
        actions.setShowInventory(!gameStore.showInventory);
      }
      if (e.key === "e" || e.key === "E") {
        if (gameStore.nearSignpost && gameStore.inventory.length > 0) {
          actions.sellAll();
        }
      }
      // Build mode: B toggles, 1/2/3/4 select scaffolding/ladder/rope/torch.
      if (e.key === "b" || e.key === "B") {
        actions.toggleBuildMode();
      }
      if (e.key === "1") actions.selectBuild("scaffolding");
      if (e.key === "2") actions.selectBuild("ladder");
      if (e.key === "3") actions.selectBuild("rope");
      if (e.key === "4") actions.selectBuild("torch");
      // L toggles the headlamp (player light source)
      if (e.key === "l" || e.key === "L") {
        actions.toggleHeadlamp();
      }
      // F3 toggles noclip (dev cheat): free flight through terrain, no
      // gravity/collision/damage. Useful for inspecting generation and
      // testing features without playing through normally.
      if (e.key === "F3") {
        e.preventDefault();
        actions.toggleNoclip();
      }
      if (e.key === "Escape") {
        // Don't toggle ESC menu if the death menu is open
        if (gameStore.gameOver) return;
        const nowOpen = !gameStore.showEscapeMenu;
        actions.setShowEscapeMenu(nowOpen);
        actions.setPaused(nowOpen);
        if (nowOpen) {
          actions.pause();
        } else {
          actions.resume();
        }
      }
      // Tab toggles the stats panel (doesn't pause the game)
      if (e.key === "Tab") {
        e.preventDefault();
        actions.toggleStats();
      }
      // A toggles the achievements panel (doesn't pause the game)
      if (e.key === "a" || e.key === "A") {
        // Don't toggle if the player is moving left (a = left in WASD)
        // Only toggle on A keyup... actually, let's use a different key.
        // We'll use F4 for achievements to avoid conflict with WASD movement.
      }
      // F4 toggles the achievements panel (doesn't pause the game)
      if (e.key === "F4") {
        e.preventDefault();
        actions.toggleAchievements();
      }
      // T teleports to surface (costs gold based on depth)
      if (e.key === "t" || e.key === "T") {
        if (gameStore.gameOver || gameStore.paused || gameStore.showEscapeMenu) return;
        actions.teleport();
      }
      // M toggles the minimap
      if (e.key === "m" || e.key === "M") {
        actions.toggleMinimap();
      }
      // F11 toggles HUD visibility (for screenshots)
      if (e.key === "F11") {
        e.preventDefault();
        actions.toggleHUD();
      }
      // R resets camera zoom to 1x
      if (e.key === "r" || e.key === "R") {
        actions.setZoom(1);
      }
      // F5 toggles FPS counter
      if (e.key === "F5") {
        e.preventDefault();
        actions.toggleFPS();
      }
      // H toggles the help/keybindings bar
      if (e.key === "h" || e.key === "H") {
        actions.toggleHelp();
      }
      // O toggles the shop panel (only works near the signpost)
      if (e.key === "o" || e.key === "O") {
        if (gameStore.nearSignpost) actions.toggleShop();
      }
      // F6 manually saves the game
      if (e.key === "F6") {
        e.preventDefault();
        actions.save();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <Show when={!gameStore.showTitleScreen} fallback={
      <TitleScreen
        onStart={() => actions.setShowTitleScreen(false)}
        onNewGame={async () => {
          // Delete save and reset the game
          actions.deleteSave();
          // Reset all store state
          actions.setStats(createPlayerStats());
          actions.setInventory([]);
          actions.setCurrency(0);
          actions.setUpgrades({ damage: 0, radius: 0, rate: 0, inventorySize: 0 });
          actions.setCraftedItems(createCraftedItems());
          actions.setUnlockedAchievements([]);
          actions.setWelcomeBack(null);
          // Reload the page to restart the game
          window.location.reload();
        }}
      />
    }>
      <>
        <HUD />
        <Minimap />
        <InventoryPanel />
        <SignpostOverlay />
        <SignpostPrompt />
        <VillageOverlay />
        <ShopPanel />
        <BombOverlay />
        <ChunkDebugOverlay />
        <DeathMenu />
        <EscapeMenu />
        <StatsPanel />
        <AchievementsPanel />
        <AchievementNotification />
        <KeyBindingsOverlay />
        <OreTooltip />
        <DepthNotification />
        <DangerVignette />
        <ParticleEffects />
        <ScreenShake />
        <WelcomeBack />
        <Show when={gameStore.showHelp}>
          <div style={helpStyle}>
            WASD/Arrows: move | Space: jump | Left-click: dig | Right-click: bomb | B: build | I: inventory | Tab: stats | F4: achievements | M: map | H: hide help | E: sell | O: shop | T: teleport | R: reset zoom | F3: noclip | F5: FPS | F6: save | F11: hide HUD | ESC: menu
            {gameStore.paused && " | PAUSED"}
          </div>
        </Show>
        <Show when={!gameStore.showHelp}>
          <div style={{ ...helpStyle, padding: "4px 8px", "font-size": "10px", color: "rgba(255,255,255,0.3)" }}>
            Press H for help
            {gameStore.paused && " | PAUSED"}
          </div>
        </Show>
      </>
    </Show>
  );
}
