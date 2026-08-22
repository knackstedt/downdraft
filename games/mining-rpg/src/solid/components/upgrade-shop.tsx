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

import { For, Show } from "solid-js";
import { UPGRADE_CONFIG, upgradePrice } from "../../shared/constants";
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
  gap: "8px",
  padding: "3px 0",
};

const iconStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "10px",
  height: "10px",
  "border-radius": "2px",
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
});

const buyBtnStyle: JSX.CSSProperties = {
  "font-family": "monospace",
  "font-size": "11px",
  color: "#fff",
  background: "rgba(255,215,0,0.18)",
  border: "1px solid rgba(255,215,0,0.5)",
  "border-radius": "3px",
  padding: "2px 8px",
  cursor: "pointer",
  "pointer-events": "auto",
};

const buyBtnDisabledStyle: JSX.CSSProperties = {
  ...buyBtnStyle,
  color: "rgba(255,255,255,0.35)",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  cursor: "not-allowed",
};

const maxedStyle: JSX.CSSProperties = {
  "font-family": "monospace",
  "font-size": "11px",
  color: "#4caf50",
  "font-weight": "bold",
};

const levelBarOuter: JSX.CSSProperties = {
  display: "inline-flex",
  gap: "1px",
};

const levelDot = (filled: boolean, color: string): JSX.CSSProperties => ({
  width: "5px",
  height: "5px",
  "border-radius": "1px",
  background: filled ? color : "rgba(255,255,255,0.15)",
});

export function UpgradeShop() {
  return (
    <>
      <div style={titleStyle}>Upgrade Shop</div>
      <For each={UPGRADE_CONFIG}>
        {(config) => {
          const currentLevel = () => gameStore.upgrades[config.key];
          const isMaxed = () => currentLevel() >= config.maxLevel;
          const price = () => upgradePrice(config, currentLevel());
          const canAfford = () => gameStore.currency >= price();

          return (
            <div style={rowStyle}>
              <span style={iconStyle(config.color)} />
              <span style={{ width: "120px", "text-align": "left" }}>{config.name}</span>
              <span style={{ color: "rgba(255,255,255,0.4)", "font-size": "10px" }}>{config.description}</span>
              {/* Level dots */}
              <span style={levelBarOuter}>
                <For each={Array.from({ length: config.maxLevel }, (_, i) => i)}>
                  {(i) => <span style={levelDot(i < currentLevel(), config.color)} />}
                </For>
              </span>
              <Show
                when={isMaxed()}
                fallback={
                  <>
                    <span style={{ color: canAfford() ? "rgba(255,215,0,0.8)" : "rgba(255,255,255,0.35)", "font-size": "11px" }}>
                      {price()}g
                    </span>
                    <button
                      style={canAfford() ? buyBtnStyle : buyBtnDisabledStyle}
                      onClick={() => canAfford() && actions.purchaseUpgrade(config)}
                      disabled={!canAfford()}
                    >
                      Buy
                    </button>
                  </>
                }
              >
                <span style={maxedStyle}>MAX</span>
              </Show>
            </div>
          );
        }}
      </For>
      <div style={{ "font-size": "10px", color: "rgba(255,255,255,0.35)", "margin-top": "6px", "padding-top": "6px", "border-top": "1px solid rgba(255,255,255,0.1)" }}>
        Gold: {gameStore.currency}g | Invested: {gameStore.stats.totalGoldSpent}g | Net: {gameStore.stats.totalGoldEarned - gameStore.stats.totalGoldSpent}g
      </div>
    </>
  );
}
