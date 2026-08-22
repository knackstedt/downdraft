import { useEffect } from "react";
import { useGameStore } from "./stores/game-store";

const titleStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
  color: "white",
  fontFamily: "monospace",
  zIndex: 50,
  pointerEvents: "auto", // re-enable clicks on title screen (overlay has pointer-events: none)
};

const titleTextStyle: React.CSSProperties = {
  fontSize: 48,
  fontWeight: "bold",
  marginBottom: 8,
  textShadow: "0 2px 8px rgba(0,0,0,0.5)",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: "rgba(255,255,255,0.6)",
  marginBottom: 32,
};

const startButtonStyle: React.CSSProperties = {
  padding: "12px 48px",
  fontSize: 18,
  fontFamily: "monospace",
  background: "rgba(79,195,247,0.2)",
  color: "white",
  border: "2px solid rgba(79,195,247,0.5)",
  borderRadius: 8,
  cursor: "pointer",
  transition: "background 0.2s",
};

const helpStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  color: "rgba(255,255,255,0.4)",
  fontSize: 12,
  fontFamily: "monospace",
};

// --- HUD styles ---
const hudContainerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  fontFamily: "monospace",
  zIndex: 10,
};

const fpsStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  color: "rgba(255,255,255,0.7)",
  fontSize: 12,
  padding: "4px 8px",
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
};

const barsContainerStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 8,
  background: "rgba(0,0,0,0.5)",
  borderRadius: 4,
};

const barRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const barLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.6)",
  width: 32,
  textAlign: "right" as const,
};

const barBgStyle: React.CSSProperties = {
  width: 100,
  height: 8,
  background: "rgba(255,255,255,0.1)",
  borderRadius: 4,
  overflow: "hidden",
};

const hotbarContainerStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 16,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  gap: 4,
  padding: 4,
  background: "rgba(0,0,0,0.6)",
  borderRadius: 6,
};

const hotbarSlotStyle = (selected: boolean): React.CSSProperties => ({
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  color: "rgba(255,255,255,0.5)",
  background: selected ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.05)",
  border: selected ? "2px solid rgba(79,195,247,0.8)" : "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
});

// Hotbar block colors (matching the block registry colors)
const HOTBAR_COLORS: [number, number, number][] = [
  [120, 80, 50],   // dirt
  [80, 160, 60],   // grass
  [128, 128, 128], // stone
  [140, 100, 60],  // wood
  [0, 0, 0],       // empty
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

const HOTBAR_NAMES = ["Dirt", "Grass", "Stone", "Wood", "", "", "", "", ""];

function AttributeBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={barRowStyle}>
      <span style={barLabelStyle}>{label}</span>
      <div style={barBgStyle}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}

function Hud() {
  const { fps, paused, blockhead, selectedSlot } = useGameStore();

  return (
    <div style={hudContainerStyle}>
      <div style={fpsStyle}>
        FPS: {fps}
        {paused && <span style={{ color: "yellow", marginLeft: 8 }}>PAUSED</span>}
      </div>

      {/* Attribute bars */}
      <div style={barsContainerStyle}>
        <AttributeBar label="HP" value={blockhead.health} color="#e74c3c" />
        <AttributeBar label="Food" value={blockhead.hunger} color="#e67e22" />
        <AttributeBar label="Energy" value={blockhead.energy} color="#f1c40f" />
        <AttributeBar label="Air" value={blockhead.air} color="#3498db" />
        <AttributeBar label="Happy" value={blockhead.happiness} color="#2ecc71" />
        <AttributeBar label="Env" value={blockhead.environment} color="#9b59b6" />
      </div>

      {/* Hotbar */}
      <div style={hotbarContainerStyle}>
        {HOTBAR_COLORS.map((color, i) => (
          <div key={i} style={hotbarSlotStyle(selectedSlot === i)}>
            {color[0] !== 0 || color[1] !== 0 || color[2] !== 0 ? (
              <div style={{
                width: 28,
                height: 28,
                background: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                borderRadius: 2,
              }} />
            ) : (
              <span>{i + 1}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const { showTitleScreen, setShowTitleScreen } = useGameStore();

  // Poll blockhead state from SAB and update the store
  useEffect(() => {
    if (showTitleScreen) return;
    const { renderer } = useGameStore.getState();
    if (!renderer) return;

    const interval = setInterval(() => {
      const reader = renderer.getSimReader();
      if (!reader) return;
      const count = reader.getBlockheadCount();
      if (count > 0) {
        const bh = reader.getBlockhead(0);
        useGameStore.getState().setBlockhead({
          health: bh[7],
          hunger: bh[8],
          energy: bh[9],
          air: bh[10],
          happiness: bh[11],
          environment: bh[12],
        });
      }
      // Sync selected slot from input
      const input = renderer.getInput();
      if (input) {
        useGameStore.getState().setSelectedSlot(input.selectedSlot);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [showTitleScreen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const s = useGameStore.getState();
        if (s.showTitleScreen) return;
        s.setPaused(!s.paused);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (showTitleScreen) {
    return (
      <div style={titleStyle}>
        <div style={titleTextStyle}>Overburden</div>
        <div style={subtitleStyle}>A 2.5D sandbox survival port — powered by downdraft</div>
        <button
          style={startButtonStyle}
          onClick={() => setShowTitleScreen(false)}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(79,195,247,0.35)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "rgba(79,195,247,0.2)";
          }}
        >
          Start Game
        </button>
        <div style={helpStyle}>
          WASD/Arrows: move | Space: jump | Left-click: mine | Right-click: place | Wheel: zoom | 1-9: hotbar | ESC: pause
        </div>
      </div>
    );
  }

  return <Hud />;
}
