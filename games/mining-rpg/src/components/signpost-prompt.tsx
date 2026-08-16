// ============================================================================
// SignpostPrompt — shown when the player is near the surface signpost.
//
// Displays a "Press E to sell" prompt and the player's current currency.
// The signpost is at the surface spawn point (center of world). When the
// player is within SIGNPOST_RADIUS cells and at depth 0, the renderer sets
// nearSignpost=true in the game store, which triggers this prompt.
// ============================================================================

import { SELL_PRICES } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

const promptStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "16px 32px",
  background: "rgba(0,0,0,0.6)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#fff",
  pointerEvents: "none",
  zIndex: 15,
  whiteSpace: "nowrap",
};

const keyHintStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: "bold",
};

const currencyStyle: React.CSSProperties = {
  fontSize: 14,
  color: "rgba(255,255,255,0.7)",
};

const emptyStyle: React.CSSProperties = {
  fontSize: 13,
  color: "rgba(255,255,255,0.5)",
  fontStyle: "italic",
};

export function SignpostPrompt() {
  const { nearSignpost, inventory, currency } = useGameStore();

  if (!nearSignpost) return null;

  const hasItems = inventory.length > 0;
  const itemCount = inventory.reduce((s, e) => s + e.count, 0);
  const inventoryValue = inventory.reduce((s, e) => s + (SELL_PRICES[e.mat] ?? 0) * e.count, 0);

  return (
    <div style={promptStyle}>
      <div style={keyHintStyle}>
        {hasItems ? "Press E to sell inventory" : "Inventory empty"}
      </div>
      {hasItems ? (
        <div style={currencyStyle}>
          {itemCount} items &mdash; value: <span style={{ color: "#e6c833" }}>{inventoryValue}g</span>
        </div>
      ) : (
        <div style={emptyStyle}>Mine some ore and come back!</div>
      )}
      <div style={currencyStyle}>Gold: <span style={{ color: "#e6c833" }}>{currency}</span></div>
    </div>
  );
}
