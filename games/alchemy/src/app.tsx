import { Material } from "@downdraft/library-sand";
import { useEffect } from "react";
import { BoothPanel } from "./components/booth-panel";
import { InventoryPanel } from "./components/inventory-panel";
import { MixtureReadout } from "./components/mixture-readout";
import { RecipesPanel } from "./components/recipes-panel";
import { SavesPanel } from "./components/saves-panel";
import { ShopPanel } from "./components/shop-panel";
import { StationControls } from "./components/station-controls";
import { bottlePotion } from "./simulation/bottling";
import { matchRecipe } from "./simulation/recipes";
import { useGameStore } from "./stores/game-store";

// Ingredients available in the palette (material id + display name)
// Only alchemy-relevant ingredients are shown; walls/empty/byproducts are excluded.
const PALETTE_INGREDIENTS: { mat: number; name: string }[] = [
  { mat: Material.Water, name: "Water" },
  { mat: Material.Salt, name: "Salt" },
  { mat: Material.Sand, name: "Sand" },
  { mat: Material.Oil, name: "Oil" },
  { mat: Material.Fire, name: "Fire" },
  { mat: Material.Lava, name: "Lava" },
  { mat: Material.Ice, name: "Ice" },
  { mat: Material.Ether, name: "Ether" },
  { mat: Material.Blood, name: "Blood" },
  { mat: Material.Syrup, name: "Syrup" },
  { mat: Material.NightshadeExtract, name: "Nightshade Extract" },
  { mat: Material.TrollBlood, name: "Troll Blood" },
  { mat: Material.LiquidShadow, name: "Liquid Shadow" },
  { mat: Material.LoveEssence, name: "Love Essence" },
  { mat: Material.HateEssence, name: "Hate Essence" },
  { mat: Material.DreamMist, name: "Dream Mist" },
  { mat: Material.VoidEssence, name: "Void Essence" },
  { mat: Material.Sulfur, name: "Sulfur" },
  { mat: Material.GroundEyeOfNewt, name: "Ground Eye of Newt" },
  { mat: Material.GroundBatWing, name: "Ground Bat Wing" },
  { mat: Material.BoneDust, name: "Bone Dust" },
  { mat: Material.IronFilings, name: "Iron Filings" },
  { mat: Material.MoonstoneDust, name: "Moonstone Dust" },
  { mat: Material.CrystalDust, name: "Crystal Dust" },
  { mat: Material.MushroomSpores, name: "Mushroom Spores" },
  { mat: Material.DragonScale, name: "Dragon Scale" },
  { mat: Material.PhoenixFeather, name: "Phoenix Feather" },
  { mat: Material.UnicornHorn, name: "Unicorn Horn" },
  { mat: Material.MandrakeRoot, name: "Mandrake Root" },
  { mat: Material.SpiderSilk, name: "Spider Silk" },
  { mat: Material.GraveDust, name: "Grave Dust" },
  { mat: Material.StarShard, name: "Star Shard" },
  { mat: Material.TimeSand, name: "Time Sand" },
  { mat: Material.Mercury, name: "Mercury" },
  { mat: Material.Honey, name: "Honey" },
];

const overlayStyle: React.CSSProperties = {
  position: "absolute", inset: 0, pointerEvents: "none",
};

const paletteStyle: React.CSSProperties = {
  position: "absolute", top: 8, left: 8,
  display: "flex", flexWrap: "wrap", gap: 2,
  padding: 4, background: "rgba(0,0,0,0.7)", borderRadius: 4,
  pointerEvents: "auto", maxWidth: 280, maxHeight: "calc(100vh - 60px)", overflowY: "auto",
};

const swatchStyle: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 3, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.15)",
  flexShrink: 0,
};

const swatchActiveStyle: React.CSSProperties = {
  ...swatchStyle,
  border: "2px solid #c084fc",
  boxShadow: "0 0 4px rgba(192,132,252,0.6)",
};

const helpStyle: React.CSSProperties = {
  position: "absolute", bottom: 8, left: 8,
  color: "rgba(255,255,255,0.6)", fontFamily: "monospace", fontSize: 12,
  padding: 8, background: "rgba(0,0,0,0.5)", borderRadius: 4,
  pointerEvents: "none",
};

const topBarStyle: React.CSSProperties = {
  position: "absolute", top: 8, right: 8,
  display: "flex", gap: 8, alignItems: "center",
  color: "rgba(255,255,255,0.85)", fontFamily: "monospace", fontSize: 13,
  padding: "6px 12px", background: "rgba(0,0,0,0.7)", borderRadius: 4,
  pointerEvents: "auto",
};

