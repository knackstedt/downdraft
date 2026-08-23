import { useEffect, useState } from "react";
import { ChunkDebugOverlay } from "./components/chunk-debug-overlay";
import { getAllItems, getItemDef, type ItemCategory } from "./shared/items";
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
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  color: "rgba(255,255,255,0.5)",
  background: selected ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.05)",
  border: selected ? "2px solid rgba(79,195,247,0.8)" : "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
});

// Hotbar slot definitions: item ID + display color.
// Must match HOTBAR_BLOCKS in blockheads-renderer.ts.
const HOTBAR_SLOTS: { itemId: string; color: [number, number, number] }[] = [
  { itemId: "dirt", color: [120, 80, 50] },
  { itemId: "grass", color: [80, 160, 60] },
  { itemId: "stone", color: [128, 128, 128] },
  { itemId: "wood", color: [140, 100, 60] },
  { itemId: "sand", color: [220, 200, 140] },
  { itemId: "torch", color: [240, 200, 80] },
  { itemId: "ladder", color: [180, 140, 80] },
  { itemId: "rope", color: [200, 180, 120] },
  { itemId: "scaffolding", color: [160, 130, 90] },
];

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
  const { fps, paused, blockhead, selectedSlot, inventory, showCraftPanel, showInventoryPanel, recipes } = useGameStore();
  const [debugNoShadows, setDebugNoShadows] = useState(false);

  // F1 toggles shadow/fog disable (debug). F2 is handled by ChunkDebugOverlay.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        const { renderer } = useGameStore.getState();
        if (!renderer) return;
        const next = !renderer.getDebugNoShadows();
        renderer.setDebugNoShadows(next);
        setDebugNoShadows(next);
        console.log(`[Overburden] Fog-of-war + shadows ${next ? "disabled" : "enabled"} (F1)`);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Build a quick lookup of item counts from the inventory
  const invCount = (itemId: string): number => {
    const slot = inventory.find((s) => s.itemId === itemId);
    return slot ? slot.count : 0;
  };

  return (
    <div style={hudContainerStyle}>
      <div style={fpsStyle}>
        FPS: {fps}
        {paused && <span style={{ color: "yellow", marginLeft: 8 }}>PAUSED</span>}
        {debugNoShadows && <span style={{ color: "#e74c3c", marginLeft: 8 }}>NOSHADOW</span>}
      </div>
      <ChunkDebugOverlay />

      {/* Attribute bars */}
      <div style={barsContainerStyle}>
        <AttributeBar label="HP" value={blockhead.health} color="#e74c3c" />
        <AttributeBar label="Food" value={blockhead.hunger} color="#e67e22" />
        <AttributeBar label="Energy" value={blockhead.energy} color="#f1c40f" />
        <AttributeBar label="Air" value={blockhead.air} color="#3498db" />
        <AttributeBar label="Happy" value={blockhead.happiness} color="#2ecc71" />
        <AttributeBar label="Env" value={blockhead.environment} color="#9b59b6" />
      </div>

      {/* Inventory panel (toggle with I) — includes crafting inline */}
      {showInventoryPanel && <InventoryPanel recipes={recipes} inventory={inventory} />}

      {/* Standalone crafting panel (toggle with C) — only when inventory panel is closed */}
      {showCraftPanel && !showInventoryPanel && <CraftPanel recipes={recipes} inventory={inventory} />}

      {/* Hotbar */}
      <div style={hotbarContainerStyle}>
        {HOTBAR_SLOTS.map((slot, i) => {
          const count = invCount(slot.itemId);
          const has = count > 0;
          return (
            <div key={i} style={hotbarSlotStyle(selectedSlot === i)}>
              <div style={{
                width: 28,
                height: 28,
                background: `rgb(${slot.color[0]}, ${slot.color[1]}, ${slot.color[2]})`,
                borderRadius: 2,
                opacity: has ? 1 : 0.25,
              }} />
              <span style={{
                position: "absolute",
                bottom: 0,
                right: 2,
                fontSize: 9,
                color: has ? "white" : "rgba(255,255,255,0.3)",
                textShadow: "0 1px 2px rgba(0,0,0,0.8)",
              }}>{count > 0 ? count : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Crafting panel ---
const craftPanelStyle: React.CSSProperties = {
  position: "absolute",
  top: 80,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 8,
  background: "rgba(0,0,0,0.8)",
  borderRadius: 6,
  border: "1px solid rgba(79,195,247,0.3)",
  pointerEvents: "auto",
  maxHeight: 400,
  overflowY: "auto",
  zIndex: 20,
};

const craftRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 8px",
  background: "rgba(255,255,255,0.05)",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  color: "white",
};

function CraftPanel({ recipes, inventory }: { recipes: { id: string; name: string; station: string }[]; inventory: { itemId: string; count: number }[] }) {
  const { renderer } = useGameStore();
  const [status, setStatus] = useState<string>("");

  const invCount = (itemId: string): number => {
    const slot = inventory.find((s) => s.itemId === itemId);
    return slot ? slot.count : 0;
  };

  const handleCraft = async (recipeId: string) => {
    const host = renderer?.getWorkerHost();
    if (!host) return;
    const result = await host.craft(recipeId);
    if (result.ok) {
      setStatus(`Crafted ${recipeId}`);
    } else {
      setStatus(`Failed: ${result.error ?? "unknown"}`);
    }
    // Clear status after 2s
    setTimeout(() => setStatus(""), 2000);
  };

  return (
    <div style={craftPanelStyle}>
      <div style={{ fontSize: 13, fontWeight: "bold", marginBottom: 4, color: "rgba(79,195,247,1)" }}>
        Craft (C to close)
      </div>
      {recipes.length === 0 && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>No recipes available</div>
      )}
      {recipes.map((r) => (
        <div
          key={r.id}
          style={craftRowStyle}
          onClick={() => handleCraft(r.id)}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(79,195,247,0.2)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
        >
          <span>{r.name}</span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>click</span>
        </div>
      ))}
      {status && (
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>{status}</div>
      )}
    </div>
  );
}

// --- Full inventory panel (I key) ---
const invOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.6)",
  pointerEvents: "auto",
  zIndex: 40,
};

const invPanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: 520,
  maxHeight: "80vh",
  padding: 16,
  background: "rgba(20,22,35,0.95)",
  borderRadius: 8,
  border: "1px solid rgba(79,195,247,0.3)",
  fontFamily: "monospace",
  color: "white",
  overflowY: "auto",
};

const invHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
  fontSize: 16,
  fontWeight: "bold",
  color: "rgba(79,195,247,1)",
};

const invCategoryLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: "bold",
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase" as const,
  letterSpacing: 1,
  margin: "12px 0 6px 0",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
  paddingBottom: 4,
};

const invGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, 64px)",
  gap: 6,
  justifyContent: "start",
};

const invSlotStyle: React.CSSProperties = {
  position: "relative",
  width: 64,
  height: 64,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
  fontSize: 9,
  color: "rgba(255,255,255,0.7)",
};

const invItemCountStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 2,
  right: 4,
  fontSize: 11,
  fontWeight: "bold",
  color: "white",
  textShadow: "0 1px 2px rgba(0,0,0,0.8)",
};

// Item color swatches (for items without a block color, use a category-based color)
const CATEGORY_COLORS: Record<ItemCategory, [number, number, number]> = {
  block: [128, 128, 128],
  material: [180, 140, 80],
  tool: [120, 180, 220],
  food: [200, 80, 80],
};

function InventoryPanel({ recipes, inventory }: { recipes: { id: string; name: string; station: string }[]; inventory: { itemId: string; count: number }[] }) {
  const { renderer, setShowInventoryPanel, setShowCraftPanel } = useGameStore();
  const [status, setStatus] = useState<string>("");

  const invCount = (itemId: string): number => {
    const slot = inventory.find((s) => s.itemId === itemId);
    return slot ? slot.count : 0;
  };

  const handleCraft = async (recipeId: string) => {
    const host = renderer?.getWorkerHost();
    if (!host) return;
    const result = await host.craft(recipeId);
    if (result.ok) {
      setStatus(`Crafted ${recipeId}`);
    } else {
      setStatus(`Failed: ${result.error ?? "unknown"}`);
    }
    setTimeout(() => setStatus(""), 2000);
  };

  const close = () => {
    setShowInventoryPanel(false);
    setShowCraftPanel(false);
  };

  // Group all registered items by category
  const allItems = getAllItems();
  const categories: ItemCategory[] = ["block", "material", "tool", "food"];
  const categoryLabels: Record<ItemCategory, string> = {
    block: "Blocks",
    material: "Materials",
    tool: "Tools",
    food: "Food",
  };

  return (
    <div style={invOverlayStyle} onClick={close}>
      <div style={invPanelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={invHeaderStyle}>
          <span>Inventory</span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontWeight: "normal" }}>
            I or Esc to close
          </span>
        </div>

        {/* Item grid grouped by category */}
        {categories.map((cat) => {
          const items = allItems.filter((it) => it.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <div style={invCategoryLabelStyle}>{categoryLabels[cat]}</div>
              <div style={invGridStyle}>
                {items.map((item) => {
                  const count = invCount(item.id);
                  const has = count > 0;
                  const color = item.placeBlock > 0
                    ? (getItemDef(item.id)?.placeBlock ?? 0) > 0
                      ? CATEGORY_COLORS.block
                      : CATEGORY_COLORS[cat]
                    : CATEGORY_COLORS[cat];
                  return (
                    <div key={item.id} style={{
                      ...invSlotStyle,
                      opacity: has ? 1 : 0.35,
                    }}>
                      <div style={{
                        width: 28,
                        height: 28,
                        background: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                        borderRadius: 2,
                      }} />
                      <span style={{ fontSize: 8, textAlign: "center", lineHeight: 1.1 }}>
                        {item.name}
                      </span>
                      {has && <span style={invItemCountStyle}>{count}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Crafting section (inline) */}
        <div style={invCategoryLabelStyle}>Crafting (hand)</div>
        {recipes.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>No recipes available</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {recipes.map((r) => {
            // Look up the recipe to check ingredients
            const recipe = r;
            return (
              <div
                key={recipe.id}
                style={craftRowStyle}
                onClick={() => handleCraft(recipe.id)}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(79,195,247,0.2)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
              >
                <span>{recipe.name}</span>
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>click to craft</span>
              </div>
            );
          })}
        </div>

        {status && (
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", marginTop: 8 }}>{status}</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { showTitleScreen, setShowTitleScreen } = useGameStore();

  // Poll blockhead state from SAB + inventory from worker, update the store
  useEffect(() => {
    if (showTitleScreen) return;
    const { renderer } = useGameStore.getState();
    if (!renderer) return;

    // Fetch hand-craftable recipes once
    const host = renderer.getWorkerHost();
    if (host) {
      host.getRecipes("hand").then((recipes) => {
        useGameStore.getState().setRecipes(recipes);
      });
    }

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
      // Poll inventory from the worker (async RPC)
      const h = renderer.getWorkerHost();
      if (h) {
        h.getInventory(0).then((inv) => {
          useGameStore.getState().setInventory(inv);
        });
      }
    }, 250);

    return () => clearInterval(interval);
  }, [showTitleScreen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = useGameStore.getState();
      if (s.showTitleScreen) return;

      if (e.key === "Escape") {
        // Esc closes the inventory panel first, then toggles pause
        if (s.showInventoryPanel) {
          s.setShowInventoryPanel(false);
          s.setShowCraftPanel(false);
        } else {
          s.setPaused(!s.paused);
        }
      } else if (e.key === "i" || e.key === "I") {
        // I toggles the full inventory panel (which includes crafting inline)
        s.setShowInventoryPanel(!s.showInventoryPanel);
        if (!s.showInventoryPanel) s.setShowCraftPanel(false);
      } else if (e.key === "c" || e.key === "C") {
        // C toggles the standalone craft panel (hidden when inventory is open)
        if (s.showInventoryPanel) return;
        s.setShowCraftPanel(!s.showCraftPanel);
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
          WASD/Arrows: move | Space: jump | Left-click: mine (auto FG/BG) | Right-click: place | Wheel: zoom | 1-9: hotbar | I: inventory | C: craft | F1: no-shadows | F2: chunk grid | F3: noclip | ESC: pause
        </div>
      </div>
    );
  }

  return <Hud />;
}
