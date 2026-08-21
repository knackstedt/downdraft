import { useEffect } from "react";
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
import { SignpostOverlay } from "./components/signpost-overlay";
import { SignpostPrompt } from "./components/signpost-prompt";
import { StatsPanel } from "./components/stats-panel";
import { TitleScreen } from "./components/title-screen";
import { WelcomeBack } from "./components/welcome-back";
import { createCraftedItems, createPlayerStats } from "./shared/types";
import { useGameStore } from "./stores/game-store";

const helpStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  color: "rgba(255,255,255,0.6)",
  fontFamily: "monospace",
  fontSize: 12,
  padding: 8,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
  pointerEvents: "none",
  zIndex: 10,
};

export default function App() {
  const { paused, showEscapeMenu } = useGameStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        const s = useGameStore.getState();
        s.setPaused(!s.paused);
      }
      if (e.key === "i" || e.key === "I") {
        const s = useGameStore.getState();
        s.setShowInventory(!s.showInventory);
      }
      if (e.key === "e" || e.key === "E") {
        const s = useGameStore.getState();
        if (s.nearSignpost && s.inventory.length > 0) {
          s.sellAll();
        }
      }
      // Build mode: B toggles, 1/2/3/4 select scaffolding/ladder/rope/torch.
      if (e.key === "b" || e.key === "B") {
        useGameStore.getState().toggleBuildMode();
      }
      if (e.key === "1") useGameStore.getState().selectBuild("scaffolding");
      if (e.key === "2") useGameStore.getState().selectBuild("ladder");
      if (e.key === "3") useGameStore.getState().selectBuild("rope");
      if (e.key === "4") useGameStore.getState().selectBuild("torch");
      // L toggles the headlamp (player light source)
      if (e.key === "l" || e.key === "L") {
        useGameStore.getState().toggleHeadlamp();
      }
      // F3 toggles noclip (dev cheat): free flight through terrain, no
      // gravity/collision/damage. Useful for inspecting generation and
      // testing features without playing through normally.
      if (e.key === "F3") {
        e.preventDefault();
        useGameStore.getState().toggleNoclip();
      }
      if (e.key === "Escape") {
        const s = useGameStore.getState();
        // Don't toggle ESC menu if the death menu is open
        if (s.gameOver) return;
        const nowOpen = !s.showEscapeMenu;
        s.setShowEscapeMenu(nowOpen);
        s.setPaused(nowOpen);
        if (nowOpen) {
          (s.renderer as { pause?: () => void } | null)?.pause?.();
        } else {
          (s.renderer as { resume?: () => void } | null)?.resume?.();
        }
      }
      // Tab toggles the stats panel (doesn't pause the game)
      if (e.key === "Tab") {
        e.preventDefault();
        useGameStore.getState().toggleStats();
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
        useGameStore.getState().toggleAchievements();
      }
      // T teleports to surface (costs gold based on depth)
      if (e.key === "t" || e.key === "T") {
        const s = useGameStore.getState();
        if (s.gameOver || s.paused || s.showEscapeMenu) return;
        const r = s.renderer as { teleportToSurface?: () => boolean } | null;
        r?.teleportToSurface?.();
      }
      // M toggles the minimap
      if (e.key === "m" || e.key === "M") {
        useGameStore.getState().toggleMinimap();
      }
      // F11 toggles HUD visibility (for screenshots)
      if (e.key === "F11") {
        e.preventDefault();
        useGameStore.getState().toggleHUD();
      }
      // R resets camera zoom to 1x
      if (e.key === "r" || e.key === "R") {
        const r = useGameStore.getState().renderer as { resetZoom?: () => void } | null;
        r?.resetZoom?.();
      }
      // F5 toggles FPS counter
      if (e.key === "F5") {
        e.preventDefault();
        useGameStore.getState().toggleFPS();
      }
      // F6 manually saves the game
      if (e.key === "F6") {
        e.preventDefault();
        const r = useGameStore.getState().renderer as { saveNow?: () => Promise<void> } | null;
        r?.saveNow?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const { showTitleScreen, setShowTitleScreen } = useGameStore();

  if (showTitleScreen) {
    return (
      <TitleScreen
        onStart={() => {
          setShowTitleScreen(false);
        }}
        onNewGame={async () => {
          // Delete save and reset the game
          const { deleteSave } = await import("./stores/save-system");
          await deleteSave();
          // Reset all store state
          const s = useGameStore.getState();
          s.setStats(createPlayerStats());
          s.setInventory([]);
          s.setCurrency(0);
          s.setUpgrades({ damage: 0, radius: 0, rate: 0, inventorySize: 0 });
          s.setCraftedItems(createCraftedItems());
          s.setUnlockedAchievements(new Set());
          s.setWelcomeBack(null);
          // Reload the page to restart the game
          window.location.reload();
        }}
      />
    );
  }

  return (
    <>
      <HUD />
      <Minimap />
      <InventoryPanel />
      <SignpostOverlay />
      <SignpostPrompt />
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
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | Right-click: bomb | B: build | I: inventory | Tab: stats | F4: achievements | M: map | H: help | E: sell | T: teleport | R: reset zoom | F3: noclip | F5: FPS | F6: save | F11: hide HUD | ESC: menu | Upgrades at signpost
        {paused && " | PAUSED"}
      </div>
    </>
  );
}
