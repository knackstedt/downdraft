// ============================================================================
// InventoryPanel — ore/debris inventory display.
//
// Always shows a compact summary (bottom-right) with item count, capacity
// bar, and total sell value. When toggled with the "I" key, expands to a
// full panel showing every material with counts, swatches, sell values,
// build materials, and crafted bars.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { BUILD_MATERIAL_INFO, SELL_PRICES, type BuildMaterialType } from "../shared/constants";
import { CRAFTED_ITEM_INFO, CRAFTED_SELL_PRICES } from "../shared/crafting-recipes";
import type { CraftedItemId } from "../shared/types";
import { useGameStore } from "../stores/game-store";

// --- Compact always-visible summary (bottom-right) ---
const compactStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  right: 8,
  color: "rgba(255,255,255,0.85)",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "6px 10px",
  background: "rgba(0,0,0,0.6)",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.1)",
  zIndex: 10,
  pointerEvents: "none",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  alignItems: "flex-end",
  textAlign: "right",
  maxWidth: 220,
};

const compactRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const compactSwatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
});

// --- Full panel (toggled with I) ---
const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  color: "rgba(255,255,255,0.9)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "12px 16px",
  background: "rgba(0,0,0,0.8)",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.15)",
  zIndex: 14,
  minWidth: 200,
  maxWidth: 280,
  maxHeight: "80vh",
  overflowY: "auto",
  pointerEvents: "none",
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(255,255,255,0.2) rgba(255,255,255,0.05)",
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

const closeHintStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 8,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 10,
  color: "rgba(255,255,255,0.4)",
};

// Compact ore swatches for the summary (only show ores, max 6)
const COMPACT_ORE_INFO: Record<number, { name: string; color: string }> = {
  [Material.TinOre]: { name: "Tin", color: "#b3b4b8" },
  [Material.CopperOre]: { name: "Cu", color: "#b87333" },
  [Material.IronOre]: { name: "Fe", color: "#8c7365" },
  [Material.BauxiteOre]: { name: "Bx", color: "#bf8066" },
  [Material.SilverOre]: { name: "Ag", color: "#d9d9e0" },
  [Material.GoldOre]: { name: "Au", color: "#e6c833" },
  [Material.CobaltOre]: { name: "Co", color: "#4059cc" },
  [Material.Coal]: { name: "Coal", color: "#1a1a1a" },
};

// Material ID → display name + color (full panel)
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
  [Material.Gravel]: { name: "Gravel", color: "#73737a" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#73737a" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
};

export function InventoryPanel() {
  const { inventory, showInventory, buildMaterials, craftedItems, showHUD, getMaxInventory, getInventoryCount } = useGameStore();

  const totalItems = inventory.reduce((sum, e) => sum + e.count, 0);

  // Calculate total sell value
  let sellValue = 0;
  for (let i = 0; i < inventory.length; i++) {
    sellValue += (SELL_PRICES[inventory[i].mat] ?? 0) * inventory[i].count;
  }
  const craftedKeys = Object.keys(craftedItems) as CraftedItemId[];
  for (let i = 0; i < craftedKeys.length; i++) {
    sellValue += (CRAFTED_SELL_PRICES[craftedKeys[i]] ?? 0) * craftedItems[craftedKeys[i]];
  }

  // --- Compact always-visible summary ---
  if (!showInventory) {
    if (!showHUD) return null;
    const invUsed = getInventoryCount();
    const invMax = getMaxInventory();
    const invPct = invMax > 0 ? (invUsed / invMax) * 100 : 0;
    const invColor = invPct < 70 ? "#4caf50" : invPct < 90 ? "#ff9800" : "#f44336";
    // Show up to 6 ore swatches in the compact view
    const oreEntries = inventory
      .filter((e) => COMPACT_ORE_INFO[e.mat])
      .slice(0, 6);

    return (
      <div style={compactStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>Bag: {invUsed}/{invMax}</span>
          <div style={{ width: 60, height: 6, background: "rgba(255,255,255,0.15)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ width: `${Math.min(100, invPct)}%`, height: "100%", background: invColor, transition: "width 0.2s" }} />
          </div>
        </div>
        {oreEntries.length > 0 && (
          <div style={compactRowStyle}>
            {oreEntries.map((entry) => {
              const info = COMPACT_ORE_INFO[entry.mat];
              return (
                <span key={entry.mat} style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10 }}>
                  <span style={compactSwatchStyle(info.color)} />
                  {entry.count}
                </span>
              );
            })}
          </div>
        )}
        {sellValue > 0 && (
          <div style={{ color: "rgba(255,215,0,0.6)", fontSize: 10 }}>
            Worth: {sellValue}g
          </div>
        )}
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>I for details</div>
      </div>
    );
  }

  // --- Full panel (toggled with I) ---
  const sorted = [...inventory].sort((a, b) => a.mat - b.mat);
  const buildTypes: BuildMaterialType[] = ["scaffolding", "ladder", "rope"];

  return (
    <div style={panelStyle} className="dd-inv-scroll">
      <style>{`
        .dd-inv-scroll::-webkit-scrollbar { width: 6px; }
        .dd-inv-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 3px; }
        .dd-inv-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
        .dd-inv-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
      `}</style>
      <div style={titleStyle}>Inventory ({totalItems})</div>
      {sellValue > 0 && (
        <div style={{ ...rowStyle, color: "#ffd700", fontWeight: "bold", fontSize: 13 }}>
          <span>Total Value:</span>
          <span style={{ marginLeft: "auto" }}>{sellValue}g</span>
        </div>
      )}
      {sorted.length === 0 ? (
        <div style={emptyStyle}>Empty — dig some ore!</div>
      ) : (
        sorted.map((entry) => {
          const info = MATERIAL_INFO[entry.mat] ?? { name: `Material #${entry.mat}`, color: "#888" };
          const itemValue = (SELL_PRICES[entry.mat] ?? 0) * entry.count;
          return (
            <div key={entry.mat} style={rowStyle}>
              <span style={swatchStyle(info.color)} />
              <span>{info.name}</span>
              <span style={{ marginLeft: "auto", fontWeight: "bold" }}>{entry.count}</span>
              {itemValue > 0 && (
                <span style={{ marginLeft: 8, color: "rgba(255,215,0,0.5)", fontSize: 10 }}>
                  {itemValue}g
                </span>
              )}
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
      {(Object.keys(craftedItems) as CraftedItemId[]).some((id) => craftedItems[id] > 0) && (
        <>
          <div style={{ ...titleStyle, marginTop: 8 }}>Crafted Bars</div>
          {(Object.keys(craftedItems) as CraftedItemId[])
            .filter((id) => craftedItems[id] > 0)
            .map((id) => {
              const info = CRAFTED_ITEM_INFO[id];
              return (
                <div key={id} style={rowStyle}>
                  <span style={swatchStyle(info.color)} />
                  <span>{info.name}</span>
                  <span style={{ marginLeft: "auto", fontWeight: "bold" }}>{craftedItems[id]}</span>
                </div>
              );
            })}
        </>
      )}
      <div style={closeHintStyle}>Press I to close</div>
    </div>
  );
}
