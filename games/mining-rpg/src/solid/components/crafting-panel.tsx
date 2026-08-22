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

import { Material } from "@downdraft/library-sand";
import { For } from "solid-js";
import { SELL_PRICES } from "../../shared/constants";
import { canCraft, CRAFTING_RECIPES } from "../../shared/crafting-recipes";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

const titleStyle: JSX.CSSProperties = {
  "font-size": "13px",
  "font-weight": "bold",
  "margin-top": "8px",
  "padding-top": "6px",
  "border-top": "1px solid rgba(255,255,255,0.15)",
  color: "rgba(255,255,255,0.85)",
};

const rowStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "6px",
  padding: "3px 0",
  "flex-wrap": "wrap",
};

const swatchStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "10px",
  height: "10px",
  "border-radius": "2px",
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
  "flex-shrink": "0",
});

const recipeNameStyle: JSX.CSSProperties = {
  width: "80px",
  "text-align": "left",
  "flex-shrink": "0",
};

const inputStyle: JSX.CSSProperties = {
  "font-size": "10px",
  color: "rgba(255,255,255,0.5)",
};

const priceStyle: JSX.CSSProperties = {
  color: "rgba(255,215,0,0.7)",
  "font-size": "11px",
  "flex-shrink": "0",
};

const countStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.6)",
  "font-size": "11px",
  "flex-shrink": "0",
};

const craftBtnStyle: JSX.CSSProperties = {
  "font-family": "monospace",
  "font-size": "11px",
  color: "#fff",
  background: "rgba(100,180,255,0.18)",
  border: "1px solid rgba(100,180,255,0.5)",
  "border-radius": "3px",
  padding: "2px 8px",
  cursor: "pointer",
  "pointer-events": "auto",
  "flex-shrink": "0",
};

const craftBtnDisabledStyle: JSX.CSSProperties = {
  ...craftBtnStyle,
  color: "rgba(255,255,255,0.35)",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  cursor: "not-allowed",
};

const craft10BtnStyle: JSX.CSSProperties = {
  ...craftBtnStyle,
  padding: "2px 4px",
  "font-size": "10px",
};

export function CraftingPanel() {
  const handleCraft = (recipeIndex: number, qty: number) => {
    const recipe = CRAFTING_RECIPES[recipeIndex];
    for (let i = 0; i < qty; i++) {
      if (!canCraft(recipe, gameStore.inventory)) break;
      if (!actions.craft(recipe)) break;
    }
  };

  const coalCount = () => gameStore.inventory.find((e) => e.mat === Material.Coal)?.count ?? 0;

  const renderRecipe = (recipe: typeof CRAFTING_RECIPES[number]) => {
    const i = CRAFTING_RECIPES.indexOf(recipe);
    const hasMaterials = () => canCraft(recipe, gameStore.inventory);
    const ownedCount = () => gameStore.craftedItems[recipe.output] ?? 0;
    const inputSummary = recipe.inputs.map((inp) => `${inp.count} ${inp.name}`).join(" + ");
    // Calculate profit margin (sell price - input ore sell value)
    let inputSellValue = 0;
    for (let j = 0; j < recipe.inputs.length; j++) {
      inputSellValue += (SELL_PRICES[recipe.inputs[j].mat] ?? 0) * recipe.inputs[j].count;
    }
    const profit = recipe.sellPrice - inputSellValue;

    return (
      <div style={rowStyle}>
        <span style={swatchStyle(recipe.color)} />
        <span style={recipeNameStyle}>{recipe.outputName}</span>
        <span style={inputStyle}>{inputSummary}</span>
        <span style={priceStyle}>{recipe.sellPrice}g</span>
        <span style={{ ...countStyle, color: profit > 0 ? "#4caf50" : "#f44336", "font-size": "9px" }}>
          {profit > 0 ? `+${profit}` : profit}g
        </span>
        <span style={countStyle}>({ownedCount()})</span>
        <button
          style={hasMaterials() ? craftBtnStyle : craftBtnDisabledStyle}
          onClick={() => hasMaterials() && handleCraft(i, 1)}
          disabled={!hasMaterials()}
        >
          Smelt
        </button>
        <button
          style={hasMaterials() ? craft10BtnStyle : craftBtnDisabledStyle}
          onClick={() => hasMaterials() && handleCraft(i, 10)}
          disabled={!hasMaterials()}
        >
          ×10
        </button>
      </div>
    );
  };

  return (
    <>
      <div style={titleStyle}>Furnace — Smelt Ore into Bars</div>
      <div style={{ "font-size": "10px", color: "rgba(255,255,255,0.4)", "margin-bottom": "4px" }}>
        Coal: {coalCount()} | Each smelt needs 1 coal
      </div>
      {/* Smelting recipes */}
      <div style={{ "font-size": "10px", color: "rgba(255,255,255,0.4)", "margin-top": "4px", "text-transform": "uppercase", "letter-spacing": "1px" }}>
        Smelting (Ore → Bar)
      </div>
      <For each={CRAFTING_RECIPES.filter((r) => r.category === "smelting")}>
        {(recipe) => renderRecipe(recipe)}
      </For>
      {/* Alloy recipes */}
      <div style={{ "font-size": "10px", color: "rgba(255,255,255,0.4)", "margin-top": "6px", "text-transform": "uppercase", "letter-spacing": "1px" }}>
        Alloys (Bar + Bar → Alloy)
      </div>
      <For each={CRAFTING_RECIPES.filter((r) => r.category === "alloy")}>
        {(recipe) => renderRecipe(recipe)}
      </For>
    </>
  );
}
