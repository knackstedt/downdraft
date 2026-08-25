import { memo, useEffect, useMemo, useState } from "react";
import { ChunkDebugOverlay } from "./components/chunk-debug-overlay";
import { StationPanel } from "./components/station-panel";
import { TaskQueueDisplay } from "./components/task-queue-display";
import { encodeDropItem, getDropColor } from "./shared/drop-registry";
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

// Season display colors + icons for the HUD
const SEASON_COLORS: Record<string, string> = {
  spring: "#7fcf6f",
  summer: "#f0e060",
  autumn: "#e09040",
  winter: "#a0c0e0",
};
const SEASON_ICONS: Record<string, string> = {
  spring: "\u2698", // flower
  summer: "\u2600", // sun
  autumn: "\u2668", // leaf-like
  winter: "\u2744", // snowflake
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
  bottom: 32,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  gap: 4,
  padding: 4,
  background: "rgba(0,0,0,0.6)",
  borderRadius: 6,
};

const hotbarSlotStyle = (selected: boolean): React.CSSProperties => ({
  width: 44,
  height: 44,
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 10,
  color: "rgba(255,255,255,0.5)",
  background: selected ? "rgba(79,195,247,0.3)" : "rgba(255,255,255,0.05)",
  border: selected ? "2px solid rgba(79,195,247,0.8)" : "1px solid rgba(255,255,255,0.1)",
  borderRadius: 4,
  cursor: "pointer",
});

const hotbarSlotNumStyle: React.CSSProperties = {
  position: "absolute",
  top: 1,
  left: 3,
  fontSize: 8,
  color: "rgba(255,255,255,0.4)",
  pointerEvents: "none",
};

const hotbarSlotLabelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: -14,
  left: "50%",
  transform: "translateX(-50%)",
  fontSize: 8,
  whiteSpace: "nowrap",
  color: "rgba(255,255,255,0.6)",
  textShadow: "0 1px 2px rgba(0,0,0,0.8)",
  pointerEvents: "none",
};

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

// Color map for all placeable items (for dynamic hotbar display)
const ITEM_COLORS: Record<string, [number, number, number]> = {
  dirt: [120, 80, 50],
  grass: [80, 160, 60],
  stone: [128, 128, 128],
  sand: [220, 200, 140],
  wood: [140, 100, 60],
  clay: [180, 100, 80],
  gravel: [120, 110, 100],
  ladder: [180, 140, 80],
  rope: [200, 180, 120],
  scaffolding: [160, 130, 90],
  torch: [240, 200, 80],
  workbench: [140, 100, 60],
  craft_bench: [130, 90, 50],
  tool_bench: [120, 100, 70],
  woodwork_bench: [150, 110, 70],
  campfire: [200, 100, 40],
  kiln: [170, 80, 50],
  furnace: [100, 100, 110],
  metalwork_bench: [90, 90, 100],
  builder_bench: [110, 90, 60],
  tailor_bench: [160, 120, 90],
  compost_bin: [100, 130, 60],
  bed: [180, 120, 100],
};

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

// --- Pickup notification toasts ---
// Color fallback for harvest foods not in the drop registry.
const FOOD_COLORS: Record<string, [number, number, number]> = {
  berries: [180, 40, 60],
  wild_mushroom: [140, 110, 70],
  raw_meat: [200, 120, 120],
  cooked_meat: [160, 90, 50],
  bread: [220, 190, 120],
  tomato: [220, 80, 50],
  carrot: [220, 140, 40],
  potato: [200, 170, 110],
  corn: [240, 220, 80],
  pumpkin: [220, 130, 40],
  wheat: [220, 200, 110],
  brown_mushroom: [140, 110, 70],
  red_mushroom: [180, 60, 50],
};

