import { useMemo } from "react";
import { analyzeMixture, deriveEffects, INGREDIENT_BY_MAT, nameMixture } from "../simulation/effect-system";
import { matchRecipe } from "../simulation/recipes";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, right: 8, width: 260,
  background: "rgba(10,10,20,0.85)", borderRadius: 6, padding: 10,
  color: "#e8e8f0", fontFamily: "monospace", fontSize: 12,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "none",
};

const swatchStyle: React.CSSProperties = {
  display: "inline-block", width: 14, height: 14, borderRadius: 2,
  verticalAlign: "middle", marginRight: 6, border: "1px solid rgba(255,255,255,0.2)",
};

const sectionTitle: React.CSSProperties = {
  color: "#c084fc", fontSize: 11, textTransform: "uppercase",
  letterSpacing: 1, margin: "8px 0 4px", borderBottom: "1px solid rgba(192,132,252,0.2)",
  paddingBottom: 2,
};

const effectStyle: React.CSSProperties = {
  color: "#fbbf24", padding: "2px 0",
};

const dimRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", padding: "1px 0",
};

function dimBar(val: number): React.CSSProperties {
  const pct = Math.min(100, Math.abs(val) * 100);
  return {
    width: `${pct}%`,
    height: 4,
    background: val >= 0 ? "#22c55e" : "#ef4444",
    borderRadius: 2,
    marginTop: 2,
  };
}

export function MixtureReadout() {
  const { mixtureHistogram, processHistory, discoveredRecipes } = useGameStore();

  const analysis = useMemo(() => {
    const a = analyzeMixture(mixtureHistogram);
    if (a.totalCells === 0) return null;
    const effects = deriveEffects(a.effectVector);
    const recipe = matchRecipe(a.effectVector, processHistory);
    const name = recipe ? recipe.name : nameMixture(a.effectVector, effects);
    return { ...a, effects, recipe, name };
  }, [mixtureHistogram, processHistory]);

  if (!analysis) {
    return (
      <div style={panelStyle}>
        <div style={sectionTitle}>Cauldron</div>
        <div style={{ color: "rgba(255,255,255,0.4)" }}>Empty — add ingredients</div>
      </div>
    );
  }

  const { effectVector: v, properties: p, effects, recipe, name, totalCells, ingredientCounts } = analysis;
  const colorCss = `rgb(${Math.round(p.color[0] * 255)},${Math.round(p.color[1] * 255)},${Math.round(p.color[2] * 255)})`;
  const isDiscovered = recipe && discoveredRecipes.includes(recipe.id);

  return (
    <div style={panelStyle}>
      <div style={sectionTitle}>Cauldron ({totalCells} cells)</div>
      <div>
        <span style={swatchStyle} />
        <span style={{ background: colorCss, display: "inline-block", width: 14, height: 14, borderRadius: 2, verticalAlign: "middle", marginRight: 6, border: "1px solid rgba(255,255,255,0.2)" }} />
        <strong style={{ color: recipe ? "#c084fc" : "#e8e8f0" }}>{name}</strong>
        {recipe && !isDiscovered && <span style={{ color: "#fbbf24", marginLeft: 6 }}>(new!)</span>}
      </div>

      <div style={sectionTitle}>Effects</div>
      {effects.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.4)" }}>No notable effects</div>
      ) : (
        effects.map((e) => (
          <div key={e.id} style={effectStyle}>{e.name}</div>
        ))
      )}

      <div style={sectionTitle}>Properties</div>
      <div>Acidity: {(p.acidity * 100).toFixed(0)}%</div>
      <div>Viscosity: {(p.viscosity * 100).toFixed(0)}%</div>
      <div>Glow: {(p.glow * 100).toFixed(0)}%</div>
      <div>Aura: {(p.aura * 100).toFixed(0)}%</div>
      <div>Sparkle: {(p.sparkle * 100).toFixed(0)}%</div>

      <div style={sectionTitle}>Effect Vector</div>
      {(["toxic","corrosive","healing","luminous","volatile","reactive","dense","ethereal","thermal","necrotic","psychic","kinetic"] as const).map((dim) => (
        <div key={dim}>
          <div style={dimRow}>
            <span style={{ color: "rgba(255,255,255,0.6)" }}>{dim}</span>
            <span>{(v[dim] * 100).toFixed(0)}%</span>
          </div>
          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 2 }}>
            <div style={dimBar(v[dim])} />
          </div>
        </div>
      ))}

      {ingredientCounts.length > 0 && (
        <>
          <div style={sectionTitle}>Ingredients</div>
          {ingredientCounts.map(({ mat, count }) => {
            const info = INGREDIENT_BY_MAT[mat];
            return (
              <div key={mat} style={dimRow}>
                <span>{info ? info.name : `#${mat}`}</span>
                <span style={{ color: "rgba(255,255,255,0.5)" }}>{count}</span>
              </div>
            );
          })}
        </>
      )}

      {processHistory.length > 0 && (
        <>
          <div style={sectionTitle}>Process</div>
          <div>{processHistory.join(" → ")}</div>
        </>
      )}
    </div>
  );
}
