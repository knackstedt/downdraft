import { useEffect } from "react";
import { DeathMenu } from "./components/death-menu";
import { HUD } from "./components/hud";
import { InventoryPanel } from "./components/inventory-panel";
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <HUD />
      <InventoryPanel />
      <DeathMenu />
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | P: pause | I: inventory
        {paused && " | PAUSED"}
      </div>
    </>
  );
}
