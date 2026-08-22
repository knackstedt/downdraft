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

import { Show } from "solid-js";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.7)",
  "z-index": "20",
  "pointer-events": "auto",
};

const panelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "16px",
  padding: "32px 48px",
  background: "rgba(20,10,10,0.95)",
  border: "1px solid #5a2020",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#e0c0c0",
  "max-width": "480px",
  "pointer-events": "auto",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "32px",
  "font-weight": "bold",
  color: "#d32f2f",
  "letter-spacing": "4px",
  margin: 0,
};

const quipStyle: JSX.CSSProperties = {
  "font-size": "15px",
  color: "rgba(255,255,255,0.7)",
  "font-style": "italic",
  margin: 0,
  "text-align": "center" as const,
  "line-height": "1.5",
};

const deathStatsStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
  "font-size": "13px",
  color: "rgba(255,255,255,0.5)",
  "text-align": "center" as const,
  padding: "8px 16px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "border-bottom": "1px solid rgba(255,255,255,0.1)",
};

const respawnButtonStyle: JSX.CSSProperties = {
  "margin-top": "8px",
  padding: "10px 32px",
  "font-size": "16px",
  "font-family": "monospace",
  color: "#fff",
  background: "#b71c1c",
  border: "1px solid #d32f2f",
  "border-radius": "4px",
  cursor: "pointer",
};

export function DeathMenu() {
  // Death cause icon
  const deathIcon = () => {
    const cause = gameStore.deathCause;
    if (cause === 1000) return "🪨"; // Suffocation
    if (cause === 1001) return "📉"; // Falling
    if (cause === 1002) return "🌊"; // Drowning
    if (cause === 255) return "🌋"; // Lava
    if (cause === 254) return "🔥"; // Fire
    if (cause === 253) return "☠️"; // Gas
    return "💀"; // Unknown
  };

  const depthMeters = () => gameStore.depth * 128;

  return (
    <Show when={gameStore.gameOver}>
      <div style={overlayStyle}>
        <div style={panelStyle}>
          <h1 style={titleStyle}>{deathIcon()} YOU DIED</h1>
          <p style={quipStyle}>{gameStore.deathQuip}</p>
          <div style={deathStatsStyle}>
            <div>Depth: {depthMeters()}m</div>
            <div>Total Deaths: {gameStore.stats.totalDeaths}</div>
            <div>Gold: {gameStore.stats.totalGoldEarned - gameStore.stats.totalGoldSpent}g net</div>
          </div>
          <button style={respawnButtonStyle} onClick={() => actions.respawn()}>
            Respawn at Surface
          </button>
          <div style={{ "font-size": "11px", color: "rgba(255,255,255,0.4)" }}>
            You keep your upgrades, gold, and inventory
          </div>
        </div>
      </div>
    </Show>
  );
}
