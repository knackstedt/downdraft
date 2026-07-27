import React from "react";
import { useGameStore } from "../stores/gameStore";

const MODULE_CATEGORIES = ["Exterior", "Interior", "Storage", "Utility", "Decor"];

export default function BuildMenu() {
  const toggle = useGameStore((s) => s.toggleBuildMenu);
  const [category, setCategory] = React.useState("Exterior");

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto" onClick={toggle}>
      <div className="hud-panel p-6 max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-ocean-100 mb-4">Ship Builder</h2>

        <div className="flex gap-2 mb-4">
          {MODULE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`btn ${category === cat ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-3 mb-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="hud-panel p-3 cursor-pointer hover:bg-ocean-700/50 transition-colors"
            >
              <div className="w-full h-20 bg-ocean-800 rounded flex items-center justify-center text-ocean-500">
                Module {i + 1}
              </div>
              <div className="text-sm text-ocean-200 mt-2">Module Name</div>
              <div className="text-xs text-ocean-400">Cost: 10 wood</div>
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center">
          <div className="text-sm text-ocean-400">
            Hull Integrity: <span className="text-biome-safe">100%</span>
          </div>
          <button className="btn-secondary" onClick={toggle}>Close [B]</button>
        </div>
      </div>
    </div>
  );
}
