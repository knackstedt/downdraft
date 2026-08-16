// ============================================================================
// DeathMenu — overlay shown when the player's health reaches 0.
//
// Displays a "YOU DIED" message and a Respawn button. Respawn resets the
// player to the surface spawn point with full health, keeping upgrades and
// inventory. The simulation is paused while this menu is visible.
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
};

const titleStyle: React.CSSProperties = {
  fontSize: 32,
  fontWeight: "bold",
  color: "#d32f2f",
  letterSpacing: 4,
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: "rgba(255,255,255,0.5)",
  margin: 0,
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
  const { gameOver, renderer } = useGameStore();

  if (!gameOver) return null;

  const handleRespawn = () => {
    // The renderer is stored as unknown — cast to access respawn()
    const r = renderer as { respawn?: () => void } | null;
    r?.respawn?.();
  };

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <h1 style={titleStyle}>YOU DIED</h1>
        <p style={subtitleStyle}>Your health reached zero.</p>
        <button style={respawnButtonStyle} onClick={handleRespawn}>
          Respawn
        </button>
      </div>
    </div>
  );
}
