// ============================================================================
// HUD — heads-up display overlay for the mining RPG.
//
// Shows: FPS, health bar, depth meter, dig brush radius, loaded/active chunks,
// and a compact ore inventory summary. Positioned at the top-left corner.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { BUILD_MATERIAL_INFO, OXYGEN_MAX_TICKS, SELL_PRICES, type BuildMaterialType } from "../shared/constants";
import { CRAFTED_SELL_PRICES } from "../shared/crafting-recipes";
import type { CraftedItemId } from "../shared/types";
import { useGameStore } from "../stores/game-store";

const containerStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  color: "rgba(255,255,255,0.85)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "8px 12px",
  background: "rgba(0,0,0,0.6)",
  borderRadius: 4,
  pointerEvents: "none",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  alignItems: "flex-end",
  textAlign: "right",
};

const healthBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const barOuterStyle: React.CSSProperties = {
  width: 100,
  height: 10,
  background: "rgba(255,255,255,0.15)",
  borderRadius: 2,
  overflow: "hidden",
};

const barInnerStyle = (health: number): React.CSSProperties => ({
  width: `${Math.max(0, Math.min(100, health))}%`,
  height: "100%",
  background: health > 50 ? "#4caf50" : health > 25 ? "#ff9800" : "#f44336",
  transition: "width 0.2s",
});

const oxygenBarInnerStyle = (pct: number): React.CSSProperties => ({
  width: `${Math.max(0, Math.min(100, pct))}%`,
  height: "100%",
  // Blue when healthy, cyan when mid, red when near-empty
  background: pct > 50 ? "#29b6f6" : pct > 20 ? "#26c6da" : "#ef5350",
  transition: "width 0.15s",
});

const oreRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 4,
};

const oreItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
};

const oreSwatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: 2,
  background: color,
});

// Material ID → display name + color
const ORE_INFO: Record<number, { name: string; color: string }> = {
  [Material.TinOre]: { name: "Tin", color: "#b3b4b8" },
  [Material.CopperOre]: { name: "Copper", color: "#b87333" },
  [Material.IronOre]: { name: "Iron", color: "#8c7365" },
  [Material.BauxiteOre]: { name: "Bauxite", color: "#bf8066" },
  [Material.SilverOre]: { name: "Silver", color: "#d9d9e0" },
  [Material.GoldOre]: { name: "Gold", color: "#e6c833" },
  [Material.CobaltOre]: { name: "Cobalt", color: "#4059cc" },
  [Material.Coal]: { name: "Coal", color: "#1a1a1a" },
  [Material.Iron]: { name: "Iron Block", color: "#888" },
  [Material.Stone]: { name: "Stone", color: "#666" },
  [Material.Dirt]: { name: "Dirt", color: "#8b5a2b" },
  [Material.Grass]: { name: "Grass", color: "#4a7c2f" },
  [Material.Gravel]: { name: "Gravel", color: "#666560" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#6b6b6e" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
};

const buildRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 4,
};

const buildItemStyle = (selected: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 3,
  fontSize: 11,
  padding: "1px 4px",
  borderRadius: 3,
  border: selected ? "1px solid #ffd700" : "1px solid transparent",
  background: selected ? "rgba(255,215,0,0.12)" : "transparent",
});

/** Depth biome/layer name based on depth in meters. */
function depthBiomeName(depthMeters: number): string {
  if (depthMeters < 50) return "Surface";
  if (depthMeters < 200) return "Topsoil Layer";
  if (depthMeters < 500) return "Shallow Caves";
  if (depthMeters < 1000) return "Deep Caves";
  if (depthMeters < 1500) return "Iron Belt";
  if (depthMeters < 2000) return "Silver Depths";
  if (depthMeters < 3000) return "Gold Zone";
  if (depthMeters < 4000) return "Cobalt Abyss";
  return "Mantle";
}

/** Color for the biome label based on depth. */
function depthBiomeColor(depthMeters: number): string {
  if (depthMeters < 200) return "#8bc34a";
  if (depthMeters < 500) return "#ffb74d";
  if (depthMeters < 1000) return "#ff9800";
  if (depthMeters < 2000) return "#e57373";
  if (depthMeters < 3000) return "#ba68c8";
  return "#7986cb";
}