/** Resolve a display color (RGB 0-255) for any item id, for toast swatches. */
function getItemColor(itemId: string): [number, number, number] {
  const blockColor = ITEM_COLORS[itemId];
  if (blockColor) return blockColor;
  const code = encodeDropItem(itemId);
  if (code !== 0) return getDropColor(code);
  const foodColor = FOOD_COLORS[itemId];
  if (foodColor) return foodColor;
  return [128, 128, 128];
}

const pickupStackStyle: React.CSSProperties = {
  position: "absolute",
  top: 120,
  right: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  pointerEvents: "none",
  zIndex: 20,
  fontFamily: "monospace",
};

const pickupToastStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  background: "rgba(0,0,0,0.55)",
  borderRadius: 4,
  color: "white",
  fontSize: 12,
  fontWeight: "bold",
  boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
};

const pickupSwatchStyle = (color: [number, number, number]): React.CSSProperties => ({
  width: 14,
  height: 14,
  background: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
  borderRadius: 2,
  flexShrink: 0,
  border: "1px solid rgba(255,255,255,0.2)",
});

const PickupNotifications = memo(function PickupNotifications() {
  const pickups = useGameStore((s) => s.pickups);
  if (pickups.length === 0) return null;
  return (
    <div style={pickupStackStyle}>
      {pickups.map((t) => {
        const name = getItemDef(t.itemId)?.name ?? t.itemId;
        const color = getItemColor(t.itemId);
        return (
          <div key={t.id} style={pickupToastStyle}>
            <div style={pickupSwatchStyle(color)} />
            <span>{"\u00d7"}{t.count}</span>
            <span style={{ fontWeight: "normal", opacity: 0.85 }}>{name}</span>
          </div>
        );
      })}
    </div>
  );
});

// --- Pause menu (with Reset Game option) ---
const pauseOverlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.7)",
  pointerEvents: "auto",
  zIndex: 60,
};

const pausePanelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 24,
  background: "rgba(20,22,35,0.95)",
  borderRadius: 8,
  border: "1px solid rgba(79,195,247,0.3)",
  fontFamily: "monospace",
  color: "white",
  minWidth: 280,
};

const pauseTitleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: "bold",
  color: "rgba(79,195,247,1)",
  textAlign: "center",
  marginBottom: 8,
};

const pauseButtonBase: React.CSSProperties = {
  padding: "10px 24px",
  fontSize: 14,
  fontFamily: "monospace",
  color: "white",
  border: "2px solid rgba(79,195,247,0.5)",
  borderRadius: 6,
  cursor: "pointer",
  transition: "background 0.2s",
  textAlign: "center",
};

const pauseButtonStyle: React.CSSProperties = {
  ...pauseButtonBase,
  background: "rgba(79,195,247,0.2)",
};

const dangerButtonStyle: React.CSSProperties = {
  ...pauseButtonBase,
  background: "rgba(231,76,60,0.2)",
  borderColor: "rgba(231,76,60,0.5)",
};

const pauseHintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.4)",
  textAlign: "center",
  marginTop: 4,
};

const confirmTextStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(255,255,255,0.8)",
  textAlign: "center",
  lineHeight: 1.5,
};

