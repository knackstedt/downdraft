// ============================================================================
// StatsPanel — cumulative playthrough statistics display.
//
// Toggled with the Tab key. Shows all tracked statistics: play time, deepest
// depth, total ore mined, items collected, gold earned/spent, deaths, bombs,
// glowsticks, blocks placed, and a per-material collection breakdown.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { DeathCause } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  color: "rgba(255,255,255,0.9)",
  fontFamily: "monospace",
  fontSize: 13,
  padding: "20px 28px",
  background: "rgba(0,0,0,0.85)",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.15)",
  zIndex: 20,
  minWidth: 360,
  maxWidth: 480,
  maxHeight: "80vh",
  overflowY: "auto",
  pointerEvents: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: "bold",
  marginBottom: 12,
  paddingBottom: 8,
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  textAlign: "center",
  letterSpacing: 2,
  color: "#a0a0c0",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: "bold",
  marginTop: 12,
  marginBottom: 4,
  color: "rgba(255,255,255,0.6)",
  textTransform: "uppercase",
  letterSpacing: 1,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "2px 0",
};

const labelStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.7)",
};

const valueStyle: React.CSSProperties = {
  fontWeight: "bold",
  color: "#fff",
};

const goldStyle: React.CSSProperties = {
  ...valueStyle,
  color: "#e6c833",
};

const closeHintStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 12,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 11,
  color: "rgba(255,255,255,0.4)",
};

