// ============================================================================
// SignpostPrompt — shown when the player is near the surface signpost.
//
// Displays a "Press E to sell" prompt, the player's current currency, and a
// shop where the player can buy build materials (scaffolding, ladders, ropes)
// with gold. The signpost is at the surface spawn point (center of world).
// When the player is within SIGNPOST_RADIUS cells and at depth 0, the renderer
// sets nearSignpost=true in the game store, which triggers this prompt.
// ============================================================================

import { BUILD_MATERIAL_INFO, BUILD_MATERIAL_PRICES, SELL_PRICES, type BuildMaterialType } from "../shared/constants";
import { useGameStore } from "../stores/game-store";
import { CraftingPanel } from "./crafting-panel";
import { UpgradeShop } from "./upgrade-shop";

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
  background: "rgba(0,0,0,0.7)",
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

const shopTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: "bold",
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.15)",
  color: "rgba(255,255,255,0.85)",
};

const shopRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "2px 0",
};

const swatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: 2,
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
});

const buyBtnStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#fff",
  background: "rgba(255,215,0,0.18)",
  border: "1px solid rgba(255,215,0,0.5)",
  borderRadius: 3,
  padding: "2px 6px",
  cursor: "pointer",
  pointerEvents: "auto",
};

const BUILD_TYPES: BuildMaterialType[] = ["scaffolding", "ladder", "rope", "torch"];

export function SignpostPrompt() {
  const { nearSignpost, inventory, currency, buildMaterials } = useGameStore();

  if (!nearSignpost) return null;

  const hasItems = inventory.length > 0;
  const itemCount = inventory.reduce((s, e) => s + e.count, 0);
  const inventoryValue = inventory.reduce((s, e) => s + (SELL_PRICES[e.mat] ?? 0) * e.count, 0);

  const buy = (type: BuildMaterialType, qty: number) => {
    const renderer = useGameStore.getState().renderer as
      | { buyBuildMaterial?: (type: BuildMaterialType, qty: number) => boolean }
      | null;
    renderer?.buyBuildMaterial?.(type, qty);
  };

  return (
    <div style={promptStyle}>
      {hasItems && (
        <style>{`
          @keyframes sellHintPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
          }
        `}</style>
      )}
      <div style={{ ...keyHintStyle, ...(hasItems ? { animation: "sellHintPulse 1.5s ease-in-out infinite", color: "#ffd700" } : {}) }}>
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

      <div style={shopTitleStyle}>Build Shop</div>
      {BUILD_TYPES.map((type) => {
        const info = BUILD_MATERIAL_INFO[type];
        const price = BUILD_MATERIAL_PRICES[type];
        return (
          <div key={type} style={shopRowStyle}>
            <span style={swatchStyle(info.color)} />
            <span style={{ width: 90, textAlign: "left" }}>{info.name}</span>
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{info.shape}</span>
            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>{price}g ea</span>
            <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 11 }}>(have {buildMaterials[type]})</span>
            <button style={buyBtnStyle} onClick={() => buy(type, 1)}>Buy 1</button>
            <button style={buyBtnStyle} onClick={() => buy(type, 10)}>Buy 10</button>
          </div>
        );
      })}
      <UpgradeShop />
      <CraftingPanel />
    </div>
  );
}

