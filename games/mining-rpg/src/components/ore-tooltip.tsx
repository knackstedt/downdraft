// ============================================================================
// OreTooltip — shows the material name and sell price when the mouse hovers
// over a cell in the world. Updates every frame via requestAnimationFrame.
//
// Positioned near the mouse cursor. Only shows when the hovered cell contains
// a material (not air). Uses the renderer's getHoveredCell() method to read
// the grid at the mouse position.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { useEffect, useRef, useState } from "react";
import { SELL_PRICES } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

const tooltipStyle = (x: number, y: number): React.CSSProperties => ({
  position: "absolute",
  left: x + 14,
  top: y + 14,
  zIndex: 15,
  pointerEvents: "none",
  fontFamily: "monospace",
  fontSize: 12,
  padding: "4px 8px",
  background: "rgba(0,0,0,0.85)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  color: "#fff",
  whiteSpace: "nowrap",
  boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
});

const swatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
  marginRight: 4,
  border: "1px solid rgba(255,255,255,0.2)",
  verticalAlign: "middle",
});

const priceStyle: React.CSSProperties = {
  color: "#ffd700",
  marginLeft: 6,
  fontWeight: "bold",
};

const MATERIAL_NAMES: Record<number, { name: string; color: string }> = {
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
  [Material.Grass]: { name: "Grass", color: "#4a7c2f" },
  [Material.Gravel]: { name: "Gravel", color: "#73737a" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#73737a" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
  [Material.Water]: { name: "Water", color: "#29b6f6" },
  [Material.Lava]: { name: "Lava", color: "#ff5722" },
  [Material.Oil]: { name: "Oil", color: "#1a1a0a" },
  [Material.MethaneGas]: { name: "Methane", color: "#66bb6a" },
  [Material.SulfurGas]: { name: "Sulfur Gas", color: "#d4e157" },
};

export function OreTooltip() {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; color: string; price: number } | null>(null);
  const rafRef = useRef(0);
  // Ref mirror of current tooltip so the rAF loop can read it without being
  // re-created on every state change (which caused the loop to tear down and
  // restart constantly, leading to missed/flickering tooltips).
  const tooltipRef = useRef<typeof tooltip>(null);
  tooltipRef.current = tooltip;

  useEffect(() => {
    const tick = () => {
      const store = useGameStore.getState();
      const renderer = store.renderer as {
        getHoveredCell?: () => { mat: number; wx: number; wy: number };
        getMouseScreenPos?: () => { x: number; y: number };
      } | null;

      if (!renderer?.getHoveredCell || !renderer?.getMouseScreenPos) {
        if (tooltipRef.current) setTooltip(null);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Don't show tooltip when menus are open
      if (store.showEscapeMenu || store.gameOver || store.showInventory || store.showStats || store.showAchievements) {
        if (tooltipRef.current) setTooltip(null);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const cell = renderer.getHoveredCell();
      const mousePos = renderer.getMouseScreenPos();

      if (cell.mat === 0) {
        if (tooltipRef.current) setTooltip(null);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const info = MATERIAL_NAMES[cell.mat];
      if (!info) {
        if (tooltipRef.current) setTooltip(null);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const price = SELL_PRICES[cell.mat] ?? 0;
      setTooltip({
        x: mousePos.x,
        y: mousePos.y,
        name: info.name,
        color: info.color,
        price,
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  if (!tooltip) return null;

  return (
    <div style={tooltipStyle(tooltip.x, tooltip.y)}>
      <span style={swatchStyle(tooltip.color)} />
      {tooltip.name}
      {tooltip.price > 0 && <span style={priceStyle}>{tooltip.price}g</span>}
    </div>
  );
}
