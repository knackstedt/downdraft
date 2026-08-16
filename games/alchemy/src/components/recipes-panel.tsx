import { INGREDIENT_BY_MAT } from "../simulation/effect-system";
import { RECIPES, recipeEffectNames } from "../simulation/recipes";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, left: 300, width: 360,
  background: "rgba(10,10,20,0.92)", borderRadius: 6, padding: 12,
  color: "#e8e8f0", fontFamily: "monospace", fontSize: 12,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "auto", maxHeight: "75vh", overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  color: "#c084fc", fontSize: 14, marginBottom: 8, borderBottom: "1px solid rgba(192,132,252,0.2)",
  paddingBottom: 4, display: "flex", justifyContent: "space-between",
};

const closeBtn: React.CSSProperties = {
  background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer",
  fontSize: 16, padding: 0,
};

const recipeCard: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", borderRadius: 4, padding: 8, marginBottom: 6,
  border: "1px solid rgba(255,255,255,0.1)",
};

const recipeCardDiscovered: React.CSSProperties = {
  ...recipeCard,
  border: "1px solid rgba(192,132,252,0.4)",
  background: "rgba(192,132,252,0.08)",
};

const tierLabel: React.CSSProperties = {
  color: "rgba(255,255,255,0.4)", fontSize: 10,
};

export function RecipesPanel() {
  const { showRecipes, discoveredRecipes } = useGameStore();
  const setShowRecipes = useGameStore((s) => s.setShowRecipes);

  if (!showRecipes) return null;

  // Group recipes by tier
  const byTier: Record<number, typeof RECIPES> = {};
  for (const r of RECIPES) {
    if (!byTier[r.tier]) byTier[r.tier] = [];
    byTier[r.tier].push(r);
  }
  const tiers = Object.keys(byTier).map(Number).sort((a, b) => a - b);

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Recipes ({discoveredRecipes.length}/{RECIPES.length} discovered)</span>
        <button style={closeBtn} onClick={() => setShowRecipes(false)}>✕</button>
      </div>

      {tiers.map((tier) => (
        <div key={tier}>
          <div style={{ color: "#c084fc", fontSize: 11, margin: "8px 0 4px", textTransform: "uppercase", letterSpacing: 1 }}>
            Tier {tier}
          </div>
          {byTier[tier].map((recipe) => {
            const discovered = discoveredRecipes.includes(recipe.id);
            const effectNames = recipeEffectNames(recipe);
            return (
              <div key={recipe.id} style={discovered ? recipeCardDiscovered : recipeCard}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{discovered ? recipe.name : "???"}</strong>
                  <span style={tierLabel}>T{recipe.tier}</span>
                </div>
                {discovered ? (
                  <>
                    <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, marginTop: 4 }}>
                      {recipe.ingredients.map((ing) => {
                        const info = INGREDIENT_BY_MAT[ing.mat];
                        return info ? `${info.name} (${ing.ratio})` : `#${ing.mat}`;
                      }).join(" + ")}
                    </div>
                    {recipe.process.length > 0 && (
                      <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 2 }}>
                        Process: {recipe.process.join(" → ")}
                      </div>
                    )}
                    <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>
                      {effectNames.join(", ") || "No effects"}
                    </div>
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 2 }}>
                      {recipe.description}
                    </div>
                  </>
                ) : (
                  <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginTop: 4 }}>
                    Undiscovered — experiment to find this recipe
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
