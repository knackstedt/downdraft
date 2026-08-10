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

export default function App() {
  const { fps, selectedMaterial, health, paused } = useGameStore();
  const [selected, setSelected] = useState(selectedMaterial);

  useEffect(() => {
    useGameStore.getState().setSelectedMaterial(selected);
  }, [selected]);

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="absolute top-2 left-2 text-white/80 font-mono text-xs pointer-events-auto p-2 bg-black/50 rounded">
        <div>FPS: {fps ?? 0}</div>
        <div>Health: {health}</div>
        <div>Material: {materialNames[selected] ?? "Unknown"}</div>
        <select
          className="bg-black/80 text-white text-xs p-1 mt-1 rounded"
          value={selected}
          onChange={(e) => setSelected(parseInt(e.target.value, 10))}
        >
          {materialNames.map((name, i) => (
            <option key={name} value={i}>
              {i}: {name}
            </option>
          ))}
        </select>
        <div className="mt-1 text-white/60">
          {paused ? "PAUSED" : ""}
        </div>
      </div>
      <div className="absolute bottom-2 left-2 text-white/60 font-mono text-xs p-2 bg-black/50 rounded">
        WASD / Space • Left-click paint • Right-click ignite • E magnet
      </div>
    </div>
  );
}
