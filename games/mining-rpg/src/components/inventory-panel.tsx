// ============================================================================
// InventoryPanel — detailed ore/debris inventory display.
//
// Toggled with the "I" key. Shows all collected materials with counts,
// color swatches, and names. Positioned at the right side of the screen.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { BUILD_MATERIAL_INFO, type BuildMaterialType } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  color: "rgba(255,255,255,0.9)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "12px 16px",
  background: "rgba(0,0,0,0.7)",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.1)",
  zIndex: 10,
  minWidth: 180,
  pointerEvents: "none",
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 8,
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  paddingBottom: 4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 0",
};

const swatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 12,
  height: 12,
  borderRadius: 2,
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
});

const emptyStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.4)",
  fontStyle: "italic",
  fontSize: 12,
};

// Material ID → display name + color
const MATERIAL_INFO: Record<number, { name: string; color: string }> = {
  [Material.TinOre]: { name: "Tin Ore", color: "#b3b4b8" },
  [Material.CopperOre]: { name: "Copper Ore", color: "#b87333" },
  [Material.IronOre]: { name: "Iron Ore", color: "#8c7365" },
  [Material.BauxiteOre]: { name: "Bauxite Ore", color: "#bf8066" },
  [Material.SilverOre]: { name: "Silver Ore", color: "#d9d9e0" },
  [Material.GoldOre]: { name: "Gold Ore", color: "#e6c833" },
  [Material.CobaltOre]: { name: "Cobalt Ore", color: "#4059cc" },
  [Material.Coal]: { name: "Coal", color: "#1a1a1a" },
  [Material.Iron]: { name: "Iron Block", color: "#888888" },
  [Material.Stone]: { name: "Stone", color: "#666666" },
  [Material.Dirt]: { name: "Dirt", color: "#8b5a2b" },
  [Material.Gravel]: { name: "Gravel", color: "#666560" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#6b6b6e" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
};

export function InventoryPanel() {
  const { inventory, showInventory, buildMaterials } = useGameStore();

  if (!showInventory) return null;

  // Sort: ores first (by material ID), then other materials
  const sorted = [...inventory].sort((a, b) => a.mat - b.mat);
  const totalItems = inventory.reduce((sum, e) => sum + e.count, 0);
  const buildTypes: BuildMaterialType[] = ["scaffolding", "ladder", "rope"];

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Inventory ({totalItems})</div>
      {sorted.length === 0 ? (
        <div style={emptyStyle}>Empty — dig some ore!</div>
      ) : (
        sorted.map((entry) => {
          const info = MATERIAL_INFO[entry.mat] ?? { name: `Material #${entry.mat}`, color: "#888" };
          return (
            <div key={entry.mat} style={rowStyle}>
              <span style={swatchStyle(info.color)} />
              <span>{info.name}</span>
              <span style={{ marginLeft: "auto", fontWeight: "bold" }}>{entry.count}</span>
            </div>
          );
        })
      )}
      <div style={{ ...titleStyle, marginTop: 8 }}>Build Materials</div>
      {buildTypes.map((type) => {
        const info = BUILD_MATERIAL_INFO[type];
        return (
          <div key={type} style={rowStyle}>
            <span style={swatchStyle(info.color)} />
            <span>{info.name}</span>
            <span style={{ marginLeft: "auto", fontWeight: "bold" }}>{buildMaterials[type]}</span>
          </div>
        );
      })}
    </div>
  );
}
