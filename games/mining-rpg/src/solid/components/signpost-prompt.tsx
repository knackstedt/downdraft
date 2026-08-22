// ============================================================================
// SignpostPrompt — shown when the player is near the surface signpost.
//
// Displays a simple "Press E to sell" prompt with inventory value, and a
// hint to press O for the shop (build materials, upgrades, crafting).
// The full shop UI is in the ShopPanel component (toggled with O).
// ============================================================================

import { Show } from "solid-js";
import { SELL_PRICES } from "../../shared/constants";
import { CRAFTED_SELL_PRICES } from "../../shared/crafting-recipes";
import type { CraftedItemId } from "../../shared/types";
import { gameStore } from "../stores/game-store";
import type { JSX } from "solid-js";

const promptStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "6px",
  padding: "14px 28px",
  background: "rgba(0,0,0,0.75)",
  border: "1px solid rgba(255,255,255,0.2)",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#fff",
  "pointer-events": "none",
  "z-index": "15",
  "white-space": "nowrap",
};

const keyHintStyle: JSX.CSSProperties = {
  "font-size": "16px",
  "font-weight": "bold",
};

const currencyStyle: JSX.CSSProperties = {
  "font-size": "13px",
  color: "rgba(255,255,255,0.7)",
};

const emptyStyle: JSX.CSSProperties = {
  "font-size": "12px",
  color: "rgba(255,255,255,0.5)",
  "font-style": "italic",
};

const shopHintStyle: JSX.CSSProperties = {
  "font-size": "11px",
  color: "rgba(255,215,0,0.6)",
  "margin-top": "4px",
  "padding-top": "4px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
};

export function SignpostPrompt() {
  const hasItems = () => gameStore.inventory.length > 0;
  const itemCount = () => gameStore.inventory.reduce((s, e) => s + e.count, 0);
  const inventoryValue = () => {
    let val = gameStore.inventory.reduce((s, e) => s + (SELL_PRICES[e.mat] ?? 0) * e.count, 0);
    const craftedKeys = Object.keys(gameStore.craftedItems) as CraftedItemId[];
    for (let i = 0; i < craftedKeys.length; i++) {
      val += (CRAFTED_SELL_PRICES[craftedKeys[i]] ?? 0) * gameStore.craftedItems[craftedKeys[i]];
    }
    return val;
  };

  return (
    <Show when={gameStore.nearSignpost}>
      <div style={promptStyle}>
        <style>{`
          @keyframes sellHintPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
        `}</style>
        <div style={{ ...keyHintStyle, ...(hasItems() ? { animation: "sellHintPulse 1.5s ease-in-out infinite", color: "#ffd700" } : {}) }}>
          {hasItems() ? "Press E to sell" : "Inventory empty"}
        </div>
        <Show
          when={hasItems()}
          fallback={<div style={emptyStyle}>Mine some ore and come back!</div>}
        >
          <div style={currencyStyle}>
            {itemCount()} items — value: <span style={{ color: "#e6c833" }}>{inventoryValue()}g</span>
          </div>
        </Show>
        <div style={currencyStyle}>Gold: <span style={{ color: "#e6c833" }}>{gameStore.currency}</span></div>
        <div style={shopHintStyle}>Press O for Shop (build, upgrades, furnace)</div>
      </div>
    </Show>
  );
}
