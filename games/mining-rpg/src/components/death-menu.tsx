// ============================================================================
// DeathMenu — overlay shown when the player's health reaches 0.
//
// Displays a "YOU DIED" message with a cause-of-death quip and a Respawn
// button. The quip is picked once per death event (in the renderer) and
// stored in the game store, so it doesn't rotate on re-renders.
// Respawn resets the player to the surface spawn point with full health,
// keeping upgrades and inventory. The simulation is paused while this
// menu is visible.
// ============================================================================

import { useGameStore } from "../stores/game-store";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.7)",
  zIndex: 20,
  pointerEvents: "auto",
};

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
  padding: "32px 48px",
  background: "rgba(20,10,10,0.95)",
  border: "1px solid #5a2020",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#e0c0c0",
  maxWidth: 480,
  pointerEvents: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 32,
  fontWeight: "bold",
  color: "#d32f2f",
  letterSpacing: 4,
  margin: 0,
};

const quipStyle: React.CSSProperties = {
  fontSize: 15,
  color: "rgba(255,255,255,0.7)",
  fontStyle: "italic",
  margin: 0,
  textAlign: "center" as const,
  lineHeight: 1.5,
};

const deathStatsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "rgba(255,255,255,0.5)",
  textAlign: "center" as const,
  padding: "8px 16px",
  borderTop: "1px solid rgba(255,255,255,0.1)",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const respawnButtonStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "10px 32px",
  fontSize: 16,
  fontFamily: "monospace",
  color: "#fff",
  background: "#b71c1c",
  border: "1px solid #d32f2f",
  borderRadius: 4,
  cursor: "pointer",
};

export function DeathMenu() {
  const { gameOver, deathQuip, renderer, stats, depth } = useGameStore();

  if (!gameOver) return null;

  const handleRespawn = () => {
    const r = renderer as { respawn?: () => void } | null;
    r?.respawn?.();
  };

  const depthMeters = depth * 128;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <h1 style={titleStyle}>YOU DIED</h1>
        <p style={quipStyle}>{deathQuip}</p>
        <div style={deathStatsStyle}>
          <div>Depth: {depthMeters}m</div>
          <div>Total Deaths: {stats.totalDeaths}</div>
          <div>Gold: {stats.totalGoldEarned - stats.totalGoldSpent}g net</div>
        </div>
        <button style={respawnButtonStyle} onClick={handleRespawn}>
          Respawn at Surface
        </button>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
          You keep your upgrades, gold, and inventory
        </div>
      </div>
    </div>
  );
}
