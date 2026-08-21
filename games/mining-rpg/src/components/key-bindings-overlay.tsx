// ============================================================================
// KeyBindingsOverlay — comprehensive help screen showing all controls.
//
// Toggled with the H key. Shows all keybindings grouped by category:
// movement, mining, building, items, UI panels, debug, and camera.
// ============================================================================

import { useEffect, useState } from "react";

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.7)",
  zIndex: 22,
  pointerEvents: "auto",
};

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "24px 36px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid #3a3a4a",
  borderRadius: 8,
  fontFamily: "monospace",
  color: "#d0d0e0",
  maxWidth: 600,
  maxHeight: "85vh",
  overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: "bold",
  color: "#a0a0c0",
  letterSpacing: 3,
  margin: 0,
  textAlign: "center",
  paddingBottom: 8,
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const categoryStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const categoryTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: "bold",
  color: "#ffd700",
  textTransform: "uppercase",
  letterSpacing: 1,
  marginBottom: 4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 13,
  padding: "2px 0",
};

const keyStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 3,
  fontSize: 12,
  fontWeight: "bold",
  color: "#fff",
  minWidth: 80,
  textAlign: "center",
};

const descStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.7)",
  textAlign: "right",
};

const closeHintStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid rgba(255,255,255,0.1)",
  fontSize: 11,
  color: "rgba(255,255,255,0.4)",
};

interface Binding {
  key: string;
  desc: string;
}

const CATEGORIES: { title: string; bindings: Binding[] }[] = [
  {
    title: "Movement",
    bindings: [
      { key: "W/A/S/D", desc: "Move (or arrow keys)" },
      { key: "Space", desc: "Jump" },
      { key: "F3", desc: "Toggle noclip (fly mode)" },
    ],
  },
  {
    title: "Mining & Combat",
    bindings: [
      { key: "Left-click", desc: "Dig / mine blocks" },
      { key: "Right-click", desc: "Throw bomb" },
      { key: "F", desc: "Place torch (raycast)" },
      { key: "G", desc: "Throw glowstick" },
    ],
  },
  {
    title: "Building",
    bindings: [
      { key: "B", desc: "Toggle build mode" },
      { key: "1/2/3/4", desc: "Select build material" },
      { key: "Left-click", desc: "Place block (in build mode)" },
    ],
  },
  {
    title: "Items & Economy",
    bindings: [
      { key: "I", desc: "Toggle inventory panel" },
      { key: "E", desc: "Sell all items (at signpost)" },
      { key: "T", desc: "Teleport to surface (costs gold)" },
    ],
  },
  {
    title: "UI Panels",
    bindings: [
      { key: "Tab", desc: "Toggle statistics panel" },
      { key: "F4", desc: "Toggle achievements panel" },
      { key: "M", desc: "Toggle minimap" },
      { key: "F11", desc: "Toggle HUD (for screenshots)" },
      { key: "H", desc: "Toggle this help screen" },
      { key: "ESC", desc: "Pause menu / settings" },
    ],
  },
  {
    title: "Camera & Lighting",
    bindings: [
      { key: "Mouse wheel", desc: "Zoom in/out" },
      { key: "L", desc: "Toggle headlamp" },
    ],
  },
  {
    title: "Debug",
    bindings: [
      { key: "F1", desc: "Toggle fog-of-war + shadows" },
      { key: "F2", desc: "Toggle chunk border overlay" },
    ],
  },
];

export function KeyBindingsOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") {
        // Don't toggle if typing in an input
        if (e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        setVisible((v) => !v);
      }
      // ESC closes the overlay
      if (e.key === "Escape" && visible) {
        setVisible(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible]);

  if (!visible) return null;

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <h1 style={titleStyle}>CONTROLS</h1>
        {CATEGORIES.map((cat) => (
          <div key={cat.title} style={categoryStyle}>
            <div style={categoryTitleStyle}>{cat.title}</div>
            {cat.bindings.map((b) => (
              <div key={b.key} style={rowStyle}>
                <span style={keyStyle}>{b.key}</span>
                <span style={descStyle}>{b.desc}</span>
              </div>
            ))}
          </div>
        ))}
        <div style={closeHintStyle}>Press H or ESC to close</div>
      </div>
    </div>
  );
}