export function HUD() {
  const { fps, health, oxygen, depth, paused, loadedChunks, activeChunks, digRadius, inventory, currency, craftedItems, buildMode, selectedBuild, buildMaterials, noclip, headlampOn, upgrades, stats, unlockedAchievements, lastSaveTime, getMaxInventory, getInventoryCount } = useGameStore();

  const depthMeters = depth * 128; // CHUNK_H = 128 cells, ~1m per cell
  const invUsed = getInventoryCount();
  const invMax = getMaxInventory();
  const invPct = invMax > 0 ? (invUsed / invMax) * 100 : 0;
  const invColor = invPct < 70 ? "#4caf50" : invPct < 90 ? "#ff9800" : "#f44336";
  // Oxygen bar — only show when below max (i.e. player has been submerged).
  // Hides when full to avoid cluttering the HUD during normal play.
  const oxygenPct = OXYGEN_MAX_TICKS > 0 ? (oxygen / OXYGEN_MAX_TICKS) * 100 : 100;
  const showOxygen = oxygen < OXYGEN_MAX_TICKS;

  // Calculate total sell value (inventory + crafted bars)
  let sellValue = 0;
  for (let i = 0; i < inventory.length; i++) {
    const entry = inventory[i];
    sellValue += (SELL_PRICES[entry.mat] ?? 0) * entry.count;
  }
  const craftedKeys = Object.keys(craftedItems) as CraftedItemId[];
  for (let i = 0; i < craftedKeys.length; i++) {
    const id = craftedKeys[i];
    sellValue += (CRAFTED_SELL_PRICES[id] ?? 0) * craftedItems[id];
  }

  return (
    <div style={containerStyle}>
      <style>{`
        @keyframes oxygenPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes healthPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
      <div style={{ color: fps == null ? "rgba(255,255,255,0.5)" : fps >= 50 ? "#4caf50" : fps >= 30 ? "#ff9800" : "#f44336" }}>
        FPS: {fps ?? "—"}
      </div>
      <div style={{ ...healthBarStyle, ...(health < 25 ? { animation: "healthPulse 0.6s ease-in-out infinite" } : {}) }}>
        <span>HP:</span>
        <div style={barOuterStyle}>
          <div style={barInnerStyle(health)} />
        </div>
        <span style={{ color: health < 25 ? "#f44336" : "inherit" }}>{Math.ceil(health)}</span>
      </div>
      {showOxygen && (
        <div style={{ ...healthBarStyle, ...(oxygenPct < 20 ? { animation: "oxygenPulse 0.8s ease-in-out infinite" } : {}) }}>
          <span>O2:</span>
          <div style={barOuterStyle}>
            <div style={oxygenBarInnerStyle(oxygenPct)} />
          </div>
          <span style={{ color: oxygenPct < 20 ? "#ef5350" : "inherit" }}>{Math.ceil(oxygen / 60)}s</span>
        </div>
      )}
      <div style={healthBarStyle}>
        <span>Inv:</span>
        <div style={barOuterStyle}>
          <div style={{
            width: `${Math.min(100, invPct)}%`,
            height: "100%",
            background: invColor,
            transition: "width 0.2s",
          }} />
        </div>
        <span>{invUsed}/{invMax}</span>
      </div>
      {invPct >= 90 && (
        <div style={{ color: "#f44336", fontSize: 11, fontWeight: "bold" }}>
          ⚠ Inventory {invPct >= 100 ? "FULL" : "ALMOST FULL"} — sell at signpost (E) or teleport (T)
        </div>
      )}
      <div>Depth: {depthMeters}m</div>
      <div style={{ color: depthBiomeColor(depthMeters), fontSize: 11, fontWeight: "bold" }}>
        {depthBiomeName(depthMeters)}
      </div>
      {stats.maxDepthCells > depthMeters ? (
        <div style={{ fontSize: 10, color: "rgba(255,215,0,0.5)" }}>
          Deepest: {stats.maxDepthCells}m
        </div>
      ) : depthMeters > 10 ? (
        <div style={{ fontSize: 10, color: "#ffd700", fontWeight: "bold" }}>
          ★ NEW RECORD!
        </div>
      ) : null}
      <div>Brush: {digRadius} cells</div>
      <div>Chunks: {loadedChunks} loaded, {activeChunks} active</div>
      <div style={{ color: "#e6c833" }}>Gold: {currency}</div>
      {sellValue > 0 && (
        <div style={{ color: "rgba(255,215,0,0.5)", fontSize: 11 }}>
          Bag value: {sellValue}g (press E to sell)
        </div>
      )}
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
        Upg: DMG {upgrades.damage} | RAD {upgrades.radius} | SPD {upgrades.rate} | INV {upgrades.inventorySize}
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,215,0,0.5)" }}>
        Achievements: {unlockedAchievements.size}/35 (F4)
      </div>
      {lastSaveTime > 0 && (
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)" }}>
          Last save: {(() => {
            const ago = Math.floor((Date.now() - lastSaveTime) / 1000);
            if (ago < 60) return `${ago}s ago`;
            if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
            return `${Math.floor(ago / 3600)}h ago`;
          })()}
        </div>
      )}
      {buildMode && <div style={{ color: "#ffd700" }}>BUILD MODE — left-click to place (1/2/3/4 to select)</div>}
      <div style={{ color: headlampOn ? "#ffcc66" : "#666" }}>Headlamp: {headlampOn ? "ON" : "OFF"} (L to toggle)</div>
      <div style={{ color: "#888" }}>F: Torch · G: Glowstick · RMB: Bomb</div>
      {noclip && <div style={{ color: "#00e5ff" }}>NOCLIP — WASD/Space to fly, F3 to disable</div>}
      <div style={buildRowStyle}>
        {(Object.keys(BUILD_MATERIAL_INFO) as BuildMaterialType[]).map((type) => {
          const info = BUILD_MATERIAL_INFO[type];
          const count = buildMaterials[type];
          return (
            <div key={type} style={buildItemStyle(buildMode && selectedBuild === type)}>
              <span style={oreSwatchStyle(info.color)} />
              <span>{info.name}: {count}</span>
            </div>
          );
        })}
      </div>
      {paused && <div style={{ color: "#ff5252" }}>PAUSED</div>}
      {inventory.length > 0 && (
        <div style={oreRowStyle}>
          {inventory.map((entry) => {
            const info = ORE_INFO[entry.mat];
            if (!info) return null;
            return (
              <div key={entry.mat} style={oreItemStyle}>
                <span style={oreSwatchStyle(info.color)} />
                <span>{info.name}: {entry.count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
