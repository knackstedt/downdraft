// ============================================================================
// HUD — heads-up display overlay for the mining RPG.
//
// Shows: FPS, health bar, depth meter, dig brush radius, loaded/active chunks,
// and a compact ore inventory summary. Positioned at the top-left corner.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { useGameStore } from "../stores/game-store";

const containerStyle: React.CSSProperties = {
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
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const healthBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const barOuterStyle: React.CSSProperties = {
  width: 100,
  height: 10,
  background: "rgba(255,255,255,0.15)",
  borderRadius: 2,
  overflow: "hidden",
};

const barInnerStyle = (health: number): React.CSSProperties => ({
  width: `${Math.max(0, Math.min(100, health))}%`,
  height: "100%",
  background: health > 50 ? "#4caf50" : health > 25 ? "#ff9800" : "#f44336",
  transition: "width 0.2s",
});

const oreRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 4,
};

const oreItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
};

const oreSwatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
});

// Material ID → display name + color
const ORE_INFO: Record<number, { name: string; color: string }> = {
  [Material.TinOre]: { name: "Tin", color: "#b3b4b8" },
  [Material.CopperOre]: { name: "Copper", color: "#b87333" },
  [Material.IronOre]: { name: "Iron", color: "#8c7365" },
  [Material.BauxiteOre]: { name: "Bauxite", color: "#bf8066" },
  [Material.SilverOre]: { name: "Silver", color: "#d9d9e0" },
  [Material.GoldOre]: { name: "Gold", color: "#e6c833" },
  [Material.CobaltOre]: { name: "Cobalt", color: "#4059cc" },
  [Material.Coal]: { name: "Coal", color: "#1a1a1a" },
  [Material.Iron]: { name: "Iron Block", color: "#888" },
  [Material.Stone]: { name: "Stone", color: "#666" },
  [Material.Dirt]: { name: "Dirt", color: "#8b5a2b" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
};

export function HUD() {
  const { fps, health, depth, paused, loadedChunks, activeChunks, digRadius, inventory } = useGameStore();

  const depthMeters = depth * 128; // CHUNK_H = 128 cells, ~1m per cell

  return (
    <div style={containerStyle}>
      <div>FPS: {fps ?? "—"}</div>
      <div style={healthBarStyle}>
        <span>HP:</span>
        <div style={barOuterStyle}>
          <div style={barInnerStyle(health)} />
        </div>
        <span>{health}</span>
      </div>
      <div>Depth: {depth} chunks ({depthMeters}m)</div>
      <div>Brush: {digRadius} cells</div>
      <div>Chunks: {loadedChunks} loaded, {activeChunks} active</div>
      {paused && <div style={{ color: "#ff5252" }}>PAUSED</div>}
      {inventory.length > 0 && (
        <div style={oreRowStyle}>
          {inventory.map((entry) => {
            const info = ORE_INFO[entry.mat];
            if (!info) return null;
            return (
              <div key={entry.mat} style={oreItemStyle}>
                <span style={oreSwatchStyle(info.color)} />
                <span>{info.name}: {entry.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
