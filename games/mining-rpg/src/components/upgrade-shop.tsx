// ============================================================================
// UpgradeShop — purchasable mining upgrades shown at the surface signpost.
//
// Displays all four upgrade types (damage, radius, speed, inventory capacity)
// with their current level, next-level price, and a Buy button. The player
// earns gold by selling ore at the signpost, then spends it here on permanent
// upgrades that persist across deaths and saves.
//
// This component is rendered inside the SignpostPrompt when the player is near
// the signpost. It reads upgrade levels + currency from the game store and
// calls the renderer's purchaseUpgrade() to deduct gold + sync to the worker.
// ============================================================================

import { UPGRADE_CONFIG, upgradePrice } from "../shared/constants";
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
  gap: 8,
  padding: "3px 0",
};

const iconStyle = (color: string): React.CSSProperties => ({
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
  padding: "2px 8px",
  cursor: "pointer",
  pointerEvents: "auto",
};

const buyBtnDisabledStyle: React.CSSProperties = {
  ...buyBtnStyle,
  color: "rgba(255,255,255,0.35)",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  cursor: "not-allowed",
};

const maxedStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#4caf50",
  fontWeight: "bold",
};

const levelBarOuter: React.CSSProperties = {
  display: "inline-flex",
  gap: 1,
};

const levelDot = (filled: boolean, color: string): React.CSSProperties => ({
  width: 5,
  height: 5,
  borderRadius: 1,
  background: filled ? color : "rgba(255,255,255,0.15)",
});

export function UpgradeShop() {
  const { upgrades, currency } = useGameStore();

  const buy = (configKey: typeof UPGRADE_CONFIG[number]) => {
    const renderer = useGameStore.getState().renderer as
      | { purchaseUpgrade?: (config: typeof UPGRADE_CONFIG[number]) => boolean }
      | null;
    renderer?.purchaseUpgrade?.(configKey);
  };

  return (
    <>
      <div style={titleStyle}>Upgrade Shop</div>
      {UPGRADE_CONFIG.map((config) => {
        const currentLevel = upgrades[config.key];
        const isMaxed = currentLevel >= config.maxLevel;
        const price = upgradePrice(config, currentLevel);
        const canAfford = currency >= price;

        return (
          <div key={config.key} style={rowStyle}>
            <span style={iconStyle(config.color)} />
            <span style={{ width: 120, textAlign: "left" }}>{config.name}</span>
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{config.description}</span>
            {/* Level dots */}
            <span style={levelBarOuter}>
              {Array.from({ length: config.maxLevel }, (_, i) => (
                <span key={i} style={levelDot(i < currentLevel, config.color)} />
              ))}
            </span>
            {isMaxed ? (
              <span style={maxedStyle}>MAX</span>
            ) : (
              <>
                <span style={{ color: canAfford ? "rgba(255,215,0,0.8)" : "rgba(255,255,255,0.35)", fontSize: 11 }}>
                  {price}g
                </span>
                <button
                  style={canAfford ? buyBtnStyle : buyBtnDisabledStyle}
                  onClick={() => canAfford && buy(config)}
                  disabled={!canAfford}
                >
                  Buy
                </button>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
