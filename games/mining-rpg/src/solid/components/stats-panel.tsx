// ============================================================================
// StatsPanel — cumulative playthrough statistics display.
//
// Toggled with the Tab key. Shows all tracked statistics: play time, deepest
// depth, total ore mined, items collected, gold earned/spent, deaths, bombs,
// glowsticks, blocks placed, and a per-material collection breakdown.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import type { JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { DeathCause } from "../../shared/constants";
import { gameStore } from "../stores/game-store";

const panelStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  color: "rgba(255,255,255,0.9)",
  "font-family": "monospace",
  "font-size": "13px",
  padding: "20px 28px",
  background: "rgba(0,0,0,0.85)",
  "border-radius": "8px",
  border: "1px solid rgba(255,255,255,0.15)",
  "z-index": "20",
  "min-width": "360px",
  "max-width": "480px",
  "max-height": "80vh",
  "overflow-y": "auto",
  "pointer-events": "auto",
  "scrollbar-width": "thin",
  "scrollbar-color": "rgba(255,255,255,0.2) rgba(255,255,255,0.05)",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "18px",
  "font-weight": "bold",
  "margin-bottom": "12px",
  "padding-bottom": "8px",
  "border-bottom": "1px solid rgba(255,255,255,0.15)",
  "text-align": "center",
  "letter-spacing": "2px",
  color: "#a0a0c0",
};

const sectionTitleStyle: JSX.CSSProperties = {
  "font-size": "12px",
  "font-weight": "bold",
  "margin-top": "12px",
  "margin-bottom": "4px",
  color: "rgba(255,255,255,0.6)",
  "text-transform": "uppercase",
  "letter-spacing": "1px",
};

const rowStyle: JSX.CSSProperties = {
  display: "flex",
  "justify-content": "space-between",
  padding: "2px 0",
};

const labelStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.7)",
};

const valueStyle: JSX.CSSProperties = {
  "font-weight": "bold",
  color: "#fff",
};

const goldStyle: JSX.CSSProperties = {
  ...valueStyle,
  color: "#e6c833",
};

const closeHintStyle: JSX.CSSProperties = {
  "text-align": "center",
  "margin-top": "12px",
  "padding-top": "8px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "11px",
  color: "rgba(255,255,255,0.4)",
};

const swatchStyle = (color: string): JSX.CSSProperties => ({
  display: "inline-block",
  width: "10px",
  height: "10px",
  "border-radius": "2px",
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
  "margin-right": "6px",
});

