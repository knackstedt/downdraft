// ============================================================================
// EscapeMenu — pause menu shown when the player presses ESC.
//
// Displays Resume and Reset World buttons. Reset World stops the simulation,
// deletes the save, and regenerates the world from seed (new ore veins,
// terrain, etc.). The simulation is paused while this menu is visible.
// ============================================================================

import { Material } from "@downdraft/library-sand";
import { For, Show, createSignal } from "solid-js";
import { ACHIEVEMENTS } from "../../shared/achievements";
import { gameStore, actions } from "../stores/game-store";
import type { JSX } from "solid-js";

// Material ID → display name
const MATERIAL_INFO: Record<number, { name: string }> = {
  [Material.TinOre]: { name: "Tin Ore" },
  [Material.CopperOre]: { name: "Copper Ore" },
  [Material.IronOre]: { name: "Iron Ore" },
  [Material.BauxiteOre]: { name: "Bauxite Ore" },
  [Material.SilverOre]: { name: "Silver Ore" },
  [Material.GoldOre]: { name: "Gold Ore" },
  [Material.CobaltOre]: { name: "Cobalt Ore" },
  [Material.Coal]: { name: "Coal" },
};

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.6)",
  "z-index": "25",
  "pointer-events": "auto",
};

const panelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "16px",
  padding: "32px 48px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid #3a3a4a",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#d0d0e0",
  "max-width": "420px",
  "pointer-events": "auto",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "24px",
  "font-weight": "bold",
  color: "#a0a0c0",
  "letter-spacing": "3px",
  margin: 0,
};

const buttonBase: JSX.CSSProperties = {
  padding: "10px 32px",
  "font-size": "15px",
  "font-family": "monospace",
  "border-radius": "4px",
  cursor: "pointer",
  border: "1px solid",
  "min-width": "200px",
};

const resumeButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#2a4a2a",
  "border-color": "#3a6a3a",
};

const resetButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#4a2a2a",
  "border-color": "#6a3a3a",
};

const confirmButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#6a1c1c",
  "border-color": "#8a2a2a",
};

const cancelButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#d0d0e0",
  background: "#2a2a3a",
  "border-color": "#3a3a4a",
};

const warningStyle: JSX.CSSProperties = {
  "font-size": "13px",
  color: "rgba(255,200,200,0.8)",
  "text-align": "center" as const,
  margin: 0,
  "line-height": "1.5",
};

const saveButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#fff",
  background: "#2a3a4a",
  "border-color": "#3a5a6a",
};

const achievementsButtonStyle: JSX.CSSProperties = {
  ...buttonBase,
  color: "#ffd700",
  background: "#3a3a1a",
  "border-color": "#5a5a2a",
};

const saveStatusStyle: JSX.CSSProperties = {
  "font-size": "12px",
  color: "#8bc34a",
  "text-align": "center" as const,
};

const summaryStyle: JSX.CSSProperties = {
  "margin-top": "8px",
  "padding-top": "12px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "12px",
  color: "rgba(255,255,255,0.6)",
  display: "flex",
  "flex-direction": "column",
  gap: "3px",
  "text-align": "center" as const,
};

const summaryTitleStyle: JSX.CSSProperties = {
  "font-size": "11px",
  "font-weight": "bold",
  color: "rgba(255,255,255,0.4)",
  "text-transform": "uppercase" as const,
  "letter-spacing": "1px",
  "margin-bottom": "4px",
};

const settingsStyle: JSX.CSSProperties = {
  "margin-top": "4px",
  "padding-top": "12px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "12px",
  color: "rgba(255,255,255,0.6)",
  display: "flex",
  "flex-direction": "column",
  gap: "6px",
};

const toggleRowStyle: JSX.CSSProperties = {
  display: "flex",
  "justify-content": "space-between",
  "align-items": "center",
  cursor: "pointer",
};

const checkboxStyle: JSX.CSSProperties = {
  cursor: "pointer",
  width: "16px",
  height: "16px",
};

