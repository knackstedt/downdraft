// ============================================================================
// KeyBindingsOverlay — comprehensive help screen showing all controls.
//
// Toggled with the H key. Shows all keybindings grouped by category:
// movement, mining, building, items, UI panels, debug, and camera.
// ============================================================================

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

const overlayStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.7)",
  "z-index": "22",
  "pointer-events": "auto",
};

const panelStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "16px",
  padding: "24px 36px",
  background: "rgba(15,15,20,0.95)",
  border: "1px solid #3a3a4a",
  "border-radius": "8px",
  "font-family": "monospace",
  color: "#d0d0e0",
  "max-width": "600px",
  "max-height": "85vh",
  "overflow-y": "auto",
};

const titleStyle: JSX.CSSProperties = {
  "font-size": "22px",
  "font-weight": "bold",
  color: "#a0a0c0",
  "letter-spacing": "3px",
  margin: 0,
  "text-align": "center",
  "padding-bottom": "8px",
  "border-bottom": "1px solid rgba(255,255,255,0.1)",
};

const categoryStyle: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  gap: "4px",
};

const categoryTitleStyle: JSX.CSSProperties = {
  "font-size": "13px",
  "font-weight": "bold",
  color: "#ffd700",
  "text-transform": "uppercase",
  "letter-spacing": "1px",
  "margin-bottom": "4px",
};

const rowStyle: JSX.CSSProperties = {
  display: "flex",
  "justify-content": "space-between",
  "align-items": "center",
  "font-size": "13px",
  padding: "2px 0",
};

const keyStyle: JSX.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.2)",
  "border-radius": "3px",
  "font-size": "12px",
  "font-weight": "bold",
  color: "#fff",
  "min-width": "80px",
  "text-align": "center",
};

const descStyle: JSX.CSSProperties = {
  color: "rgba(255,255,255,0.7)",
  "text-align": "right",
};

const closeHintStyle: JSX.CSSProperties = {
  "text-align": "center",
  "margin-top": "8px",
  "padding-top": "8px",
  "border-top": "1px solid rgba(255,255,255,0.1)",
  "font-size": "11px",
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
      { key: "F5", desc: "Toggle FPS counter" },
      { key: "F6", desc: "Save game now" },
      { key: "H", desc: "Toggle this help screen" },
      { key: "ESC", desc: "Pause menu / settings" },
    ],
  },
  {
    title: "Camera & Lighting",
    bindings: [
      { key: "Mouse wheel", desc: "Zoom in/out" },
      { key: "R", desc: "Reset zoom to 1x" },
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
  const [visible, setVisible] = createSignal(false);

  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") {
        // Don't toggle if typing in an input
        if (e.target instanceof HTMLInputElement) return;
        e.preventDefault();
        setVisible((v) => !v);
      }
      // ESC closes the overlay
      if (e.key === "Escape" && visible()) {
        setVisible(false);
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <Show when={visible()}>
      <div style={overlayStyle}>
        <div style={panelStyle}>
          <h1 style={titleStyle}>CONTROLS</h1>
          <For each={CATEGORIES}>
            {(cat) => (
              <div style={categoryStyle}>
                <div style={categoryTitleStyle}>{cat.title}</div>
                <For each={cat.bindings}>
                  {(b) => (
                    <div style={rowStyle}>
                      <span style={keyStyle}>{b.key}</span>
                      <span style={descStyle}>{b.desc}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
          <div style={closeHintStyle}>Press H or ESC to close</div>
        </div>
      </div>
    </Show>
  );
}
