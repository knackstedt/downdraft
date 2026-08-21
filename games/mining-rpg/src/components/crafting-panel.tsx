// ============================================================================
// CraftingPanel — ore smelting and alloy crafting UI at the signpost furnace.
//
// Shows all crafting recipes with their input requirements, output item, and
// sell price. The player can craft (smelt ore into bars) if they have enough
// materials. Crafted bars are sold with the "E" key (sellAll now sells both
// raw inventory and crafted items).
//
// This component is rendered inside the SignpostPrompt when the player is near
// the signpost. It reads inventory + crafted items from the game store and
// calls the store's craft() method to consume inputs and produce output.
// ============================================================================

import { canCraft, CRAFTING_RECIPES } from "../shared/crafting-recipes";
import { useGameStore } from "../stores/game-store";

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: "bold",
  marginTop: 8,
  paddingTop: 6,
  borderTop: "1px solid rgba(255,255,255,0.15)",
  color: "rgba(255,255,255,0.85)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 0",
  flexWrap: "wrap",
};

const swatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: 2,
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
  flexShrink: 0,
});

const recipeNameStyle: React.CSSProperties = {
  width: 80,
  textAlign: "left",
  flexShrink: 0,
};

const inputStyle: React.CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.5)",
};

const priceStyle: React.CSSProperties = {
  color: "rgba(255,215,0,0.7)",
  fontSize: 11,
  flexShrink: 0,
};

const countStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.6)",
  fontSize: 11,
  flexShrink: 0,
};

const craftBtnStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#fff",
  background: "rgba(100,180,255,0.18)",
  border: "1px solid rgba(100,180,255,0.5)",
  borderRadius: 3,
  padding: "2px 8px",
  cursor: "pointer",
  pointerEvents: "auto",
  flexShrink: 0,
};

const craftBtnDisabledStyle: React.CSSProperties = {
  ...craftBtnStyle,
  color: "rgba(255,255,255,0.35)",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  cursor: "not-allowed",
};

const craft10BtnStyle: React.CSSProperties = {
  ...craftBtnStyle,
  padding: "2px 4px",
  fontSize: 10,
};

export function CraftingPanel() {
  const { inventory, craftedItems } = useGameStore();

  const handleCraft = (recipeIndex: number, qty: number) => {
    const recipe = CRAFTING_RECIPES[recipeIndex];
    const store = useGameStore.getState();
    let crafted = 0;
    for (let i = 0; i < qty; i++) {
      if (!canCraft(recipe, store.inventory)) break;
      if (!store.craft(recipe)) break;
      crafted++;
    }
    // Refresh local references after crafting
    if (crafted > 0) {
      // Trigger a re-render by reading the updated state
      useGameStore.getState();
    }
  };

  return (
    <>
      <div style={titleStyle}>Furnace — Smelt Ore into Bars</div>
      {CRAFTING_RECIPES.map((recipe, i) => {
        const hasMaterials = canCraft(recipe, inventory);
        const ownedCount = craftedItems[recipe.output] ?? 0;
        const inputSummary = recipe.inputs
          .map((inp) => `${inp.count} ${inp.name}`)
          .join(" + ");

        return (
          <div key={recipe.output} style={rowStyle}>
            <span style={swatchStyle(recipe.color)} />
            <span style={recipeNameStyle}>{recipe.outputName}</span>
            <span style={inputStyle}>{inputSummary}</span>
            <span style={priceStyle}>{recipe.sellPrice}g</span>
            <span style={countStyle}>({ownedCount})</span>
            <button
              style={hasMaterials ? craftBtnStyle : craftBtnDisabledStyle}
              onClick={() => hasMaterials && handleCraft(i, 1)}
              disabled={!hasMaterials}
            >
              Smelt
            </button>
            <button
              style={hasMaterials ? craft10BtnStyle : craftBtnDisabledStyle}
              onClick={() => hasMaterials && handleCraft(i, 10)}
              disabled={!hasMaterials}
            >
              ×10
            </button>
          </div>
        );
      })}
    </>
  );
}
