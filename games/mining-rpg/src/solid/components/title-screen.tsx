// ============================================================================
// TitleScreen — shown when the game first loads, before the world is initialized.
//
// Displays the game title, a subtitle, and a "Start Mining" button. When
// clicked, the title screen hides and the game begins. If a save exists,
// shows "Continue" instead. The title screen has a dark background with a
// subtle animated gradient to set the mood.
// ============================================================================

import { Show, createSignal } from "solid-js";
import { gameStore } from "../stores/game-store";
import type { JSX } from "solid-js";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  "justify-content": "center",
  background: "linear-gradient(135deg, #0a0a15 0%, #1a1a2e 50%, #0f0f1a 100%)",
  "z-index": "100",
  "pointer-events": "auto",
  "font-family": "monospace",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "48px",
  "font-weight": "bold",
  color: "#ffd700",
  "letter-spacing": "8px",
  margin: 0,
  "text-shadow": "0 0 20px rgba(255,215,0,0.5), 0 4px 8px rgba(0,0,0,0.8)",
};

const subtitleStyle: JSX.CSSProperties = {
  "font-size": "16px",
  color: "rgba(255,255,255,0.5)",
  "margin-top": "8px",
  "margin-bottom": "40px",
  "letter-spacing": "2px",
};

const buttonBase: JSX.CSSProperties = {
  padding: "14px 48px",
  "font-size": "18px",
  "font-family": "monospace",
  "border-radius": "6px",
  cursor: "pointer",
  border: "2px solid",
  "min-width": "240px",
  transition: "transform 0.1s, box-shadow 0.2s",
};

const startButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "linear-gradient(135deg, #2a4a2a, #3a6a3a)",
  "border-color": "#4a8a4a",
  "box-shadow": "0 4px 16px rgba(74,138,74,0.3)",
};

const featuresStyle: JSX.CSSProperties = {
  "margin-top": "40px",
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
  "font-size": "12px",
  color: "rgba(255,255,255,0.3)",
  "text-align": "center",
};

const featureItemStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  "justify-content": "center",
};

export function TitleScreen(props: { onStart: () => void; onNewGame?: () => void }) {
  const [hovering, setHovering] = createSignal(false);
  const [showConfirm, setShowConfirm] = createSignal(false);
  const hasSave = () => gameStore.welcomeBack !== null;

  const playTimeStr = () => {
    const secs = Math.floor(gameStore.stats.totalTicks / 60);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${secs}s`;
  };

  return (
    <div style={overlayStyle}>
      <h1 style={titleStyle}>MINING RPG</h1>
      <div style={subtitleStyle}>Dig deep. Get rich. Survive.</div>
      <button
        style={{
          ...startButtonStyle,
          transform: hovering() ? "scale(1.05)" : "scale(1)",
          "box-shadow": hovering()
            ? "0 6px 24px rgba(74,138,74,0.5)"
            : "0 4px 16px rgba(74,138,74,0.3)",
        }}
        onClick={props.onStart}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        ⛏️ Start Mining
      </button>
      <Show when={hasSave()}>
        <div style={{
          "margin-top": "16px",
          padding: "12px 24px",
          background: "rgba(255,215,0,0.05)",
          border: "1px solid rgba(255,215,0,0.2)",
          "border-radius": "6px",
          "font-size": "11px",
          color: "rgba(255,215,0,0.6)",
          "text-align": "center",
        }}>
          <div style={{ "font-weight": "bold", "margin-bottom": "4px" }}>Save Found</div>
          <div>Depth: {gameStore.stats.maxDepthCells}m | Gold: {gameStore.currency}g | Deaths: {gameStore.stats.totalDeaths}</div>
          <div style={{ "margin-top": "2px", "font-size": "10px", color: "rgba(255,255,255,0.4)" }}>
            Play time: {playTimeStr()}
          </div>
        </div>
      </Show>
      <Show when={hasSave() && props.onNewGame && !showConfirm()}>
        <button
          style={{
            "margin-top": "12px",
            padding: "6px 16px",
            "font-size": "11px",
            "font-family": "monospace",
            color: "rgba(255,100,100,0.6)",
            background: "transparent",
            border: "1px solid rgba(255,100,100,0.2)",
            "border-radius": "4px",
            cursor: "pointer",
          }}
          onClick={() => setShowConfirm(true)}
        >
          Delete Save & Start New
        </button>
      </Show>
      <Show when={showConfirm()}>
        <div style={{
          "margin-top": "12px",
          padding: "12px 20px",
          background: "rgba(255,0,0,0.1)",
          border: "1px solid rgba(255,100,100,0.4)",
          "border-radius": "6px",
          "text-align": "center",
        }}>
          <div style={{ "font-size": "12px", color: "rgba(255,100,100,0.8)", "margin-bottom": "8px" }}>
            Delete all progress? This cannot be undone.
          </div>
          <div style={{ display: "flex", gap: "8px", "justify-content": "center" }}>
            <button
              style={{
                padding: "4px 12px",
                "font-size": "11px",
                "font-family": "monospace",
                color: "#fff",
                background: "rgba(255,50,50,0.3)",
                border: "1px solid rgba(255,50,50,0.5)",
                "border-radius": "3px",
                cursor: "pointer",
              }}
              onClick={() => { props.onNewGame?.(); setShowConfirm(false); }}
            >
              Yes, Delete
            </button>
            <button
              style={{
                padding: "4px 12px",
                "font-size": "11px",
                "font-family": "monospace",
                color: "rgba(255,255,255,0.6)",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)",
                "border-radius": "3px",
                cursor: "pointer",
              }}
              onClick={() => setShowConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <div style={featuresStyle}>
        <div style={featureItemStyle}>⛏️ Mine 8 ore types across 8 depth biomes</div>
        <div style={featureItemStyle}>🔥 Smelt ore into bars at the surface furnace</div>
        <div style={featureItemStyle}>🏆 Unlock 35 achievements</div>
        <div style={featureItemStyle}>💎 Upgrade your pickaxe, radius, speed & inventory</div>
        <div style={featureItemStyle}>🗺️ Explore with minimap, stats, and depth tracking</div>
      </div>
      <div style={{ "margin-top": "30px", "font-size": "10px", color: "rgba(255,255,255,0.2)" }}>
        Press H in-game for full controls | WASD to move | Click to dig | ESC to pause
      </div>
      <div style={{ position: "absolute", bottom: "12px", "font-size": "9px", color: "rgba(255,255,255,0.15)" }}>
        v1.0.0
      </div>
    </div>
  );
}
