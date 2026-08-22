// ============================================================================
// InventoryPanel — ore/debris inventory display.
//
// Always shows a compact summary (bottom-right) with item count, capacity
// bar, and total sell value. When toggled with the "I" key, expands to a
// full panel showing every material with counts, swatches, sell values,
// build materials, and crafted bars.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { BUILD_MATERIAL_INFO, SELL_PRICES, type BuildMaterialType } from "../../shared/constants";
import { CRAFTED_ITEM_INFO, CRAFTED_SELL_PRICES } from "../../shared/crafting-recipes";
import type { CraftedItemId } from "../../shared/types";
import { actions, gameStore } from "../stores/game-store";

// --- Compact always-visible summary (bottom-right) ---
const compactStyle: JSX.CSSProperties = {
  position: "absolute",
  bottom: "8px",
  right: "8px",
  color: "rgba(255,255,255,0.85)",
  "font-family": "monospace",
  "font-size": "12px",
  padding: "6px 10px",
  background: "rgba(0,0,0,0.6)",
  "border-radius": "4px",
  border: "1px solid rgba(255,255,255,0.1)",
  "z-index": "10",
  "pointer-events": "none",
  display: "flex",
  "flex-direction": "column",
  gap: "3px",
  "align-items": "flex-end",
  "text-align": "right",
  "max-width": "220px",
};

const compactRowStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "4px",
  "flex-wrap": "wrap",
  "justify-content": "flex-end",
};

const compactSwatchStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "8px",
  height: "8px",
  "border-radius": "2px",
  background: color,
});

// --- Full panel (toggled with I) ---
const panelStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  color: "rgba(255,255,255,0.9)",
  "font-family": "monospace",
  "font-size": "13px",
  padding: "12px 16px",
  background: "rgba(0,0,0,0.8)",
  "border-radius": "4px",
  border: "1px solid rgba(255,255,255,0.15)",
  "z-index": "14",
  "min-width": "200px",
  "max-width": "280px",
  "max-height": "80vh",
  "overflow-y": "auto",
  "pointer-events": "none",
  "scrollbar-width": "thin",
  "scrollbar-color": "rgba(255,255,255,0.2) rgba(255,255,255,0.05)",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "14px",
  "font-weight": "bold",
  "margin-bottom": "8px",
  "border-bottom": "1px solid rgba(255,255,255,0.15)",
  "padding-bottom": "4px",
};

const rowStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  padding: "3px 0",
};

const swatchStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "12px",
  height: "12px",
  "border-radius": "2px",
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
});

const emptyStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.4)",
  "font-style": "italic",
  "font-size": "12px",
};

