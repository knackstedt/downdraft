import { useEffect } from "react";
import { AchievementNotification } from "./components/achievement-notification";
import { AchievementsPanel } from "./components/achievements-panel";
import { BombOverlay } from "./components/bomb-overlay";
import { ChunkDebugOverlay } from "./components/chunk-debug-overlay";
import { DeathMenu } from "./components/death-menu";
import { EscapeMenu } from "./components/escape-menu";
import { HUD } from "./components/hud";
import { InventoryPanel } from "./components/inventory-panel";
import { Minimap } from "./components/minimap";
import { SignpostOverlay } from "./components/signpost-overlay";
import { SignpostPrompt } from "./components/signpost-prompt";
import { StatsPanel } from "./components/stats-panel";
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | Right-click: bomb | B: build | I: inventory | Tab: stats | F4: achievements | H: help | E: sell | F3: noclip | ESC: menu | Upgrades at signpost
        {paused && " | PAUSED"}
      </div>
    </>
  );
}
