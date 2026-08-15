import { useEffect } from "react";
import { useGameStore } from "./stores/game-store";

const hudStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "rgba(255,255,255,0.85)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "8px 12px",
  background: "rgba(0,0,0,0.6)",
  borderRadius: 4,
  pointerEvents: "none",
  zIndex: 10,
};

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
  const { fps, health, depth, paused, loadedChunks, activeChunks } = useGameStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        const s = useGameStore.getState();
        s.setPaused(!s.paused);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <div style={hudStyle}>
        <div>FPS: {fps ?? "—"}</div>
        <div>Health: {health}</div>
        <div>Depth: {depth} chunks</div>
        <div>Chunks: {loadedChunks} loaded, {activeChunks} active</div>
        {paused && <div style={{ color: "#ff5252" }}>PAUSED</div>}
      </div>
      <div style={helpStyle}>
        WASD/Arrows: move | Space: jump | Left-click: dig | P: pause
      </div>
    </>
  );
}
