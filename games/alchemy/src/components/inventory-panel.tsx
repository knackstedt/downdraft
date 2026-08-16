import { INGREDIENT_BY_MAT, EFFECT_BY_ID } from "../simulation/effect-system";
import { potionBaseValue } from "../simulation/bottling";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, left: 300, width: 320,
  background: "rgba(10,10,20,0.92)", borderRadius: 6, padding: 12,
  color: "#e8e8f0", fontFamily: "monospace", fontSize: 12,
  border: "1px solid rgba(192,132,252,0.3)",
  pointerEvents: "auto", maxHeight: "70vh", overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  color: "#c084fc", fontSize: 14, marginBottom: 8, borderBottom: "1px solid rgba(192,132,252,0.2)",
  paddingBottom: 4, display: "flex", justifyContent: "space-between",
};

const closeBtn: React.CSSProperties = {
  background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer",
  fontSize: 16, padding: 0,
};

const sectionTitle: React.CSSProperties = {
  color: "#c084fc", fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
  margin: "10px 0 4px",
};

const potionCard: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)", borderRadius: 4, padding: 8, marginBottom: 6,
  border: "1px solid rgba(255,255,255,0.1)",
};

const ingRow: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", padding: "2px 0",
};

export function InventoryPanel() {
  const { potions, ingredientInventory, showInventory } = useGameStore();
  const setShowInventory = useGameStore((s) => s.setShowInventory);
  const removePotion = useGameStore((s) => s.removePotion);

  if (!showInventory) return null;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Inventory</span>
        <button style={closeBtn} onClick={() => setShowInventory(false)}>✕</button>
      </div>

      <div style={sectionTitle}>Potions ({potions.length})</div>
      {potions.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.4)" }}>No potions bottled yet</div>
      ) : (
        potions.map((p) => {
          const colorCss = `rgb(${Math.round(p.color[0] * 255)},${Math.round(p.color[1] * 255)},${Math.round(p.color[2] * 255)})`;
          const value = potionBaseValue(p);
          return (
            <div key={p.id} style={potionCard}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 16, height: 16, borderRadius: 3, background: colorCss, border: "1px solid rgba(255,255,255,0.2)" }} />
                <strong>{p.name}</strong>
                <span style={{ marginLeft: "auto", color: "#fbbf24" }}>${value}</span>
                <button style={{ ...closeBtn, fontSize: 14 }} onClick={() => removePotion(p.id)} title="Discard">🗑</button>
              </div>
              <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 4 }}>
                {p.effects.map((id) => EFFECT_BY_ID[id]?.name).filter(Boolean).join(", ") || "No effects"}
              </div>
              {p.processHistory.length > 0 && (
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginTop: 2 }}>
                  Process: {p.processHistory.join(" → ")}
                </div>
              )}
            </div>
          );
        })
      )}

      <div style={sectionTitle}>Ingredients</div>
      {ingredientInventory.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.4)" }}>No ingredients — visit the shop</div>
      ) : (
        ingredientInventory.map((inv) => {
          const info = INGREDIENT_BY_MAT[inv.mat];
          if (!info || inv.count <= 0) return null;
          const colorCss = `rgb(${Math.round(info.color[0] * 255)},${Math.round(info.color[1] * 255)},${Math.round(info.color[2] * 255)})`;
          return (
            <div key={inv.mat} style={ingRow}>
              <span>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: colorCss, marginRight: 6, border: "1px solid rgba(255,255,255,0.15)" }} />
                {info.name}
              </span>
              <span style={{ color: "rgba(255,255,255,0.5)" }}>{inv.count} doses</span>
            </div>
          );
        })
      )}
    </div>
  );
}