export function EscapeMenu() {
  const [confirming, setConfirming] = createSignal(false);
  const [resetting, setResetting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);

  const handleResume = () => {
    actions.setShowEscapeMenu(false);
    actions.resume();
  };

  const handleSaveNow = async () => {
    if (saving()) return;
    setSaving(true);
    setSaveStatus("Saving...");
    try {
      actions.save();
      setSaveStatus("Saved!");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch {
      setSaveStatus("Save failed!");
      setTimeout(() => setSaveStatus(null), 3000);
    }
    setSaving(false);
  };

  const handleReset = async () => {
    if (resetting()) return;
    setResetting(true);
    // Forward reset to main thread via deleteSave + startGame
    actions.deleteSave();
    setResetting(false);
    setConfirming(false);
    actions.setShowEscapeMenu(false);
  };

  // Format play time from ticks (60tps)
  const playTime = () => {
    const totalSeconds = Math.floor(gameStore.stats.totalTicks / 60);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const deathCauses = () => Object.entries(gameStore.stats.deathsByCause);
  const collectedMats = () =>
    Object.entries(gameStore.stats.collectedByMaterial)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 8);

  return (
    <Show when={gameStore.showEscapeMenu}>
      <div style={overlayStyle}>
        <div style={panelStyle}>
          <h1 style={titleStyle}>PAUSED</h1>
          <Show
            when={!confirming()}
            fallback={
              <>
                <p style={warningStyle}>
                  Regenerate the world from scratch?<br />
                  All progress, inventory, and upgrades will be lost.<br />
                  This cannot be undone.
                </p>
                <button style={confirmButtonStyle} onClick={handleReset} disabled={resetting()}>
                  {resetting() ? "Resetting..." : "Confirm Reset"}
                </button>
                <button style={cancelButtonStyle} onClick={() => setConfirming(false)} disabled={resetting()}>
                  Cancel
                </button>
              </>
            }
          >
            <button style={resumeButtonStyle} onClick={handleResume}>
              Resume
            </button>
            <button style={saveButtonStyle} onClick={handleSaveNow} disabled={saving()}>
              {saving() ? "Saving..." : "Save Now"}
            </button>
            <Show when={saveStatus()}>
              <div style={saveStatusStyle}>{saveStatus()}</div>
            </Show>
            <button style={achievementsButtonStyle} onClick={() => actions.toggleAchievements()}>
              Achievements ({gameStore.unlockedAchievements.length}/{ACHIEVEMENTS.length})
            </button>
            <button style={resetButtonStyle} onClick={() => setConfirming(true)}>
              Reset World
            </button>
            <div style={summaryStyle}>
              <div style={summaryTitleStyle}>Progress Summary</div>
              <div>Play Time: {playTime()}</div>
              <div>Deepest Depth: {gameStore.stats.maxDepthCells}m</div>
              <div>Gold: {gameStore.currency}</div>
              <div>Deaths: {gameStore.stats.totalDeaths}</div>
              <div>Blocks Mined: {gameStore.stats.totalCellsMined}</div>
              <div>Bars Crafted: {gameStore.stats.totalBarsCrafted}</div>
              <div>Bombs Thrown: {gameStore.stats.totalBombsThrown}</div>
              <div>Glowsticks: {gameStore.stats.totalGlowsticksThrown}</div>
              <div>Blocks Built: {gameStore.stats.totalBlocksPlaced}</div>
              <div>Teleports: {gameStore.stats.totalTeleports}</div>
              <div>Achievements: {gameStore.unlockedAchievements.length}/35</div>
              <Show when={deathCauses().length > 0}>
                <div style={summaryTitleStyle}>Death Causes</div>
                <For each={deathCauses()}>
                  {([cause, count]) => {
                    const causeNum = Number(cause);
                    let label: string;
                    if (causeNum === 1000) label = "Suffocation";
                    else if (causeNum === 1001) label = "Falling";
                    else if (causeNum === 1002) label = "Drowning";
                    else if (causeNum === 255) label = "Lava";
                    else if (causeNum === 254) label = "Fire";
                    else if (causeNum === 253) label = "Gas";
                    else if (causeNum === 255) label = "Enemy";
                    else label = `Cause #${cause}`;
                    return <div>{label}: {count}</div>;
                  }}
                </For>
              </Show>
              <Show when={collectedMats().length > 0}>
                <div style={summaryTitleStyle}>Materials Collected</div>
                <For each={collectedMats()}>
                  {([mat, count]) => {
                    const matNum = Number(mat);
                    const info = (MATERIAL_INFO as Record<number, { name: string }>)[matNum];
                    return <div>{info?.name ?? `Material #${mat}`}: {count}</div>;
                  }}
                </For>
              </Show>
            </div>
            <div style={settingsStyle}>
              <div style={summaryTitleStyle}>Settings</div>
              <label style={toggleRowStyle}>
                <span>Headlamp (L)</span>
                <input
                  type="checkbox"
                  checked={gameStore.headlampOn}
                  onChange={() => actions.toggleHeadlamp()}
                  style={checkboxStyle}
                />
              </label>
              <label style={toggleRowStyle}>
                <span>Noclip / Fly (F3)</span>
                <input
                  type="checkbox"
                  checked={gameStore.noclip}
                  onChange={() => actions.toggleNoclip()}
                  style={checkboxStyle}
                />
              </label>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
