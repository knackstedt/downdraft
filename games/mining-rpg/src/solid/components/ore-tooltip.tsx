// ============================================================================
// OreTooltip — shows the material name and sell price when the mouse hovers
// over a cell in the world. Updates every frame via requestAnimationFrame.
//
// Positioned near the mouse cursor. Only shows when the hovered cell contains
// a material (not air). Uses the renderer's getHoveredCell() method to read
// the grid at the mouse position.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { SELL_PRICES } from "../../shared/constants";
import { gameStore, rendererSnapshot } from "../stores/game-store";
import type { JSX } from "solid-js";

const tooltipStyle = (x: number, y: number): JSX.CSSProperties => ({
  position: "absolute",
  left: `${x + 14}px`,
  top: `${y + 14}px`,
  "z-index": "15",
  "pointer-events": "none",
  "font-family": "monospace",
  "font-size": "12px",
  padding: "4px 8px",
  background: "rgba(0,0,0,0.85)",
  border: "1px solid rgba(255,255,255,0.2)",
  "border-radius": "4px",
  color: "#fff",
  "white-space": "nowrap",
  "box-shadow": "0 2px 6px rgba(0,0,0,0.4)",
});

const swatchStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "8px",
  height: "8px",
  "border-radius": "2px",
  background: color,
  "margin-right": "4px",
  border: "1px solid rgba(255,255,255,0.2)",
  "vertical-align": "middle",
});

const priceStyle: JSX.CSSProperties = {
  color: "#ffd700",
  "margin-left": "6px",
  "font-weight": "bold",
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
  const [tooltip, setTooltip] = createSignal<{ x: number; y: number; name: string; color: string; price: number } | null>(null);

  onMount(() => {
    let raf = 0;
    const tick = () => {
      const snap = rendererSnapshot();
      // Don't show tooltip when menus are open
      if (!snap || gameStore.showEscapeMenu || gameStore.gameOver || gameStore.showInventory || gameStore.showStats || gameStore.showAchievements) {
        if (tooltip()) setTooltip(null);
        raf = requestAnimationFrame(tick);
        return;
      }

      if (snap.hoveredMat === 0) {
        if (tooltip()) setTooltip(null);
        raf = requestAnimationFrame(tick);
        return;
      }

      const info = MATERIAL_NAMES[snap.hoveredMat];
      if (!info) {
        if (tooltip()) setTooltip(null);
        raf = requestAnimationFrame(tick);
        return;
      }

      const price = SELL_PRICES[snap.hoveredMat] ?? 0;
      setTooltip({
        x: snap.mouseX,
        y: snap.mouseY,
        name: info.name,
        color: info.color,
        price,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const t = createMemo(() => tooltip());

  return (
    <Show when={t()}>
      {(tt) => (
        <div style={tooltipStyle(tt().x, tt().y)}>
          <span style={swatchStyle(tt().color)} />
          {tt().name}
          <Show when={tt().price > 0}>
            <span style={priceStyle}>{tt().price}g</span>
          </Show>
        </div>
      )}
    </Show>
  );
}
