import { useEffect } from "react";
import { BombOverlay } from "./components/bomb-overlay";
import { ChunkDebugOverlay } from "./components/chunk-debug-overlay";
import { DeathMenu } from "./components/death-menu";
import { EscapeMenu } from "./components/escape-menu";
import { HUD } from "./components/hud";
import { InventoryPanel } from "./components/inventory-panel";
import { SignpostOverlay } from "./components/signpost-overlay";
import { SignpostPrompt } from "./components/signpost-prompt";
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <HUD />
      <InventoryPanel />
      <SignpostOverlay />
      <SignpostPrompt />
      <BombOverlay />
      <ChunkDebugOverlay />
      <DeathMenu />
      <EscapeMenu />
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | Right-click: bomb | B: build mode | 1/2/3: select scaffolding/ladder/rope | P: pause | I: inventory | E: sell | F2: chunk borders | F3: noclip | ESC: menu
        {paused && " | PAUSED"}
      </div>
    </>
  );
}
