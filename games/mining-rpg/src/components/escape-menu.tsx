// ============================================================================
// EscapeMenu — pause menu shown when the player presses ESC.
//
// Displays Resume and Reset World buttons. Reset World stops the simulation,
// deletes the save, and regenerates the world from seed (new ore veins,
// terrain, etc.). The simulation is paused while this menu is visible.
// ============================================================================

import { useState } from "react";
import { useGameStore } from "../stores/game-store";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.6)",
  zIndex: 25,
  pointerEvents: "auto",
};

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
  padding: "32px 48px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid #3a3a4a",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#d0d0e0",
  maxWidth: 420,
  pointerEvents: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: "bold",
  color: "#a0a0c0",
  letterSpacing: 3,
  margin: 0,
};

const buttonBase: React.CSSProperties = {
  padding: "10px 32px",
  fontSize: 15,
  fontFamily: "monospace",
  borderRadius: 4,
  cursor: "pointer",
  border: "1px solid",
  minWidth: 200,
};

const resumeButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#2a4a2a",
  borderColor: "#3a6a3a",
};

const resetButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#4a2a2a",
  borderColor: "#6a3a3a",
};

const confirmButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#6a1c1c",
  borderColor: "#8a2a2a",
};

const cancelButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#d0d0e0",
  background: "#2a2a3a",
  borderColor: "#3a3a4a",
};

const warningStyle: React.CSSProperties = {
  fontSize: 13,
  color: "rgba(255,200,200,0.8)",
  textAlign: "center" as const,
  margin: 0,
  lineHeight: 1.5,
};

export function EscapeMenu() {
  const { showEscapeMenu, renderer } = useGameStore();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  if (!showEscapeMenu) return null;

  const handleResume = () => {
    const s = useGameStore.getState();
    s.setShowEscapeMenu(false);
    (renderer as { resume?: () => void } | null)?.resume?.();
  };

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    const r = renderer as { resetWorld?: () => Promise<void> } | null;
    await r?.resetWorld?.();
    setResetting(false);
    setConfirming(false);
    useGameStore.getState().setShowEscapeMenu(false);
  };

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <h1 style={titleStyle}>PAUSED</h1>
        {!confirming ? (
          <>
            <button style={resumeButtonStyle} onClick={handleResume}>
              Resume
            </button>
            <button style={resetButtonStyle} onClick={() => setConfirming(true)}>
              Reset World
            </button>
          </>
        ) : (
          <>
            <p style={warningStyle}>
              Regenerate the world from scratch?<br />
              All progress, inventory, and upgrades will be lost.<br />
              This cannot be undone.
            </p>
            <button style={confirmButtonStyle} onClick={handleReset} disabled={resetting}>
              {resetting ? "Resetting..." : "Confirm Reset"}
            </button>
            <button style={cancelButtonStyle} onClick={() => setConfirming(false)} disabled={resetting}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
