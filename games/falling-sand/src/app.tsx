import { useEffect, useState } from "react";
import { useGameStore } from "./stores/game-store";

const materialNames = [
  "Empty",
  "Sand",
  "Water",
  "Stone",
  "Wood",
  "Fire",
  "Smoke",
  "Oil",
  "Gunpowder",
  "Iron",
  "Lava",
  "Steam",
  "Plant",
  "Flesh",
];

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "rgba(255,255,255,0.8)",
  fontFamily: "monospace",
  fontSize: 12,
  pointerEvents: "auto",
  padding: 8,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
};

const selectStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.8)",
  color: "white",
  fontSize: 12,
  padding: 4,
  marginTop: 4,
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.2)",
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
};

export default function App() {
  const { fps, selectedMaterial, health, paused } = useGameStore();
  const [selected, setSelected] = useState(selectedMaterial);

  useEffect(() => {
    useGameStore.getState().setSelectedMaterial(selected);
  }, [selected]);

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div>FPS: {fps ?? 0}</div>
        <div>Health: {health}</div>
        <div>Material: {materialNames[selected] ?? "Unknown"}</div>
        <select
          style={selectStyle}
          value={selected}
          onChange={(e) => setSelected(parseInt(e.target.value, 10))}
        >
          {materialNames.map((name, i) => (
            <option key={name} value={i}>
              {i}: {name}
            </option>
          ))}
        </select>
        {paused && <div style={{ color: "yellow" }}>PAUSED</div>}
      </div>
      <div style={helpStyle}>
        WASD / Space • Left-click paint • Right-click ignite • E magnet
      </div>
    </div>
  );
}
