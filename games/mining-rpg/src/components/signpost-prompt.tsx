// ============================================================================
// SignpostPrompt — shown when the player is near the surface signpost.
//
// Displays a simple "Press E to sell" prompt with inventory value, and a
// hint to press O for the shop (build materials, upgrades, crafting).
// The full shop UI is in the ShopPanel component (toggled with O).
// ============================================================================

import { SELL_PRICES } from "../shared/constants";
import { CRAFTED_SELL_PRICES } from "../shared/crafting-recipes";
import type { CraftedItemId } from "../shared/types";
import { useGameStore } from "../stores/game-store";

const promptStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "14px 28px",
  background: "rgba(0,0,0,0.75)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#fff",
  pointerEvents: "none",
  zIndex: 15,
  whiteSpace: "nowrap",
};

const keyHintStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: "bold",
};

const currencyStyle: React.CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.7)",
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.5)",
  fontStyle: "italic",
};

const shopHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,215,0,0.6)",
  marginTop: 4,
  paddingTop: 4,
  borderTop: "1px solid rgba(255,255,255,0.1)",
};

export function SignpostPrompt() {
  const { nearSignpost, inventory, currency, craftedItems } = useGameStore();

  if (!nearSignpost) return null;

  const hasItems = inventory.length > 0;
  const itemCount = inventory.reduce((s, e) => s + e.count, 0);
  let inventoryValue = inventory.reduce((s, e) => s + (SELL_PRICES[e.mat] ?? 0) * e.count, 0);
  const craftedKeys = Object.keys(craftedItems) as CraftedItemId[];
  for (let i = 0; i < craftedKeys.length; i++) {
    inventoryValue += (CRAFTED_SELL_PRICES[craftedKeys[i]] ?? 0) * craftedItems[craftedKeys[i]];
  }

  return (
    <div style={promptStyle}>
      <style>{`
        @keyframes sellHintPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      <div style={{ ...keyHintStyle, ...(hasItems ? { animation: "sellHintPulse 1.5s ease-in-out infinite", color: "#ffd700" } : {}) }}>
        {hasItems ? "Press E to sell" : "Inventory empty"}
      </div>
      {hasItems ? (
        <div style={currencyStyle}>
          {itemCount} items — value: <span style={{ color: "#e6c833" }}>{inventoryValue}g</span>
        </div>
      ) : (
        <div style={emptyStyle}>Mine some ore and come back!</div>
      )}
      <div style={currencyStyle}>Gold: <span style={{ color: "#e6c833" }}>{currency}</span></div>
      <div style={shopHintStyle}>Press O for Shop (build, upgrades, furnace)</div>
    </div>
  );
}
