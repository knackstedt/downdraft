import { INGREDIENTS } from "../simulation/effect-system";
import { canUnlockTier, TIER_BY_NUMBER, UNLOCK_TIERS } from "../simulation/shop";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 50, left: 300, width: 380,
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

const tierHeader: React.CSSProperties = {
  color: "#c084fc", fontSize: 13, margin: "10px 0 6px", display: "flex", justifyContent: "space-between",
};

const ingCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4,
  background: "rgba(255,255,255,0.05)", borderRadius: 4, border: "1px solid rgba(255,255,255,0.08)",
};

const ingCardLocked: React.CSSProperties = {
  ...ingCard, opacity: 0.4,
};

const buyBtn: React.CSSProperties = {
  background: "rgba(34,197,94,0.2)", color: "#4ade80", fontSize: 11,
  padding: "3px 10px", borderRadius: 3, border: "1px solid rgba(34,197,94,0.3)",
  cursor: "pointer", fontFamily: "monospace",
};

const buyBtnDisabled: React.CSSProperties = {
  ...buyBtn, opacity: 0.3, cursor: "not-allowed",
};

const unlockBtn: React.CSSProperties = {
  background: "rgba(192,132,252,0.2)", color: "#c084fc", fontSize: 11,
  padding: "3px 10px", borderRadius: 3, border: "1px solid rgba(192,132,252,0.4)",
  cursor: "pointer", fontFamily: "monospace",
};

export function ShopPanel() {
  const { showShop, money, unlockedTiers, ingredientInventory } = useGameStore();
  const setShowShop = useGameStore((s) => s.setShowShop);
  const addIngredient = useGameStore((s) => s.addIngredient);
  const addMoney = useGameStore((s) => s.addMoney);
  const unlockTier = useGameStore((s) => s.unlockTier);

  if (!showShop) return null;

  function buyIngredient(mat: number, doses: number, price: number) {
    if (money < price) return;
    addMoney(-price);
    addIngredient(mat, doses);
  }

  function doUnlockTier(tier: number) {
    const t = TIER_BY_NUMBER[tier];
    if (!canUnlockTier(tier, money, unlockedTiers)) return;
    addMoney(-t.unlockCost);
    unlockTier(tier);
  }

  function getDoseCount(mat: number): number {
    return ingredientInventory.find((i) => i.mat === mat)?.count ?? 0;
  }

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>
        <span>Shop — ${money}</span>
        <button style={closeBtn} onClick={() => setShowShop(false)}>✕</button>
      </div>

      {UNLOCK_TIERS.map((tier) => {
        const isUnlocked = unlockedTiers.includes(tier.tier);
        const canUnlock = canUnlockTier(tier.tier, money, unlockedTiers);
        const tierIngredients = INGREDIENTS.filter((i) => i.tier === tier.tier);

        return (
          <div key={tier.tier}>
            <div style={tierHeader}>
              <span>Tier {tier.tier}: {tier.name}</span>
              {!isUnlocked ? (
                <button
                  style={canUnlock ? unlockBtn : buyBtnDisabled}
                  onClick={() => doUnlockTier(tier.tier)}
                  disabled={!canUnlock}
                >
                  Unlock ${tier.unlockCost}
                </button>
              ) : (
                <span style={{ color: "#4ade80", fontSize: 11 }}>Unlocked</span>
              )}
            </div>

            {isUnlocked && tierIngredients.map((ing) => {
              const colorCss = `rgb(${Math.round(ing.color[0] * 255)},${Math.round(ing.color[1] * 255)},${Math.round(ing.color[2] * 255)})`;
              const owned = getDoseCount(ing.mat);
              const canBuy = money >= ing.dosePrice;
              return (
                <div key={ing.mat} style={ingCard}>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: colorCss, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{ing.name}</span>
                  <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{ing.packageType}</span>
                  <span style={{ color: "rgba(255,255,255,0.5)" }}>x{owned}</span>
                  <button
                    style={canBuy ? buyBtn : buyBtnDisabled}
                    onClick={() => buyIngredient(ing.mat, 1, ing.dosePrice)}
                    disabled={!canBuy}
                  >
                    ${ing.dosePrice}
                  </button>
                </div>
              );
            })}

            {!isUnlocked && tierIngredients.length > 0 && (
              <div style={{ ...ingCardLocked, ...ingCard }}>
                <span style={{ color: "rgba(255,255,255,0.3)" }}>
                  {tierIngredients.length} ingredients — unlock to reveal
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