const btnStyle: React.CSSProperties = {
  background: "rgba(192,132,252,0.15)", color: "#e8e8f0", fontSize: 12,
  padding: "4px 10px", borderRadius: 4, border: "1px solid rgba(192,132,252,0.4)",
  cursor: "pointer",
};

export default function App() {
  const {
    selectedIngredient, brushRadius, money, paused, fps, renderer,
    showInventory, showRecipes, showShop, showBooth, showSaves,
  } = useGameStore();
  const setSelectedIngredient = useGameStore((s) => s.setSelectedIngredient);
  const setBrushRadius = useGameStore((s) => s.setBrushRadius);
  const addPotion = useGameStore((s) => s.addPotion);
  const discoverRecipe = useGameStore((s) => s.discoverRecipe);
  const resetProcessHistory = useGameStore((s) => s.resetProcessHistory);
  const setShowInventory = useGameStore((s) => s.setShowInventory);
  const setShowRecipes = useGameStore((s) => s.setShowRecipes);
  const setShowShop = useGameStore((s) => s.setShowShop);
  const setShowBooth = useGameStore((s) => s.setShowBooth);
  const setShowSaves = useGameStore((s) => s.setShowSaves);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        const s = useGameStore.getState();
        s.setPaused(!s.paused);
      }
      if (e.key === "i" || e.key === "I") setShowInventory(!useGameStore.getState().showInventory);
      if (e.key === "r" || e.key === "R") setShowRecipes(!useGameStore.getState().showRecipes);
      if (e.key === "s" || e.key === "S") setShowShop(!useGameStore.getState().showShop);
      if (e.key === "v" || e.key === "V") setShowBooth(!useGameStore.getState().showBooth);
      if (e.key === "F5") { e.preventDefault(); setShowSaves(!useGameStore.getState().showSaves); }
      if (e.key === "b" || e.key === "B") doBottle();
      // Number keys 1-8 select brush radius
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 8) setBrushRadius(n);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setBrushRadius, setShowInventory, setShowRecipes, setShowShop, setShowBooth, setShowSaves]);

  function doBottle() {
    const s = useGameStore.getState();
    const potion = bottlePotion(s.mixtureHistogram, s.processHistory);
    if (!potion) return;
    addPotion(potion);
    // Discover the recipe if matched
    const recipe = matchRecipe(potion.effectVector, potion.processHistory);
    if (recipe) discoverRecipe(recipe.id);
    // Clear the cauldron + process history
    renderer?.getWorkerHost()?.clear();
    resetProcessHistory();
  }

  return (
    <div style={overlayStyle}>
      <MixtureReadout />
      <StationControls />
      {showInventory && <InventoryPanel />}
      {showRecipes && <RecipesPanel />}
      {showShop && <ShopPanel />}
      {showBooth && <BoothPanel />}
      {showSaves && <SavesPanel />}

      <div style={paletteStyle}>
        {PALETTE_INGREDIENTS.map((ing) => (
          <div
            key={ing.mat}
            style={ing.mat === selectedIngredient ? swatchActiveStyle : swatchStyle}
            title={ing.name}
            onClick={() => setSelectedIngredient(ing.mat)}
          />
        ))}
      </div>

      <div style={topBarStyle}>
        <span style={{ color: "#fbbf24" }}>${money}</span>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
        <button style={btnStyle} onClick={doBottle}>🍼 Bottle (B)</button>
        <button style={btnStyle} onClick={() => setShowInventory(!showInventory)}>🎒 Inventory (I)</button>
        <button style={btnStyle} onClick={() => setShowRecipes(!showRecipes)}>📖 Recipes (R)</button>
        <button style={btnStyle} onClick={() => setShowShop(!showShop)}>🛒 Shop (S)</button>
        <button style={btnStyle} onClick={() => setShowBooth(!showBooth)}>🎪 Booth (V)</button>
        <button style={btnStyle} onClick={() => setShowSaves(!showSaves)}>💾 Saves (F5)</button>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
        <span>Brush: {brushRadius}</span>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>|</span>
        <span>{fps ?? "—"} FPS</span>
        {paused && <span style={{ color: "#f87171" }}>| PAUSED</span>}
      </div>

      <div style={helpStyle}>
        Left-click: add ingredient | Right-click: erase | 1-8: brush size | P: pause | B: bottle | I: inventory | R: recipes
      </div>
    </div>
  );
}
