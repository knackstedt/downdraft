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

import { Show } from "solid-js";
import { getBiomeEffect, OXYGEN_MAX_TICKS } from "../../shared/constants";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

const containerStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  color: "rgba(255,255,255,0.85)",
  "font-family": "monospace",
  "font-size": "13px",
  padding: "8px 12px",
  background: "rgba(0,0,0,0.6)",
  "border-radius": "4px",
  "pointer-events": "none",
  "z-index": "10",
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  "align-items": "flex-end",
  "text-align": "right",
  "min-width": "160px",
};

const healthBarStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "6px",
};

const barOuterStyle: JSX.CSSProperties = {
  width: "100px",
  height: "10px",
  background: "rgba(255,255,255,0.15)",
  "border-radius": "2px",
  overflow: "hidden",
};

const barInnerStyle = (health: number): JSX.CSSProperties => ({
  width: `${Math.max(0, Math.min(100, health))}%`,
  height: "100%",
  background: health > 50 ? "#4caf50" : health > 25 ? "#ff9800" : "#f44336",
  transition: "width 0.2s",
});

const oxygenBarInnerStyle = (pct: number): JSX.CSSProperties => ({
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
  const depthMeters = () => gameStore.depth * 128; // CHUNK_H = 128 cells, ~1m per cell
  const invUsed = () => actions.getInventoryCount();
  const invMax = () => actions.getMaxInventory();
  const invPct = () => invMax() > 0 ? (invUsed() / invMax()) * 100 : 0;
  const invColor = () => invPct() < 70 ? "#4caf50" : invPct() < 90 ? "#ff9800" : "#f44336";
  // Oxygen bar — only show when below max (i.e. player has been submerged).
  const oxygenPct = () => OXYGEN_MAX_TICKS > 0 ? (gameStore.oxygen / OXYGEN_MAX_TICKS) * 100 : 100;
  const showOxygen = () => gameStore.oxygen < OXYGEN_MAX_TICKS;
  const biomeColor = () => depthBiomeColor(depthMeters());
  const biomeProg = () => depthBiomeProgress(depthMeters());
  const biomeEffect = () => getBiomeEffect(depthMeters());
  const hasBiomeEffect = () => biomeEffect().gravityMul > 1.0 || biomeEffect().heatDmgPerTick > 0 || biomeEffect().oxygenDrainMul > 1.0;

  return (
    <Show when={gameStore.showHUD}>
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
          height: "2px",
          background: biomeColor(),
          "border-radius": 0,
        }} />
        <Show when={gameStore.showFPS}>
          <div style={{ color: gameStore.fps == null ? "rgba(255,255,255,0.5)" : gameStore.fps >= 50 ? "#4caf50" : gameStore.fps >= 30 ? "#ff9800" : "#f44336" }}>
            FPS: {gameStore.fps ?? "—"}
          </div>
        </Show>
        {/* Health */}
        <div style={{ ...healthBarStyle, ...(gameStore.health < 25 ? { animation: "healthPulse 0.6s ease-in-out infinite" } : {}) }}>
          <span>HP</span>
          <div style={barOuterStyle}>
            <div style={barInnerStyle(gameStore.health)} />
          </div>
          <span style={{ color: gameStore.health < 25 ? "#f44336" : "inherit" }}>{Math.ceil(gameStore.health)}</span>
        </div>
        {/* Oxygen (only when submerged) */}
        <Show when={showOxygen()}>
          <div style={{ ...healthBarStyle, ...(oxygenPct() < 20 ? { animation: "oxygenPulse 0.8s ease-in-out infinite" } : {}) }}>
            <span>O2</span>
            <div style={barOuterStyle}>
              <div style={oxygenBarInnerStyle(oxygenPct())} />
            </div>
            <span style={{ color: oxygenPct() < 20 ? "#ef5350" : "inherit" }}>{Math.ceil(gameStore.oxygen / 60)}s</span>
          </div>
        </Show>
        {/* Inventory capacity */}
        <div style={healthBarStyle}>
          <span>Inv</span>
          <div style={barOuterStyle}>
            <div style={{
              width: `${Math.min(100, invPct())}%`,
              height: "100%",
              background: invColor(),
              transition: "width 0.2s",
            }} />
          </div>
          <span>{invUsed()}/{invMax()}</span>
        </div>
        <Show when={invPct() >= 90}>
          <div style={{ color: "#f44336", "font-size": "11px", "font-weight": "bold", animation: invPct() >= 100 ? "healthPulse 0.6s ease-in-out infinite" : "none" }}>
            ⚠ Inventory {invPct() >= 100 ? "FULL" : "ALMOST FULL"} — sell at signpost (E) or teleport (T)
          </div>
        </Show>
        {/* Depth + biome */}
        <div>Depth: {depthMeters()}m</div>
        <div style={{ color: biomeColor(), "font-size": "12px", "font-weight": "bold" }}>
          {depthBiomeName(depthMeters())}
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "4px", "font-size": "10px", color: "rgba(255,255,255,0.4)" }}>
          <div style={{ width: "70px", height: "3px", background: "rgba(255,255,255,0.1)", "border-radius": "2px", overflow: "hidden" }}>
            <div style={{ width: `${biomeProg().pct * 100}%`, height: "100%", background: biomeColor(), transition: "width 0.3s" }} />
          </div>
          <span>→ {biomeProg().next}</span>
        </div>
        {/* Biome effects indicator */}
        <Show when={hasBiomeEffect()}>
          <div style={{ "font-size": "10px", color: "rgba(255,152,0,0.6)", display: "flex", "flex-direction": "column", gap: "1px", "margin-top": "2px" }}>
            <Show when={biomeEffect().gravityMul > 1.0}>
              <span>Gravity: {biomeEffect().gravityMul.toFixed(2)}x</span>
            </Show>
            <Show when={biomeEffect().heatDmgPerTick > 0}>
              <span style={{ color: "rgba(255,87,34,0.7)" }}>Heat: {biomeEffect().heatDmgPerTick}/tick</span>
            </Show>
            <Show when={biomeEffect().oxygenDrainMul > 1.0}>
              <span style={{ color: "rgba(41,182,246,0.6)" }}>Pressure: {biomeEffect().oxygenDrainMul.toFixed(1)}x O2</span>
            </Show>
          </div>
        </Show>
        <Show when={gameStore.stats.maxDepthCells > depthMeters()}>
          <div style={{ "font-size": "10px", color: "rgba(255,215,0,0.5)" }}>
            Deepest: {gameStore.stats.maxDepthCells}m
          </div>
        </Show>
        {/* Teleport cooldown */}
        <Show when={depthMeters() >= 10}>
          <div style={{ "font-size": "10px", color: gameStore.teleportCooldown >= 1 ? "rgba(66,165,245,0.7)" : "rgba(255,255,255,0.3)" }}>
            T: {gameStore.teleportCooldown >= 1 ? `Ready (${Math.max(1, Math.floor(depthMeters() / 10))}g)` : `${Math.ceil((1 - gameStore.teleportCooldown) * 3)}s`}
          </div>
        </Show>
        {/* Gold */}
        <div style={{
          color: "#e6c833",
          "font-size": "14px",
          "font-weight": "bold",
          ...(Date.now() - gameStore.goldFlashTime < 500 ? {
            "text-shadow": "0 0 8px rgba(255,215,0,0.8)",
            transform: "scale(1.1)",
            transition: "transform 0.1s",
          } : {}),
        }}>{gameStore.currency}g</div>
        {/* Achievements quick-stat */}
        <div style={{ "font-size": "10px", color: "rgba(255,215,0,0.5)" }}>
          Achievements: {gameStore.unlockedAchievements.length}/{gameStore.stats.totalDeaths >= 0 ? "35" : "35"} (F4)
        </div>
        {/* Save indicator */}
        <Show when={gameStore.lastSaveTime > 0}>
          <div style={{ "font-size": "9px", color: (() => {
            const ago = Math.floor((Date.now() - gameStore.lastSaveTime) / 1000);
            return ago < 3 ? "#4caf50" : "rgba(255,255,255,0.3)";
          })() }}>
            {(() => {
              const ago = Math.floor((Date.now() - gameStore.lastSaveTime) / 1000);
              if (ago < 3) return "Saving...";
              if (ago < 60) return `Saved ${ago}s ago`;
              if (ago < 3600) return `Saved ${Math.floor(ago / 60)}m ago`;
              return `Saved ${Math.floor(ago / 3600)}h ago`;
            })()}
          </div>
        </Show>
        {/* Status indicators */}
        <Show when={gameStore.noclip}>
          <div style={{ color: "#00e5ff", "font-weight": "bold" }}>NOCLIP — F3 to disable</div>
        </Show>
        <Show when={gameStore.buildMode}>
          <div style={{ color: "#ffd700", "font-weight": "bold" }}>BUILD MODE — 1/2/3/4 to select</div>
        </Show>
        <Show when={gameStore.headlampOn}>
          <div style={{ color: "#ffcc66", "font-size": "11px" }}>Headlamp ON (L)</div>
        </Show>
        <Show when={gameStore.bombCount > 0}>
          <div style={{ "font-size": "10px", color: "rgba(255,152,0,0.5)" }}>Bombs: {gameStore.bombCount} active</div>
        </Show>
        <Show when={gameStore.glowstickCount > 0}>
          <div style={{ "font-size": "10px", color: "rgba(255,255,255,0.4)" }}>Glowsticks: {gameStore.glowstickCount}/32</div>
        </Show>
        <Show when={gameStore.paused}>
          <div style={{ color: "#ff5252", "font-weight": "bold" }}>PAUSED</div>
        </Show>
      </div>
    </Show>
  );
}
