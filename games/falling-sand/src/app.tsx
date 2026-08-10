import { useEffect, useState } from "react";
import { useGameStore } from "./stores/game-store";

const materialNames = [
  "Empty",
  "Sand",
  "Water",
  "Stone",
  "Wood",
  "Fire",
  "Smoke",
  "Oil",
  "Gunpowder",
  "Iron",
  "Lava",
  "Steam",
  "Plant",
  "Flesh",
];

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "rgba(255,255,255,0.8)",
  fontFamily: "monospace",
  fontSize: 12,
  pointerEvents: "auto",
  padding: 8,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
};

const selectStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.8)",
  color: "white",
  fontSize: 12,
  padding: 4,
  marginTop: 4,
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.2)",
};

const helpStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  left: 8,
  color: "rgba(255,255,255,0.6)",
  fontFamily: "monospace",
  fontSize: 12,
  padding: 8,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
};

const settingsPanelStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  color: "rgba(255,255,255,0.8)",
  fontFamily: "monospace",
  fontSize: 12,
  pointerEvents: "auto",
  padding: 12,
  background: "rgba(0,0,0,0.7)",
  borderRadius: 4,
  minWidth: 240,
};

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  color: "white",
  fontSize: 12,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.2)",
  cursor: "pointer",
  marginTop: 4,
};

const sliderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 8,
};

const sliderStyle: React.CSSProperties = {
  flex: 1,
  accentColor: "#4fc3f7",
};

export default function App() {
  const { fps, selectedMaterial, health, paused, settings, showSettings } = useGameStore();
  const setSettings = useGameStore((s) => s.setSettings);
  const setShowSettings = useGameStore((s) => s.setShowSettings);
  const [selected, setSelected] = useState(selectedMaterial);

  useEffect(() => {
    useGameStore.getState().setSelectedMaterial(selected);
  }, [selected]);

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div>FPS: {fps ?? 0}</div>
        <div>Health: {health}</div>
        <div>Material: {materialNames[selected] ?? "Unknown"}</div>
        <select
          style={selectStyle}
          value={selected}
          onChange={(e) => setSelected(parseInt(e.target.value, 10))}
        >
          {materialNames.map((name, i) => (
            <option key={name} value={i}>
              {i}: {name}
            </option>
          ))}
        </select>
        {paused && <div style={{ color: "yellow" }}>PAUSED</div>}
        <button style={btnStyle} onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? "Close Settings" : "Settings"}
        </button>
      </div>

      {showSettings && (
        <div style={settingsPanelStyle}>
          <div style={{ fontWeight: "bold", marginBottom: 8 }}>Physics Settings</div>

          <div>Horizontal Impulse</div>
          <div style={sliderRowStyle}>
            <span style={{ width: 50 }}>Chance</span>
            <input
              type="range"
              min={0}
              max={0.2}
              step={0.005}
              value={settings.horizontalImpulseChance}
              style={sliderStyle}
              onChange={(e) => setSettings({ horizontalImpulseChance: parseFloat(e.target.value) })}
            />
            <span style={{ width: 40, textAlign: "right" }}>
              {(settings.horizontalImpulseChance * 100).toFixed(1)}%
            </span>
          </div>

          <div style={sliderRowStyle}>
            <span style={{ width: 50 }}>Force</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.5}
              value={settings.horizontalImpulseStrength}
              style={sliderStyle}
              onChange={(e) => setSettings({ horizontalImpulseStrength: parseFloat(e.target.value) })}
            />
            <span style={{ width: 40, textAlign: "right" }}>
              {settings.horizontalImpulseStrength.toFixed(1)}
            </span>
          </div>

          <div style={{ marginTop: 8, color: "rgba(255,255,255,0.5)", fontSize: 11 }}>
            Rare horizontal nudges prevent particles from falling in straight columns.
            Chance = probability per tick, Force = cells per nudge.
          </div>
        </div>
      )}

      <div style={helpStyle}>
        WASD / Space • Left-click paint • Right-click ignite • E magnet
      </div>
    </div>
  );
}