// Material ID → display name + color
const MATERIAL_INFO: Record<number, { name: string; color: string }> = {
  [Material.TinOre]: { name: "Tin Ore", color: "#b3b4b8" },
  [Material.CopperOre]: { name: "Copper Ore", color: "#b87333" },
  [Material.IronOre]: { name: "Iron Ore", color: "#8c7365" },
  [Material.BauxiteOre]: { name: "Bauxite Ore", color: "#bf8066" },
  [Material.SilverOre]: { name: "Silver Ore", color: "#d9d9e0" },
  [Material.GoldOre]: { name: "Gold Ore", color: "#e6c833" },
  [Material.CobaltOre]: { name: "Cobalt Ore", color: "#4059cc" },
  [Material.Coal]: { name: "Coal", color: "#1a1a1a" },
  [Material.Iron]: { name: "Iron Block", color: "#888888" },
  [Material.Stone]: { name: "Stone", color: "#666666" },
  [Material.Dirt]: { name: "Dirt", color: "#8b5a2b" },
  [Material.Grass]: { name: "Grass", color: "#4a7c2f" },
  [Material.Gravel]: { name: "Gravel", color: "#73737a" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#73737a" },
  [Material.Sand]: { name: "Sand", color: "#c2b280" },
};

// Death cause names (Material IDs + DeathCause IDs)
const DEATH_CAUSE_NAMES: Record<number, string> = {
  [Material.Lava]: "Lava",
  [Material.Fire]: "Fire",
  [Material.Plasma]: "Plasma",
  [Material.FuseFire]: "Fuse Fire",
  [Material.BurningOil]: "Burning Oil",
  [Material.MethaneGas]: "Methane Gas",
  [Material.SulfurGas]: "Sulfur Gas",
  [DeathCause.Suffocation]: "Suffocation",
  [DeathCause.Falling]: "Falling",
  [DeathCause.Drowning]: "Drowning",
};

/** Format ticks as a human-readable time string (e.g. "1h 23m 45s"). */
function formatPlayTime(ticks: number): string {
  const totalSeconds = Math.floor(ticks / 60); // 60tps
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatsPanel() {
  const [copied, setCopied] = createSignal(false);

  // Sort collected materials by count (descending)
  const collectedEntries = () => {
    const entries = Object.entries(gameStore.stats.collectedByMaterial)
      .map(([mat, count]) => ({ mat: Number(mat), count: count as number }))
      .sort((a, b) => b.count - a.count);
    return entries;
  };

  // Sort death causes by count (descending)
  const deathEntries = () => {
    return Object.entries(gameStore.stats.deathsByCause)
      .map(([cause, count]) => ({ cause: Number(cause), count: count as number }))
      .sort((a, b) => b.count - a.count);
  };

  const mostCollected = () => {
    const entries = collectedEntries();
    if (entries.length === 0) return null;
    let max = entries[0];
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].count > max.count) max = entries[i];
    }
    return max;
  };

  const goldPerHour = () => {
    const hours = gameStore.stats.totalTicks / (60 * 3600);
    return hours > 0.01 ? Math.floor(gameStore.stats.totalGoldEarned / hours) : gameStore.stats.totalGoldEarned;
  };

  const longestSurvivalStr = () => {
    const secs = Math.floor(gameStore.stats.longestSurvivalTicks / 60);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <Show when={gameStore.showStats}>
      <div style={panelStyle} class="dd-stats-scroll">
        <style>{`
          .dd-stats-scroll::-webkit-scrollbar { width: 8px; }
          .dd-stats-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
          .dd-stats-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
          .dd-stats-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
        `}</style>
        <div style={titleStyle}>STATISTICS</div>

        <div style={sectionTitleStyle}>Overview</div>
        <div style={rowStyle}>
          <span style={labelStyle}>Play Time</span>
          <span style={valueStyle}>{formatPlayTime(gameStore.stats.totalTicks)}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Deepest Depth</span>
          <span style={valueStyle}>{gameStore.stats.maxDepthCells}m</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Cells Mined</span>
          <span style={valueStyle}>{gameStore.stats.totalCellsMined.toLocaleString()}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Items Collected</span>
          <span style={valueStyle}>{gameStore.stats.totalItemsCollected.toLocaleString()}</span>
        </div>

        <div style={sectionTitleStyle}>Economy</div>
        <div style={rowStyle}>
          <span style={labelStyle}>Gold Earned</span>
          <span style={goldStyle}>{gameStore.stats.totalGoldEarned.toLocaleString()}g</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Gold Spent</span>
          <span style={goldStyle}>{gameStore.stats.totalGoldSpent.toLocaleString()}g</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Net Profit</span>
          <span style={goldStyle}>{(gameStore.stats.totalGoldEarned - gameStore.stats.totalGoldSpent).toLocaleString()}g</span>
        </div>

        <div style={sectionTitleStyle}>Combat & Tools</div>
        <div style={rowStyle}>
          <span style={labelStyle}>Total Deaths</span>
          <span style={{ ...valueStyle, color: "#f44336" }}>{gameStore.stats.totalDeaths}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Bombs Thrown</span>
          <span style={valueStyle}>{gameStore.stats.totalBombsThrown}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Glowsticks Thrown</span>
          <span style={valueStyle}>{gameStore.stats.totalGlowsticksThrown}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Blocks Placed</span>
          <span style={valueStyle}>{gameStore.stats.totalBlocksPlaced}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Bars Crafted</span>
          <span style={valueStyle}>{gameStore.stats.totalBarsCrafted}</span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Teleports Used</span>
          <span style={valueStyle}>{gameStore.stats.totalTeleports}</span>
        </div>

        <Show when={collectedEntries().length > 0}>
          <div style={sectionTitleStyle}>Materials Collected</div>
          <For each={collectedEntries()}>
            {({ mat, count }) => {
              const info = MATERIAL_INFO[mat] ?? { name: `Material #${mat}`, color: "#888" };
              return (
                <div style={rowStyle}>
                  <span style={labelStyle}>
                    <span style={swatchStyle(info.color)} />
                    {info.name}
                  </span>
                  <span style={valueStyle}>{count.toLocaleString()}</span>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={deathEntries().length > 0}>
          <div style={sectionTitleStyle}>Deaths by Cause</div>
          <For each={deathEntries()}>
            {({ cause, count }) => {
              const name = DEATH_CAUSE_NAMES[cause] ?? `Cause #${cause}`;
              return (
                <div style={rowStyle}>
                  <span style={labelStyle}>{name}</span>
                  <span style={{ ...valueStyle, color: "#f44336" }}>{count}</span>
                </div>
              );
            }}
          </For>
        </Show>

        <div style={sectionTitleStyle}>Efficiency</div>
        <div style={rowStyle}>
          <span style={labelStyle}>Net Gold</span>
          <span style={{ ...valueStyle, color: "#ffd700" }}>
            {gameStore.stats.totalGoldEarned - gameStore.stats.totalGoldSpent}
          </span>
        </div>
        <Show when={mostCollected()}>
          {(max) => {
            const info = MATERIAL_INFO[max().mat] ?? { name: `Material #${max().mat}`, color: "#888" };
            return (
              <div style={rowStyle}>
                <span style={labelStyle}>Most Collected</span>
                <span style={{ ...valueStyle, display: "flex", "align-items": "center", gap: "4px" }}>
                  <span style={swatchStyle(info.color)} />
                  {info.name} ({max().count})
                </span>
              </div>
            );
          }}
        </Show>
        <div style={rowStyle}>
          <span style={labelStyle}>Gold / Death</span>
          <span style={valueStyle}>
            {gameStore.stats.totalDeaths > 0
              ? Math.floor(gameStore.stats.totalGoldEarned / gameStore.stats.totalDeaths)
              : gameStore.stats.totalGoldEarned}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Cells / Death</span>
          <span style={valueStyle}>
            {gameStore.stats.totalDeaths > 0
              ? Math.floor(gameStore.stats.totalCellsMined / gameStore.stats.totalDeaths)
              : gameStore.stats.totalCellsMined}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Bars / Teleport</span>
          <span style={valueStyle}>
            {gameStore.stats.totalTeleports > 0
              ? Math.floor(gameStore.stats.totalBarsCrafted / gameStore.stats.totalTeleports)
              : gameStore.stats.totalBarsCrafted}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Gold / Block</span>
          <span style={{ ...valueStyle, color: "#ffd700" }}>
            {gameStore.stats.totalCellsMined > 0
              ? (gameStore.stats.totalGoldEarned / gameStore.stats.totalCellsMined).toFixed(2)
              : "0.00"}
          </span>
        </div>
        <div style={rowStyle}>
          <span style={labelStyle}>Gold / Hour</span>
          <span style={{ ...valueStyle, color: "#ffd700" }}>{goldPerHour()}</span>
        </div>
        <Show when={gameStore.stats.longestSurvivalTicks > 0}>
          <div style={rowStyle}>
            <span style={labelStyle}>Longest Survival</span>
            <span style={valueStyle}>{longestSurvivalStr()}</span>
          </div>
        </Show>

        <button
          style={{
            "margin-top": "8px",
            padding: "6px 12px",
            "font-size": "11px",
            "font-family": "monospace",
            color: "rgba(255,255,255,0.6)",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.15)",
            "border-radius": "4px",
            cursor: "pointer",
          }}
          onClick={() => {
            const lines = [
              `=== Mining RPG Stats ===`,
              `Play Time: ${formatPlayTime(gameStore.stats.totalTicks)}`,
              `Max Depth: ${gameStore.stats.maxDepthCells}m`,
              `Blocks Mined: ${gameStore.stats.totalCellsMined}`,
              `Items Collected: ${gameStore.stats.totalItemsCollected}`,
              `Bars Crafted: ${gameStore.stats.totalBarsCrafted}`,
              `Gold Earned: ${gameStore.stats.totalGoldEarned}`,
              `Gold Spent: ${gameStore.stats.totalGoldSpent}`,
              `Deaths: ${gameStore.stats.totalDeaths}`,
              `Bombs: ${gameStore.stats.totalBombsThrown}`,
              `Glowsticks: ${gameStore.stats.totalGlowsticksThrown}`,
              `Blocks Built: ${gameStore.stats.totalBlocksPlaced}`,
              `Teleports: ${gameStore.stats.totalTeleports}`,
              `Longest Survival: ${formatPlayTime(gameStore.stats.longestSurvivalTicks)}`,
            ];
            navigator.clipboard?.writeText(lines.join("\n")).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied() ? "Copied!" : "Copy Stats to Clipboard"}
        </button>

        <div style={closeHintStyle}>Press Tab to close</div>
      </div>
    </Show>
  );
}