const swatchStyle = (color: string): React.CSSProperties => ({
  display: "inline-block",
  width: 10,
  height: 10,
  borderRadius: 2,
  background: color,
  border: "1px solid rgba(255,255,255,0.2)",
  marginRight: 6,
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
  [Material.Gravel]: { name: "Gravel", color: "#666560" },
  [Material.LooseStone]: { name: "Loose Stone", color: "#6b6b6e" },
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
  const { showStats, stats } = useGameStore();

  if (!showStats) return null;

  // Sort collected materials by count (descending)
  const collectedEntries: { mat: number; count: number }[] = Object.entries(stats.collectedByMaterial)
    .map(([mat, count]) => ({ mat: Number(mat), count: count as number }))
    .sort((a, b) => b.count - a.count);

  // Sort death causes by count (descending)
  const deathEntries: { cause: number; count: number }[] = Object.entries(stats.deathsByCause)
    .map(([cause, count]) => ({ cause: Number(cause), count: count as number }))
    .sort((a, b) => b.count - a.count);

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>STATISTICS</div>

      <div style={sectionTitleStyle}>Overview</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Play Time</span>
        <span style={valueStyle}>{formatPlayTime(stats.totalTicks)}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Deepest Depth</span>
        <span style={valueStyle}>{stats.maxDepthCells}m</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Cells Mined</span>
        <span style={valueStyle}>{stats.totalCellsMined.toLocaleString()}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Items Collected</span>
        <span style={valueStyle}>{stats.totalItemsCollected.toLocaleString()}</span>
      </div>

      <div style={sectionTitleStyle}>Economy</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Gold Earned</span>
        <span style={goldStyle}>{stats.totalGoldEarned.toLocaleString()}g</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Gold Spent</span>
        <span style={goldStyle}>{stats.totalGoldSpent.toLocaleString()}g</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Net Profit</span>
        <span style={goldStyle}>{(stats.totalGoldEarned - stats.totalGoldSpent).toLocaleString()}g</span>
      </div>

      <div style={sectionTitleStyle}>Combat & Tools</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Total Deaths</span>
        <span style={{ ...valueStyle, color: "#f44336" }}>{stats.totalDeaths}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Bombs Thrown</span>
        <span style={valueStyle}>{stats.totalBombsThrown}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Glowsticks Thrown</span>
        <span style={valueStyle}>{stats.totalGlowsticksThrown}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Blocks Placed</span>
        <span style={valueStyle}>{stats.totalBlocksPlaced}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Bars Crafted</span>
        <span style={valueStyle}>{stats.totalBarsCrafted}</span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Teleports Used</span>
        <span style={valueStyle}>{stats.totalTeleports}</span>
      </div>

      {collectedEntries.length > 0 && (
        <>
          <div style={sectionTitleStyle}>Materials Collected</div>
          {collectedEntries.map(({ mat, count }) => {
            const info = MATERIAL_INFO[mat] ?? { name: `Material #${mat}`, color: "#888" };
            return (
              <div key={mat} style={rowStyle}>
                <span style={labelStyle}>
                  <span style={swatchStyle(info.color)} />
                  {info.name}
                </span>
                <span style={valueStyle}>{count.toLocaleString()}</span>
              </div>
            );
          })}
        </>
      )}

      {deathEntries.length > 0 && (
        <>
          <div style={sectionTitleStyle}>Deaths by Cause</div>
          {deathEntries.map(({ cause, count }) => {
            const name = DEATH_CAUSE_NAMES[cause] ?? `Cause #${cause}`;
            return (
              <div key={cause} style={rowStyle}>
                <span style={labelStyle}>{name}</span>
                <span style={{ ...valueStyle, color: "#f44336" }}>{count}</span>
              </div>
            );
          })}
        </>
      )}

      <div style={sectionTitleStyle}>Efficiency</div>
      <div style={rowStyle}>
        <span style={labelStyle}>Net Gold</span>
        <span style={{ ...valueStyle, color: "#ffd700" }}>
          {stats.totalGoldEarned - stats.totalGoldSpent}
        </span>
      </div>
      {collectedEntries.length > 0 && (() => {
        let maxEntry = collectedEntries[0];
        for (let i = 1; i < collectedEntries.length; i++) {
          if (collectedEntries[i].count > maxEntry.count) maxEntry = collectedEntries[i];
        }
        const info = MATERIAL_INFO[maxEntry.mat] ?? { name: `Material #${maxEntry.mat}`, color: "#888" };
        return (
          <div style={rowStyle}>
            <span style={labelStyle}>Most Collected</span>
            <span style={{ ...valueStyle, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={swatchStyle(info.color)} />
              {info.name} ({maxEntry.count})
            </span>
          </div>
        );
      })()}
      <div style={rowStyle}>
        <span style={labelStyle}>Gold / Death</span>
        <span style={valueStyle}>
          {stats.totalDeaths > 0
            ? Math.floor(stats.totalGoldEarned / stats.totalDeaths)
            : stats.totalGoldEarned}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Cells / Death</span>
        <span style={valueStyle}>
          {stats.totalDeaths > 0
            ? Math.floor(stats.totalCellsMined / stats.totalDeaths)
            : stats.totalCellsMined}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Bars / Teleport</span>
        <span style={valueStyle}>
          {stats.totalTeleports > 0
            ? Math.floor(stats.totalBarsCrafted / stats.totalTeleports)
            : stats.totalBarsCrafted}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Gold / Block</span>
        <span style={{ ...valueStyle, color: "#ffd700" }}>
          {stats.totalCellsMined > 0
            ? (stats.totalGoldEarned / stats.totalCellsMined).toFixed(2)
            : "0.00"}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Gold / Hour</span>
        <span style={{ ...valueStyle, color: "#ffd700" }}>
          {(() => {
            const hours = stats.totalTicks / (60 * 3600);
            return hours > 0.01 ? Math.floor(stats.totalGoldEarned / hours) : stats.totalGoldEarned;
          })()}
        </span>
      </div>
      {stats.longestSurvivalTicks > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle}>Longest Survival</span>
          <span style={valueStyle}>
            {(() => {
              const secs = Math.floor(stats.longestSurvivalTicks / 60);
              const h = Math.floor(secs / 3600);
              const m = Math.floor((secs % 3600) / 60);
              const s = secs % 60;
              return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
            })()}
          </span>
        </div>
      )}

      <div style={closeHintStyle}>Press Tab to close</div>
    </div>
  );
}