const closeHintStyle: JSX.CSSProperties = {
  "text-align": "center",
  "margin-top": "8px",
  "padding-top": "6px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "10px",
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
  const totalItems = () => gameStore.inventory.reduce((sum, e) => sum + e.count, 0);

  // Calculate total sell value
  const sellValue = () => {
    let val = 0;
    for (let i = 0; i < gameStore.inventory.length; i++) {
      val += (SELL_PRICES[gameStore.inventory[i].mat] ?? 0) * gameStore.inventory[i].count;
    }
    const craftedKeys = Object.keys(gameStore.craftedItems) as CraftedItemId[];
    for (let i = 0; i < craftedKeys.length; i++) {
      val += (CRAFTED_SELL_PRICES[craftedKeys[i]] ?? 0) * gameStore.craftedItems[craftedKeys[i]];
    }
    return val;
  };

  const invUsed = () => actions.getInventoryCount();
  const invMax = () => actions.getMaxInventory();
  const invPct = () => invMax() > 0 ? (invUsed() / invMax()) * 100 : 0;
  const invColor = () => invPct() < 70 ? "#4caf50" : invPct() < 90 ? "#ff9800" : "#f44336";
  const oreEntries = () => gameStore.inventory.filter((e) => COMPACT_ORE_INFO[e.mat]).slice(0, 6);

  const sortedInv = () => [...gameStore.inventory].sort((a, b) => a.mat - b.mat);
  const buildTypes: BuildMaterialType[] = ["scaffolding", "ladder", "rope"];
  const craftedKeys = () => Object.keys(gameStore.craftedItems) as CraftedItemId[];
  const hasCrafted = () => craftedKeys().some((id) => gameStore.craftedItems[id] > 0);

  return (
    <Show
      when={gameStore.showInventory}
      fallback={
        <Show when={gameStore.showHUD}>
          <div style={compactStyle}>
            <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
              <span>Bag: {invUsed()}/{invMax()}</span>
              <div style={{ width: "60px", height: "6px", background: "rgba(255,255,255,0.15)", "border-radius": "2px", overflow: "hidden" }}>
                <div style={{ width: `${Math.min(100, invPct())}%`, height: "100%", background: invColor(), transition: "width 0.2s" }} />
              </div>
            </div>
            <Show when={oreEntries().length > 0}>
              <div style={compactRowStyle}>
                <For each={oreEntries()}>
                  {(entry) => {
                    const info = COMPACT_ORE_INFO[entry.mat];
                    return (
                      <span style={{ display: "inline-flex", "align-items": "center", gap: "2px", "font-size": "10px" }}>
                        <span style={compactSwatchStyle(info.color)} />
                        {entry.count}
                      </span>
                    );
                  }}
                </For>
              </div>
            </Show>
            <Show when={sellValue() > 0}>
              <div style={{ color: "rgba(255,215,0,0.6)", "font-size": "10px" }}>
                Worth: {sellValue()}g
              </div>
            </Show>
            <div style={{ "font-size": "9px", color: "rgba(255,255,255,0.3)" }}>I for details</div>
          </div>
        </Show>
      }
    >
      {/* --- Full panel (toggled with I) --- */}
      <div style={panelStyle} class="dd-inv-scroll">
        <style>{`
          .dd-inv-scroll::-webkit-scrollbar { width: 6px; }
          .dd-inv-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 3px; }
          .dd-inv-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
          .dd-inv-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
        `}</style>
        <div style={titleStyle}>Inventory ({totalItems()})</div>
        <Show when={sellValue() > 0}>
          <div style={{ ...rowStyle, color: "#ffd700", "font-weight": "bold", "font-size": "13px" }}>
            <span>Total Value:</span>
            <span style={{ "margin-left": "auto" }}>{sellValue()}g</span>
          </div>
        </Show>
        <Show
          when={sortedInv().length > 0}
          fallback={<div style={emptyStyle}>Empty — dig some ore!</div>}
        >
          <For each={sortedInv()}>
            {(entry) => {
              const info = MATERIAL_INFO[entry.mat] ?? { name: `Material #${entry.mat}`, color: "#888" };
              const itemValue = (SELL_PRICES[entry.mat] ?? 0) * entry.count;
              return (
                <div style={rowStyle}>
                  <span style={swatchStyle(info.color)} />
                  <span>{info.name}</span>
                  <span style={{ "margin-left": "auto", "font-weight": "bold" }}>{entry.count}</span>
                  <Show when={itemValue > 0}>
                    <span style={{ "margin-left": "8px", color: "rgba(255,215,0,0.5)", "font-size": "10px" }}>
                      {itemValue}g
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
        <div style={{ ...titleStyle, "margin-top": "8px" }}>Build Materials</div>
        <For each={buildTypes}>
          {(type) => {
            const info = BUILD_MATERIAL_INFO[type];
            return (
              <div style={rowStyle}>
                <span style={swatchStyle(info.color)} />
                <span>{info.name}</span>
                <span style={{ "margin-left": "auto", "font-weight": "bold" }}>{gameStore.buildMaterials[type]}</span>
              </div>
            );
          }}
        </For>
        <Show when={hasCrafted()}>
          <div style={{ ...titleStyle, "margin-top": "8px" }}>Crafted Bars</div>
          <For each={craftedKeys().filter((id) => gameStore.craftedItems[id] > 0)}>
            {(id) => {
              const info = CRAFTED_ITEM_INFO[id];
              return (
                <div style={rowStyle}>
                  <span style={swatchStyle(info.color)} />
                  <span>{info.name}</span>
                  <span style={{ "margin-left": "auto", "font-weight": "bold" }}>{gameStore.craftedItems[id]}</span>
                </div>
              );
            }}
          </For>
        </Show>
        <div style={closeHintStyle}>Press I to close</div>
      </div>
    </Show>
  );
}
