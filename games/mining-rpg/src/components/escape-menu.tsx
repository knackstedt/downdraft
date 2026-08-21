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

const saveButtonStyle: React.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#2a3a4a",
  borderColor: "#3a5a6a",
};

const saveStatusStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#8bc34a",
  textAlign: "center" as const,
};

const summaryStyle: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 12,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  textAlign: "center" as const,
};

const summaryTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: "bold",
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase" as const,
  letterSpacing: 1,
  marginBottom: 4,
};

const settingsStyle: React.CSSProperties = {
  marginTop: 4,
  paddingTop: 12,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 12,
  color: "rgba(255,255,255,0.6)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  cursor: "pointer",
};

const checkboxStyle: React.CSSProperties = {
  cursor: "pointer",
  width: 16,
  height: 16,
};

export function EscapeMenu() {
  const { showEscapeMenu, renderer, stats, currency, unlockedAchievements, headlampOn, noclip, toggleHeadlamp, toggleNoclip } = useGameStore();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  if (!showEscapeMenu) return null;

  const handleResume = () => {
    const s = useGameStore.getState();
    s.setShowEscapeMenu(false);
    (renderer as { resume?: () => void } | null)?.resume?.();
  };

  const handleSaveNow = async () => {
    if (saving) return;
    setSaving(true);
    setSaveStatus("Saving...");
    try {
      const r = renderer as { saveNow?: () => Promise<void> } | null;
      await r?.saveNow?.();
      setSaveStatus("Saved!");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch {
      setSaveStatus("Save failed!");
      setTimeout(() => setSaveStatus(null), 3000);
    }
    setSaving(false);
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

  // Format play time from ticks (60tps)
  const totalSeconds = Math.floor(stats.totalTicks / 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const playTime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <h1 style={titleStyle}>PAUSED</h1>
        {!confirming ? (
          <>
            <button style={resumeButtonStyle} onClick={handleResume}>
              Resume
            </button>
            <button style={saveButtonStyle} onClick={handleSaveNow} disabled={saving}>
              {saving ? "Saving..." : "Save Now"}
            </button>
            {saveStatus && <div style={saveStatusStyle}>{saveStatus}</div>}
            <button style={resetButtonStyle} onClick={() => setConfirming(true)}>
              Reset World
            </button>
            <div style={summaryStyle}>
              <div style={summaryTitleStyle}>Progress Summary</div>
              <div>Play Time: {playTime}</div>
              <div>Deepest Depth: {stats.maxDepthCells}m</div>
              <div>Gold: {currency}</div>
              <div>Deaths: {stats.totalDeaths}</div>
              <div>Blocks Mined: {stats.totalCellsMined}</div>
              <div>Bars Crafted: {stats.totalBarsCrafted}</div>
              <div>Bombs Thrown: {stats.totalBombsThrown}</div>
              <div>Glowsticks: {stats.totalGlowsticksThrown}</div>
              <div>Blocks Built: {stats.totalBlocksPlaced}</div>
              <div>Teleports: {stats.totalTeleports}</div>
              <div>Achievements: {unlockedAchievements.size}/35</div>
            </div>
            <div style={settingsStyle}>
              <div style={summaryTitleStyle}>Settings</div>
              <label style={toggleRowStyle}>
                <span>Headlamp (L)</span>
                <input
                  type="checkbox"
                  checked={headlampOn}
                  onChange={() => toggleHeadlamp()}
                  style={checkboxStyle}
                />
              </label>
              <label style={toggleRowStyle}>
                <span>Noclip / Fly (F3)</span>
                <input
                  type="checkbox"
                  checked={noclip}
                  onChange={() => toggleNoclip()}
                  style={checkboxStyle}
                />
              </label>
            </div>
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
