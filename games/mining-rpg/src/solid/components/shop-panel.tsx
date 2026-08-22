// ============================================================================
// ShopPanel — tabbed shop UI for build materials, upgrades, and crafting.
//
// Replaces the old SignpostPrompt which crammed sell + build shop + upgrade
// shop + crafting into one giant panel. The SignpostPrompt now only shows
// the sell prompt; this panel (toggled with O when near the signpost) has
// three tabs: Build, Upgrades, and Furnace (crafting).
// ============================================================================

import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { BUILD_MATERIAL_INFO, BUILD_MATERIAL_PRICES, type BuildMaterialType } from "../../shared/constants";
import { actions, gameStore } from "../stores/game-store";
import { CraftingPanel } from "./crafting-panel";
import { UpgradeShop } from "./upgrade-shop";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.5)",
  "z-index": "22",
  "pointer-events": "auto",
};

const panelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  padding: "20px 28px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid rgba(255,255,255,0.15)",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#d0d0e0",
  "min-width": "480px",
  "max-width": "640px",
  "max-height": "85vh",
  "overflow-y": "auto",
  "pointer-events": "auto",
  "scrollbar-width": "thin",
  "scrollbar-color": "rgba(255,215,0,0.3) rgba(255,255,255,0.05)",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "18px",
  "font-weight": "bold",
  color: "#a0a0c0",
  "letter-spacing": "2px",
  "text-align": "center",
  "margin-bottom": "12px",
};

const tabContainerStyle: JSX.CSSProperties = {
  display: "flex",
  gap: "4px",
  "margin-bottom": "12px",
  "border-bottom": "1px solid rgba(255,255,255,0.15)",
  "padding-bottom": "8px",
};

const tabStyle = (active: boolean): JSX.CSSProperties => ({
  padding: "6px 16px",
  "font-size": "13px",
  "font-family": "monospace",
  color: active ? "#ffd700" : "rgba(255,255,255,0.5)",
  background: active ? "rgba(255,215,0,0.1)" : "transparent",
  border: active ? "1px solid rgba(255,215,0,0.4)" : "1px solid transparent",
  "border-radius": "4px",
  cursor: "pointer",
  "pointer-events": "auto",
});

const goldStyle: JSX.CSSProperties = {
  "text-align": "center",
  "font-size": "14px",
  color: "#e6c833",
  "font-weight": "bold",
  "margin-bottom": "12px",
};

const closeHintStyle: JSX.CSSProperties = {
  "text-align": "center",
  "margin-top": "12px",
  "padding-top": "8px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "11px",
  color: "rgba(255,255,255,0.4)",
};

type Tab = "build" | "upgrades" | "furnace";

// --- Build shop content (moved from SignpostPrompt) ---

const BUILD_TYPES: BuildMaterialType[] = ["scaffolding", "ladder", "rope", "torch"];

const buildRowStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  padding: "4px 0",
};

const buildSwatchStyle = (color: string): JSX.CSSProperties => ({
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
  padding: "3px 8px",
  cursor: "pointer",
  "pointer-events": "auto",
};

function BuildTab() {
  return (
    <>
      <div style={{ "font-size": "12px", color: "rgba(255,255,255,0.6)", "margin-bottom": "8px" }}>
        Buy building materials with gold. Place them in build mode (B).
      </div>
      <For each={BUILD_TYPES}>
        {(type) => {
          const info = BUILD_MATERIAL_INFO[type];
          const price = BUILD_MATERIAL_PRICES[type];
          const canAfford1 = () => gameStore.currency >= price;
          const canAfford10 = () => gameStore.currency >= price * 10;
          return (
            <div style={buildRowStyle}>
              <span style={buildSwatchStyle(info.color)} />
              <span style={{ width: "100px", "text-align": "left" }}>{info.name}</span>
              <span style={{ color: "rgba(255,255,255,0.4)", "font-size": "10px" }}>{info.shape}</span>
              <span style={{ color: "rgba(255,215,0,0.6)", "font-size": "11px" }}>{price}g ea</span>
              <span style={{ color: "rgba(255,255,255,0.5)", "font-size": "11px" }}>(have {gameStore.buildMaterials[type]})</span>
              <button style={{ ...buyBtnStyle, opacity: canAfford1() ? 1 : 0.4 }} onClick={() => canAfford1() && actions.buyBuildMaterial(type, 1)} disabled={!canAfford1()}>Buy 1</button>
              <button style={{ ...buyBtnStyle, opacity: canAfford10() ? 1 : 0.4 }} onClick={() => canAfford10() && actions.buyBuildMaterial(type, 10)} disabled={!canAfford10()}>Buy 10</button>
            </div>
          );
        }}
      </For>
    </>
  );
}

export function ShopPanel() {
  const [tab, setTab] = createSignal<Tab>("build");

  return (
    <Show when={gameStore.showShop && gameStore.nearSignpost}>
      <div style={overlayStyle} onClick={() => actions.setShowShop(false)}>
        <div style={panelStyle} class="dd-shop-scroll" onClick={(e) => e.stopPropagation()}>
          <style>{`
            .dd-shop-scroll::-webkit-scrollbar { width: 8px; }
            .dd-shop-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
            .dd-shop-scroll::-webkit-scrollbar-thumb { background: rgba(255,215,0,0.3); border-radius: 4px; }
            .dd-shop-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,215,0,0.5); }
          `}</style>
          <div style={titleStyle}>SHOP</div>
          <div style={goldStyle}>Gold: {gameStore.currency}g</div>
          <div style={tabContainerStyle}>
            <span style={tabStyle(tab() === "build")} onClick={() => setTab("build")}>Build</span>
            <span style={tabStyle(tab() === "upgrades")} onClick={() => setTab("upgrades")}>Upgrades</span>
            <span style={tabStyle(tab() === "furnace")} onClick={() => setTab("furnace")}>Furnace</span>
          </div>
          <Show when={tab() === "build"}><BuildTab /></Show>
          <Show when={tab() === "upgrades"}><UpgradeShop /></Show>
          <Show when={tab() === "furnace"}><CraftingPanel /></Show>
          <div style={closeHintStyle}>Press O to close</div>
        </div>
      </div>
    </Show>
  );
}
