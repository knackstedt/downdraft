import { useEffect } from "react";
import { BombOverlay } from "./components/bomb-overlay";
import { DeathMenu } from "./components/death-menu";
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
  const { paused } = useGameStore();

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
      <DeathMenu />
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | Right-click: bomb | P: pause | I: inventory | E: sell
        {paused && " | PAUSED"}
      </div>
    </>
  );
}
