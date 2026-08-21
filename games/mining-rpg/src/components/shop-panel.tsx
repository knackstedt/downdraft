// ============================================================================
// ShopPanel — tabbed shop UI for build materials, upgrades, and crafting.
//
// Replaces the old SignpostPrompt which crammed sell + build shop + upgrade
// shop + crafting into one giant panel. The SignpostPrompt now only shows
// the sell prompt; this panel (toggled with O when near the signpost) has
// three tabs: Build, Upgrades, and Furnace (crafting).
// ============================================================================

import { useState } from "react";
import { useGameStore } from "../stores/game-store";
import { CraftingPanel } from "./crafting-panel";
import { UpgradeShop } from "./upgrade-shop";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.5)",
  zIndex: 22,
  pointerEvents: "auto",
};

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: "20px 28px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#d0d0e0",
  minWidth: 480,
  maxWidth: 640,
  maxHeight: "85vh",
  overflowY: "auto",
  pointerEvents: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "rgba(255,215,0,0.3) rgba(255,255,255,0.05)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: "bold",
  color: "#a0a0c0",
  letterSpacing: 2,
  textAlign: "center",
  marginBottom: 12,
};

const tabContainerStyle: React.CSSProperties = {
  display: "flex",
  gap: 4,
  marginBottom: 12,
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  paddingBottom: 8,
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "6px 16px",
  fontSize: 13,
  fontFamily: "monospace",
  color: active ? "#ffd700" : "rgba(255,255,255,0.5)",
  background: active ? "rgba(255,215,0,0.1)" : "transparent",
  border: active ? "1px solid rgba(255,215,0,0.4)" : "1px solid transparent",
  borderRadius: 4,
  cursor: "pointer",
  pointerEvents: "auto",
});

const goldStyle: React.CSSProperties = {
  textAlign: "center",
  fontSize: 14,
  color: "#e6c833",
  fontWeight: "bold",
  marginBottom: 12,
};

const closeHintStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 12,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 11,
  color: "rgba(255,255,255,0.4)",
};

type Tab = "build" | "upgrades" | "furnace";

// --- Build shop content (moved from SignpostPrompt) ---
import { BUILD_MATERIAL_INFO, BUILD_MATERIAL_PRICES, type BuildMaterialType } from "../shared/constants";

const BUILD_TYPES: BuildMaterialType[] = ["scaffolding", "ladder", "rope", "torch"];

const buildRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
};

const buildSwatchStyle = (color: string): React.CSSProperties => ({
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
  padding: "3px 8px",
  cursor: "pointer",
  pointerEvents: "auto",
};

function BuildTab() {
  const { buildMaterials, currency } = useGameStore();
  const buy = (type: BuildMaterialType, qty: number) => {
    const renderer = useGameStore.getState().renderer as
      | { buyBuildMaterial?: (type: BuildMaterialType, qty: number) => boolean }
      | null;
    renderer?.buyBuildMaterial?.(type, qty);
  };
  return (
    <>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
        Buy building materials with gold. Place them in build mode (B).
      </div>
      {BUILD_TYPES.map((type) => {
        const info = BUILD_MATERIAL_INFO[type];
        const price = BUILD_MATERIAL_PRICES[type];
        const canAfford1 = currency >= price;
        const canAfford10 = currency >= price * 10;
        return (
          <div key={type} style={buildRowStyle}>
            <span style={buildSwatchStyle(info.color)} />
            <span style={{ width: 100, textAlign: "left" }}>{info.name}</span>
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 10 }}>{info.shape}</span>
            <span style={{ color: "rgba(255,215,0,0.6)", fontSize: 11 }}>{price}g ea</span>
            <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 11 }}>(have {buildMaterials[type]})</span>
            <button style={{ ...buyBtnStyle, opacity: canAfford1 ? 1 : 0.4 }} onClick={() => canAfford1 && buy(type, 1)} disabled={!canAfford1}>Buy 1</button>
            <button style={{ ...buyBtnStyle, opacity: canAfford10 ? 1 : 0.4 }} onClick={() => canAfford10 && buy(type, 10)} disabled={!canAfford10}>Buy 10</button>
          </div>
        );
      })}
    </>
  );
}

export function ShopPanel() {
  const { showShop, nearSignpost, currency } = useGameStore();
  const [tab, setTab] = useState<Tab>("build");

  if (!showShop || !nearSignpost) return null;

  return (
    <div style={overlayStyle} onClick={() => useGameStore.getState().setShowShop(false)}>
      <div style={panelStyle} className="dd-shop-scroll" onClick={(e) => e.stopPropagation()}>
        <style>{`
          .dd-shop-scroll::-webkit-scrollbar { width: 8px; }
          .dd-shop-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
          .dd-shop-scroll::-webkit-scrollbar-thumb { background: rgba(255,215,0,0.3); border-radius: 4px; }
          .dd-shop-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,215,0,0.5); }
        `}</style>
        <div style={titleStyle}>SHOP</div>
        <div style={goldStyle}>Gold: {currency}g</div>
        <div style={tabContainerStyle}>
          <span style={tabStyle(tab === "build")} onClick={() => setTab("build")}>Build</span>
          <span style={tabStyle(tab === "upgrades")} onClick={() => setTab("upgrades")}>Upgrades</span>
          <span style={tabStyle(tab === "furnace")} onClick={() => setTab("furnace")}>Furnace</span>
        </div>
        {tab === "build" && <BuildTab />}
        {tab === "upgrades" && <UpgradeShop />}
        {tab === "furnace" && <CraftingPanel />}
        <div style={closeHintStyle}>Press O to close</div>
      </div>
    </div>
  );
}