function PauseMenu() {
  const setPaused = useGameStore((s) => s.setPaused);
  const setTaskMode = useGameStore((s) => s.setTaskMode);
  const setShowCraftPanel = useGameStore((s) => s.setShowCraftPanel);
  const setShowInventoryPanel = useGameStore((s) => s.setShowInventoryPanel);
  const setShowTaskQueue = useGameStore((s) => s.setShowTaskQueue);
  const setSelectedStation = useGameStore((s) => s.setSelectedStation);
  const setNotification = useGameStore((s) => s.setNotification);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleReset = async () => {
    const { renderer } = useGameStore.getState();
    if (!renderer) return;
    setResetting(true);
    setResetError(null);
    try {
      const result = await renderer.resetGame();
      if (result.ok) {
        // Clear localStorage inventory save
        try { localStorage.removeItem("overburden:inventory"); } catch { /* ignore */ }
        // Reset all UI state to match the fresh world
        setTaskMode(false);
        setShowCraftPanel(false);
        setShowInventoryPanel(false);
        setShowTaskQueue(false);
        setSelectedStation(null);
        setNotification("Game reset — fresh world generated!");
        // Re-fetch hand-craftable recipes for the new world
        const host = renderer.getWorkerHost();
        if (host) {
          host.getRecipes("hand").then((recipes) => {
            useGameStore.getState().setRecipes(recipes);
          });
          // Refresh inventory from the worker (should be the starting torches + ladders)
          host.getInventory(0).then((inv) => {
            useGameStore.getState().setInventory(inv);
            renderer.setHotbarFromInventory(inv);
          });
        }
        // Resume the game
        setPaused(false);
        setConfirming(false);
      } else {
        setResetError(result.error ?? "Reset failed");
      }
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div style={pauseOverlayStyle}>
      <div style={pausePanelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={pauseTitleStyle}>Paused</div>
        {!confirming ? (
          <>
            <button
              style={pauseButtonStyle}
              onClick={() => setPaused(false)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(79,195,247,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(79,195,247,0.2)"; }}
            >
              Resume
            </button>
            <button
              style={dangerButtonStyle}
              onClick={() => setConfirming(true)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(231,76,60,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(231,76,60,0.2)"; }}
            >
              Reset Game
            </button>
            <div style={pauseHintStyle}>Esc to resume</div>
          </>
        ) : (
          <>
            <div style={confirmTextStyle}>
              Are you sure? This will permanently delete your world, inventory,
              and all progress. A fresh world will be generated.
            </div>
            {resetError && (
              <div style={{ ...confirmTextStyle, color: "rgba(231,76,60,1)" }}>
                Error: {resetError}
              </div>
            )}
            <button
              style={dangerButtonStyle}
              disabled={resetting}
              onClick={handleReset}
              onMouseEnter={(e) => { if (!resetting) e.currentTarget.style.background = "rgba(231,76,60,0.35)"; }}
              onMouseLeave={(e) => { if (!resetting) e.currentTarget.style.background = "rgba(231,76,60,0.2)"; }}
            >
              {resetting ? "Resetting..." : "Yes, Reset Everything"}
            </button>
            <button
              style={pauseButtonStyle}
              disabled={resetting}
              onClick={() => { setConfirming(false); setResetError(null); }}
              onMouseEnter={(e) => { if (!resetting) e.currentTarget.style.background = "rgba(79,195,247,0.35)"; }}
              onMouseLeave={(e) => { if (!resetting) e.currentTarget.style.background = "rgba(79,195,247,0.2)"; }}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// HUD sub-components — each subscribes to only the store slices it needs.
// This prevents a single slice change (e.g. fps every 500ms) from
// re-rendering the entire HUD tree (attribute bars, hotbar, panels, etc.).
// ============================================================================

// --- FPS / season / debug indicator bar ---
// Re-renders when: fps, season, dayInSeason, year, paused, taskMode change
// (every 500ms for fps/season, rarely for the rest).
const FpsBar = memo(function FpsBar() {
  const fps = useGameStore((s) => s.fps);
  const season = useGameStore((s) => s.season);
  const dayInSeason = useGameStore((s) => s.dayInSeason);
  const year = useGameStore((s) => s.year);
  const paused = useGameStore((s) => s.paused);
  const taskMode = useGameStore((s) => s.taskMode);
  const [cameraDetached, setCameraDetached] = useState(false);
  const [debugNoShadows, setDebugNoShadows] = useState(false);
  const [debugInspect, setDebugInspect] = useState(false);

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

  // Poll camera detached state + debug flags for HUD indicator
  useEffect(() => {
    const { renderer } = useGameStore.getState();
    if (!renderer) return;
    const interval = setInterval(() => {
      setCameraDetached(renderer.camera.detached);
      const inp = renderer.getInput();
      setDebugInspect(!!inp?.debugInspect);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={fpsStyle}>
      FPS: {fps}
      <span style={{ marginLeft: 8, color: SEASON_COLORS[season] }}>
        {SEASON_ICONS[season]} {season[0].toUpperCase() + season.slice(1)} Y{year + 1} D{dayInSeason + 1}
      </span>
      {paused && <span style={{ color: "yellow", marginLeft: 8 }}>PAUSED</span>}
      {debugNoShadows && <span style={{ color: "#e74c3c", marginLeft: 8 }}>NOSHADOW</span>}
      {debugInspect && <span style={{ color: "#1abc9c", marginLeft: 8, fontWeight: "bold" }}>INSPECT (F6)</span>}
      {taskMode && <span style={{ color: "#f39c12", marginLeft: 8, fontWeight: "bold" }}>TASK MODE (T)</span>}
      {cameraDetached && <span style={{ color: "#9b59b6", marginLeft: 8, fontWeight: "bold" }}>CAM DETACHED (F)</span>}
    </div>
  );
});

// --- Attribute bars (HP, Food, Energy, Air, Happy, Env) ---
// Re-renders only when blockhead stats change (polled every 250ms, but
// only updates the store when a value actually changes).
const AttributeBars = memo(function AttributeBars() {
  const blockhead = useGameStore((s) => s.blockhead);
  return (
    <div style={barsContainerStyle}>
      <AttributeBar label="HP" value={blockhead.health} color="#e74c3c" />
      <AttributeBar label="Food" value={blockhead.hunger} color="#e67e22" />
      <AttributeBar label="Energy" value={blockhead.energy} color="#f1c40f" />
      <AttributeBar label="Air" value={blockhead.air} color="#3498db" />
      <AttributeBar label="Happy" value={blockhead.happiness} color="#2ecc71" />
      <AttributeBar label="Env" value={blockhead.environment} color="#9b59b6" />
    </div>
  );
});

// --- Character gender indicator ---
// Small label showing the current player model gender. Toggle with C key.
const GenderIndicator = memo(function GenderIndicator() {
  const gender = useGameStore((s) => s.characterGender);
  return (
    <div style={{
      position: "absolute",
      bottom: 8,
      right: 12,
      background: "rgba(0, 0, 0, 0.5)",
      color: "rgba(255, 255, 255, 0.7)",
      padding: "4px 10px",
      borderRadius: "4px",
      fontSize: "12px",
      fontFamily: "monospace",
      pointerEvents: "none",
      userSelect: "none",
    }}>
      {gender === "male" ? "Male" : "Female"} (C to toggle)
    </div>
  );
});

// --- Hotbar (dynamic from inventory) ---
// Re-renders only when inventory or selectedSlot changes.
const Hotbar = memo(function Hotbar() {
  const inventory = useGameStore((s) => s.inventory);
  const selectedSlot = useGameStore((s) => s.selectedSlot);

  const invCount = (itemId: string): number => {
    const slot = inventory.find((s) => s.itemId === itemId);
    return slot ? slot.count : 0;
  };

  // Build dynamic hotbar slots from inventory (placeable items first, then defaults)
  const hotbarSlots: ({ itemId: string; color: [number, number, number] } | null)[] = useMemo(() => {
    const slots: ({ itemId: string; color: [number, number, number] } | null)[] = new Array(9).fill(null);
    let idx = 0;
    for (const slot of inventory) {
      if (idx >= 9) break;
      if (slot.count <= 0) continue;
      const def = getItemDef(slot.itemId);
      if (def && def.placeBlock > 0) {
        slots[idx] = { itemId: slot.itemId, color: ITEM_COLORS[slot.itemId] ?? [128, 128, 128] };
        idx++;
      }
    }
    for (let i = idx; i < 9; i++) {
      const defaultSlot = HOTBAR_SLOTS[i];
      if (defaultSlot) {
        slots[i] = defaultSlot;
      }
    }
    return slots;
  }, [inventory]);

  return (
    <div style={hotbarContainerStyle}>
      {hotbarSlots.map((slot, i) => {
        const count = slot ? invCount(slot.itemId) : 0;
        const has = count > 0;
        const itemName = slot ? (getItemDef(slot.itemId)?.name ?? slot.itemId) : "";
        return (
          <div
            key={i}
            style={hotbarSlotStyle(selectedSlot === i)}
            title={slot ? `${itemName}${count > 0 ? ` (${count})` : ""}` : "Empty"}
          >
            <span style={hotbarSlotNumStyle}>{i + 1}</span>
            {slot && (
              <div style={{
                width: 28,
                height: 28,
                background: `rgb(${slot.color[0]}, ${slot.color[1]}, ${slot.color[2]})`,
                borderRadius: 2,
                opacity: has ? 1 : 0.25,
              }} />
            )}
            <span style={{
              position: "absolute",
              bottom: 0,
              right: 2,
              fontSize: 9,
              color: has ? "white" : "rgba(255,255,255,0.3)",
              textShadow: "0 1px 2px rgba(0,0,0,0.8)",
            }}>{count > 0 ? count : ""}</span>
            {slot && (
              <span style={hotbarSlotLabelStyle}>{itemName}</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

// --- Notification toast ---
// Re-renders only when notification changes (rare — user actions / errors).
const NotificationToast = memo(function NotificationToast() {
  const notification = useGameStore((s) => s.notification);

  // Auto-dismiss notification after 4 seconds
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => {
      useGameStore.getState().setNotification(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [notification]);

  if (!notification) return null;
  return (
    <div style={{
      position: "absolute",
      top: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "rgba(180, 40, 30, 0.9)",
      color: "white",
      padding: "10px 20px",
      borderRadius: "6px",
      fontSize: "14px",
      fontFamily: "sans-serif",
      fontWeight: "bold",
      pointerEvents: "none",
      zIndex: 200,
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    }}>
      {notification}
    </div>
  );
});

// --- Panels (inventory, craft, station, task queue, pause menu) ---
// Re-renders only when panel visibility flags or their data change.
const PanelRouter = memo(function PanelRouter() {
  const showCraftPanel = useGameStore((s) => s.showCraftPanel);
  const showInventoryPanel = useGameStore((s) => s.showInventoryPanel);
  const showTaskQueue = useGameStore((s) => s.showTaskQueue);
  const selectedStation = useGameStore((s) => s.selectedStation);
  const recipes = useGameStore((s) => s.recipes);
  const inventory = useGameStore((s) => s.inventory);
  const paused = useGameStore((s) => s.paused);
  const deterministic = useGameStore((s) => s.deterministic);

  return (
    <>
      {/* Inventory panel (toggle with I) — includes crafting inline */}
      {showInventoryPanel && <InventoryPanel recipes={recipes} inventory={inventory} />}

      {/* Standalone crafting panel (toggle with C) — only when inventory panel is closed */}
      {showCraftPanel && !showInventoryPanel && <CraftPanel recipes={recipes} inventory={inventory} />}

      {/* Station panel (shown when a station is selected) */}
      {selectedStation && <StationPanel ax={selectedStation.ax} ay={selectedStation.ay} />}

      {/* Task queue display (toggle with Q) */}
      {showTaskQueue && <TaskQueueDisplay />}

      {/* Pause menu (Esc) — includes Reset Game option */}
      {paused && !deterministic && <PauseMenu />}
    </>
  );
});

function Hud() {
  // Hud is now a thin shell — it subscribes to NO store slices, so it
  // never re-renders after mount. Each child subscribes to only the
  // slices it needs, so e.g. an FPS update (every 500ms) re-renders
  // only FpsBar, not the hotbar or attribute bars.

  // Sync taskMode from store → renderer (lives here because it's a
  // global side-effect, not tied to any visual sub-component).
  const taskMode = useGameStore((s) => s.taskMode);
  useEffect(() => {
    const { renderer } = useGameStore.getState();
    if (renderer) renderer.setTaskMode(taskMode);
  }, [taskMode]);

  // Save chunks to OPFS on page unload (best-effort, fire-and-forget)
  useEffect(() => {
    const handler = () => {
      const { renderer } = useGameStore.getState();
      renderer?.getWorkerHost()?.saveNow().catch(() => {});
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return (
    <div style={hudContainerStyle}>
      <FpsBar />
      <ChunkDebugOverlay />
      <AttributeBars />
      <PanelRouter />
      <NotificationToast />
      <PickupNotifications />
      <Hotbar />
      <GenderIndicator />
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
  const renderer = useGameStore((s) => s.renderer);
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
  const renderer = useGameStore((s) => s.renderer);
  const setShowInventoryPanel = useGameStore((s) => s.setShowInventoryPanel);
  const setShowCraftPanel = useGameStore((s) => s.setShowCraftPanel);
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
  const showTitleScreen = useGameStore((s) => s.showTitleScreen);
  const setShowTitleScreen = useGameStore((s) => s.setShowTitleScreen);

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
      // Register the pickup notification listener — the worker emits a
      // single batched "pickups" event per frame when items are picked up.
      host.onPickups((data) => useGameStore.getState().addPickups(data));
    }

    // --- Load saved inventory from localStorage on game start ---
    // Skip in deterministic mode (e2e tests need fresh state)
    const INVENTORY_SAVE_KEY = "overburden:inventory";
    if (!useGameStore.getState().deterministic) {
      try {
        const saved = localStorage.getItem(INVENTORY_SAVE_KEY);
        if (saved && host) {
          const slots = JSON.parse(saved) as { itemId: string; count: number }[];
          if (Array.isArray(slots) && slots.length > 0) {
            host.setInventory(slots, 0).then(() => {
              // Refresh the store after loading
              host.getInventory(0).then((inv) => {
                useGameStore.getState().setInventory(inv);
                renderer.setHotbarFromInventory(inv);
              });
            });
          }
        }
      } catch {
        // localStorage might not be available or JSON corrupted — ignore
      }
    }

    // Track last saved inventory to avoid redundant localStorage writes
    let lastSavedJson = "";

    const interval = setInterval(() => {
      const reader = renderer.getSimReader();
      if (!reader) return;
      // Prune expired pickup toasts (no new timer — reuses this 250ms poll)
      useGameStore.getState().prunePickups(Date.now());
      const count = reader.getBlockheadCount();
      if (count > 0) {
        const bh = reader.getBlockhead(0);
        // Only update the store if a value actually changed — avoids
        // triggering a React re-render (and blocking the rAF loop) every
        // poll when the data is identical.
        const prev = useGameStore.getState().blockhead;
        if (
          prev.health !== bh[7] || prev.hunger !== bh[8] ||
          prev.energy !== bh[9] || prev.air !== bh[10] ||
          prev.happiness !== bh[11] || prev.environment !== bh[12]
        ) {
          useGameStore.getState().setBlockhead({
            health: bh[7],
            hunger: bh[8],
            energy: bh[9],
            air: bh[10],
            happiness: bh[11],
            environment: bh[12],
          });
        }
      }
      // Sync selected slot from input
      const input = renderer.getInput();
      if (input) {
        const prevSlot = useGameStore.getState().selectedSlot;
        if (prevSlot !== input.selectedSlot) {
          useGameStore.getState().setSelectedSlot(input.selectedSlot);
        }
      }
      // Sync character gender from renderer (toggled via C key)
      const prevGender = useGameStore.getState().characterGender;
      const curGender = renderer.getCharacterGender();
      if (prevGender !== curGender) {
        useGameStore.getState().setCharacterGender(curGender);
      }
      // Poll inventory from the worker (async RPC)
      const h = renderer.getWorkerHost();
      if (h) {
        h.getInventory(0).then((inv) => {
          // Only update the store if the inventory actually changed.
          // The worker returns a fresh array each call, so compare by value.
          const prevInv = useGameStore.getState().inventory;
          let changed = prevInv.length !== inv.length;
          if (!changed) {
            for (let i = 0; i < inv.length; i++) {
              if (prevInv[i].itemId !== inv[i].itemId || prevInv[i].count !== inv[i].count) {
                changed = true;
                break;
              }
            }
          }
          if (changed) {
            useGameStore.getState().setInventory(inv);
          }
          // Update the renderer's hotbar from the inventory
          renderer.setHotbarFromInventory(inv);
          // --- Save inventory to localStorage on change ---
          // Skip in deterministic mode (e2e tests)
          if (!useGameStore.getState().deterministic) {
            try {
              const json = JSON.stringify(inv);
              if (json !== lastSavedJson) {
                lastSavedJson = json;
                localStorage.setItem(INVENTORY_SAVE_KEY, json);
              }
            } catch {
              // localStorage might not be available — ignore
            }
          }
        });
      }
    }, 250);

    // Sync task markers with the actual task queue — rebuild from the
    // worker's task list so completed/shifted tasks disappear and all
    // queued tasks show markers.
    const markerInterval = setInterval(() => {
      const h = renderer.getWorkerHost();
      if (h) {
        h.getTasks(0).then((tasks) => {
          const reader = renderer.getSimReader();
          if (!reader) return;
          const originCx = reader.getOriginCx();
          const originCy = reader.getOriginCy();
          // Check for failed tasks and show a notification
          const failed = tasks.find((t) => t.status === "failed" && t.failReason === "stuck");
          if (failed) {
            useGameStore.getState().setNotification("Blockhead is stuck — can't reach the target!");
          }
          // Rebuild markers from the task queue (world coords → active-grid)
          // Only show MINE_BLOCK and MOVE_TO tasks (other types don't have
          // meaningful grid positions).
          renderer.taskMarkers = tasks
            .filter((t) => t.type === "MINE_BLOCK" || t.type === "MOVE_TO")
            .map((t) => ({
              gridX: t.targetX - originCx * 64,
              gridY: t.targetY - originCy * 64,
              action: (t.type === "MINE_BLOCK" ? "mine" : "move") as "mine" | "move",
            }));
        });
      }
    }, 200);

    return () => {
      clearInterval(interval);
      clearInterval(markerInterval);
    };
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
      } else if (e.key === "q" || e.key === "Q") {
        // Q toggles the task queue display
        s.setShowTaskQueue(!s.showTaskQueue);
      } else if (e.key === "t" || e.key === "T") {
        // T toggles task mode (click to queue tasks)
        const newMode = !s.taskMode;
        s.setTaskMode(newMode);
        // Clear task markers when exiting task mode
        if (!newMode) {
          const { renderer } = useGameStore.getState();
          if (renderer) renderer.taskMarkers = [];
        }
      } else if (e.key === "f" || e.key === "F") {
        // F toggles camera detach/attach
        const { renderer } = useGameStore.getState();
        if (renderer) {
          const cam = renderer.camera;
          if (cam.detached) {
            // Re-attach: camera will follow player again
            cam.detached = false;
            cam.endPan();
          } else {
            // Detach: camera stays where it is, WASD will move it
            cam.detached = true;
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (showTitleScreen) {
    return (
      <div style={titleStyle}>
        <div style={titleTextStyle}>Overburden</div>
        <div style={subtitleStyle}>A 2.5D successor of The Blockheads — powered by downdraft</div>
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
          WASD/Arrows: move | Space: jump | Left-click: mine (auto FG/BG) | Right-click: place | Wheel: zoom | 1-9: hotbar | I: inventory | C: craft | T: task mode | Q: task queue | F1: no-shadows | F2: chunk grid | F3: noclip | F6: inspect cell | ESC: pause
        </div>
      </div>
    );
  }

  return <Hud />;
}
