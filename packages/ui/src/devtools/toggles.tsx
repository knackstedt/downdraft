import React, { useState } from "react";

export interface DebugToggleState {
  wireframe: boolean;
  hitboxes: boolean;
  normals: boolean;
  velocity: boolean;
  shadows: boolean;
  bloom: boolean;
}

const DEFAULT_TOGGLES: DebugToggleState = {
  wireframe: false,
  hitboxes: false,
  normals: false,
  velocity: false,
  shadows: true,
  bloom: true,
};

export const DebugToggles: React.FC<{
  toggles: DebugToggleState;
  onChange: (toggles: DebugToggleState) => void;
}> = ({ toggles, onChange }) => {
  const handleChange = (key: keyof DebugToggleState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...toggles, [key]: e.target.checked });
  };

  const items: Array<{ key: keyof DebugToggleState; label: string }> = [
    { key: "wireframe", label: "Wireframe" },
    { key: "hitboxes", label: "Hitboxes" },
    { key: "normals", label: "Normals" },
    { key: "velocity", label: "Velocity" },
    { key: "shadows", label: "Shadows" },
    { key: "bloom", label: "Bloom" },
  ];

  return (
    <div>
      <div style={{ fontWeight: "bold", marginBottom: 4, color: "#fff" }}>Debug Toggles</div>
      {items.map((item) => (
        <label key={item.key} style={{ display: "block", marginBottom: 2, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={toggles[item.key]}
            onChange={handleChange(item.key)}
            style={{ marginRight: 6 }}
          />
          {item.label}
        </label>
      ))}
    </div>
  );
};

export { DEFAULT_TOGGLES };
