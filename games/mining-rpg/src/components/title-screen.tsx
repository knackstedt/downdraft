// ============================================================================
// TitleScreen — shown when the game first loads, before the world is initialized.
//
// Displays the game title, a subtitle, and a "Start Mining" button. When
// clicked, the title screen hides and the game begins. If a save exists,
// shows "Continue" instead. The title screen has a dark background with a
// subtle animated gradient to set the mood.
// ============================================================================

import { useState } from "react";
import { useGameStore } from "../stores/game-store";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(135deg, #0a0a15 0%, #1a1a2e 50%, #0f0f1a 100%)",
  zIndex: 100,
  pointerEvents: "auto",
  fontFamily: "monospace",
};

const titleStyle: React.CSSProperties = {
  fontSize: 48,
  fontWeight: "bold",
  color: "#ffd700",
  letterSpacing: 8,
  margin: 0,
  textShadow: "0 0 20px rgba(255,215,0,0.5), 0 4px 8px rgba(0,0,0,0.8)",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 16,
  color: "rgba(255,255,255,0.5)",
  marginTop: 8,
  marginBottom: 40,
  letterSpacing: 2,
};

const buttonBase: React.CSSProperties = {
  padding: "14px 48px",
  fontSize: 18,
  fontFamily: "monospace",
  borderRadius: 6,
  cursor: "pointer",
  border: "2px solid",
  minWidth: 240,
  transition: "transform 0.1s, box-shadow 0.2s",
};

const startButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "linear-gradient(135deg, #2a4a2a, #3a6a3a)",
  borderColor: "#4a8a4a",
  boxShadow: "0 4px 16px rgba(74,138,74,0.3)",
};

const featuresStyle: React.CSSProperties = {
  marginTop: 40,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12,
  color: "rgba(255,255,255,0.3)",
  textAlign: "center",
};

const featureItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  justifyContent: "center",
};

export function TitleScreen({ onStart }: { onStart: () => void }) {
  const [hovering, setHovering] = useState(false);
  const { stats, currency, welcomeBack } = useGameStore();
  const hasSave = welcomeBack !== null;

  return (
    <div style={overlayStyle}>
      <h1 style={titleStyle}>MINING RPG</h1>
      <div style={subtitleStyle}>Dig deep. Get rich. Survive.</div>
      <button
        style={{
          ...startButtonStyle,
          transform: hovering ? "scale(1.05)" : "scale(1)",
          boxShadow: hovering
            ? "0 6px 24px rgba(74,138,74,0.5)"
            : "0 4px 16px rgba(74,138,74,0.3)",
        }}
        onClick={onStart}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        ⛏️ Start Mining
      </button>
      {hasSave && (
        <div style={{
          marginTop: 16,
          padding: "12px 24px",
          background: "rgba(255,215,0,0.05)",
          border: "1px solid rgba(255,215,0,0.2)",
          borderRadius: 6,
          fontSize: 11,
          color: "rgba(255,215,0,0.6)",
          textAlign: "center",
        }}>
          <div style={{ fontWeight: "bold", marginBottom: 4 }}>Save Found</div>
          <div>Depth: {stats.maxDepthCells}m | Gold: {currency}g | Deaths: {stats.totalDeaths}</div>
          <div style={{ marginTop: 2, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            Play time: {(() => {
              const secs = Math.floor(stats.totalTicks / 60);
              const h = Math.floor(secs / 3600);
              const m = Math.floor((secs % 3600) / 60);
              return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${secs}s`;
            })()}
          </div>
        </div>
      )}
      <div style={featuresStyle}>
        <div style={featureItemStyle}>⛏️ Mine 8 ore types across 8 depth biomes</div>
        <div style={featureItemStyle}>🔥 Smelt ore into bars at the surface furnace</div>
        <div style={featureItemStyle}>🏆 Unlock 35 achievements</div>
        <div style={featureItemStyle}>💎 Upgrade your pickaxe, radius, speed & inventory</div>
        <div style={featureItemStyle}>🗺️ Explore with minimap, stats, and depth tracking</div>
      </div>
      <div style={{ marginTop: 30, fontSize: 10, color: "rgba(255,255,255,0.2)" }}>
        Press H in-game for full controls | WASD to move | Click to dig | ESC to pause
      </div>
      <div style={{ position: "absolute", bottom: 12, fontSize: 9, color: "rgba(255,255,255,0.15)" }}>
        v1.0.0
      </div>
    </div>
  );
}
