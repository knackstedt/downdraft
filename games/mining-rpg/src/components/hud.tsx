// ============================================================================
// HUD — heads-up display overlay for the mining RPG.
//
// Shows only the essential always-visible stats: health bar, oxygen bar
// (when submerged), depth + biome, gold, inventory capacity, and key
// status indicators (build mode, noclip, headlamp, paused).
//
// The detailed ore inventory is in the InventoryPanel (toggle with I).
// Cumulative statistics are in the StatsPanel (toggle with Tab).
// ============================================================================

import { OXYGEN_MAX_TICKS } from "../shared/constants";
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
  minWidth: 160,
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
  background: pct > 50 ? "#29b6f6" : pct > 20 ? "#26c6da" : "#ef5350",
  transition: "width 0.15s",
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

/** Next biome name and progress (0-1) toward it. */
function depthBiomeProgress(depthMeters: number): { next: string; pct: number } {
  const thresholds = [50, 200, 500, 1000, 1500, 2000, 3000, 4000];
  const names = ["Topsoil Layer", "Shallow Caves", "Deep Caves", "Iron Belt", "Silver Depths", "Gold Zone", "Cobalt Abyss", "Mantle"];
  for (let i = 0; i < thresholds.length; i++) {
    if (depthMeters < thresholds[i]) {
      const prev = i > 0 ? thresholds[i - 1] : 0;
      return { next: names[i], pct: (depthMeters - prev) / (thresholds[i] - prev) };
    }
  }
  return { next: "Max Depth", pct: 1 };
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
  const { fps, health, oxygen, depth, paused, digRadius, inventory, currency, buildMode, noclip, headlampOn, upgrades, stats, unlockedAchievements, lastSaveTime, teleportCooldown, goldFlashTime, showHUD, glowstickCount, bombCount, zoom, showFPS, getMaxInventory, getInventoryCount } = useGameStore();

  if (!showHUD) return null;

  const depthMeters = depth * 128; // CHUNK_H = 128 cells, ~1m per cell
  const invUsed = getInventoryCount();
  const invMax = getMaxInventory();
  const invPct = invMax > 0 ? (invUsed / invMax) * 100 : 0;
  const invColor = invPct < 70 ? "#4caf50" : invPct < 90 ? "#ff9800" : "#f44336";
  // Oxygen bar — only show when below max (i.e. player has been submerged).
  const oxygenPct = OXYGEN_MAX_TICKS > 0 ? (oxygen / OXYGEN_MAX_TICKS) * 100 : 100;
  const showOxygen = oxygen < OXYGEN_MAX_TICKS;
  const biomeColor = depthBiomeColor(depthMeters);
  const biomeProg = depthBiomeProgress(depthMeters);

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
      {/* Biome-colored top border accent — crisp solid line */}
      <div style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: biomeColor,
        borderRadius: 0,
      }} />
      {showFPS && (
        <div style={{ color: fps == null ? "rgba(255,255,255,0.5)" : fps >= 50 ? "#4caf50" : fps >= 30 ? "#ff9800" : "#f44336" }}>
          FPS: {fps ?? "—"}
        </div>
      )}
      {/* Health */}
      <div style={{ ...healthBarStyle, ...(health < 25 ? { animation: "healthPulse 0.6s ease-in-out infinite" } : {}) }}>
        <span>HP</span>
        <div style={barOuterStyle}>
          <div style={barInnerStyle(health)} />
        </div>
        <span style={{ color: health < 25 ? "#f44336" : "inherit" }}>{Math.ceil(health)}</span>
      </div>
      {/* Oxygen (only when submerged) */}
      {showOxygen && (
        <div style={{ ...healthBarStyle, ...(oxygenPct < 20 ? { animation: "oxygenPulse 0.8s ease-in-out infinite" } : {}) }}>
          <span>O2</span>
          <div style={barOuterStyle}>
            <div style={oxygenBarInnerStyle(oxygenPct)} />
          </div>
          <span style={{ color: oxygenPct < 20 ? "#ef5350" : "inherit" }}>{Math.ceil(oxygen / 60)}s</span>
        </div>
      )}
      {/* Inventory capacity */}
      <div style={healthBarStyle}>
        <span>Inv</span>
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
        <div style={{ color: "#f44336", fontSize: 11, fontWeight: "bold", animation: invPct >= 100 ? "healthPulse 0.6s ease-in-out infinite" : "none" }}>
          ⚠ Inventory {invPct >= 100 ? "FULL" : "ALMOST FULL"} — sell at signpost (E) or teleport (T)
        </div>
      )}
      {/* Depth + biome */}
      <div>Depth: {depthMeters}m</div>
      <div style={{ color: biomeColor, fontSize: 12, fontWeight: "bold" }}>
        {depthBiomeName(depthMeters)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
        <div style={{ width: 70, height: 3, background: "rgba(255,255,255,0.1)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${biomeProg.pct * 100}%`, height: "100%", background: biomeColor, transition: "width 0.3s" }} />
        </div>
        <span>→ {biomeProg.next}</span>
      </div>
      {stats.maxDepthCells > depthMeters && (
        <div style={{ fontSize: 10, color: "rgba(255,215,0,0.5)" }}>
          Deepest: {stats.maxDepthCells}m
        </div>
      )}
      {/* Teleport cooldown */}
      {depthMeters >= 10 && (
        <div style={{ fontSize: 10, color: teleportCooldown >= 1 ? "rgba(66,165,245,0.7)" : "rgba(255,255,255,0.3)" }}>
          T: {teleportCooldown >= 1 ? `Ready (${Math.max(1, Math.floor(depthMeters / 10))}g)` : `${Math.ceil((1 - teleportCooldown) * 3)}s`}
        </div>
      )}
      {/* Gold */}
      <div style={{
        color: "#e6c833",
        fontSize: 14,
        fontWeight: "bold",
        ...(Date.now() - goldFlashTime < 500 ? {
          textShadow: "0 0 8px rgba(255,215,0,0.8)",
          transform: "scale(1.1)",
          transition: "transform 0.1s",
        } : {}),
      }}>{currency}g</div>
      {/* Achievements quick-stat */}
      <div style={{ fontSize: 10, color: "rgba(255,215,0,0.5)" }}>
        Achievements: {unlockedAchievements.size}/{stats.totalDeaths >= 0 ? "35" : "35"} (F4)
      </div>
      {/* Save indicator */}
      {lastSaveTime > 0 && (
        <div style={{ fontSize: 9, color: (() => {
          const ago = Math.floor((Date.now() - lastSaveTime) / 1000);
          return ago < 3 ? "#4caf50" : "rgba(255,255,255,0.3)";
        })() }}>
          {(() => {
            const ago = Math.floor((Date.now() - lastSaveTime) / 1000);
            if (ago < 3) return "Saving...";
            if (ago < 60) return `Saved ${ago}s ago`;
            if (ago < 3600) return `Saved ${Math.floor(ago / 60)}m ago`;
            return `Saved ${Math.floor(ago / 3600)}h ago`;
          })()}
        </div>
      )}
      {/* Status indicators */}
      {noclip && <div style={{ color: "#00e5ff", fontWeight: "bold" }}>NOCLIP — F3 to disable</div>}
      {buildMode && <div style={{ color: "#ffd700", fontWeight: "bold" }}>BUILD MODE — 1/2/3/4 to select</div>}
      {headlampOn && <div style={{ color: "#ffcc66", fontSize: 11 }}>Headlamp ON (L)</div>}
      {bombCount > 0 && <div style={{ fontSize: 10, color: "rgba(255,152,0,0.5)" }}>Bombs: {bombCount} active</div>}
      {glowstickCount > 0 && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>Glowsticks: {glowstickCount}/32</div>}
      {paused && <div style={{ color: "#ff5252", fontWeight: "bold" }}>PAUSED</div>}
    </div>
  );
}
