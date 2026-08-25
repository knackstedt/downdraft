// ============================================================================
// Overburden — station panel UI
//
// Shows when a station block is selected (right-click). Displays:
// - Station name + fuel bar (if fueled)
// - Recipe list with ingredients, craft time, fuel cost
// - Active craft job with progress bar + rush/abort buttons
// - Queued jobs with abort buttons
// ============================================================================

import { useEffect, useState } from "react";
import { ACTIVE_GRID_W } from "../shared/constants";
import { getItemDef } from "../shared/items";
import { recipesForStation } from "../shared/recipes";
import { getStationByBlock } from "../shared/stations";
import { useGameStore } from "../stores/game-store";

interface CraftJobSummary {
  id: number; recipeId: string; recipeName: string;
  progress: number; elapsed: number; craftTime: number;
  bhIndex: number; status: string;
}

interface CraftQueueSummary {
  fuel: number;
  activeJob: CraftJobSummary | null;
  queue: { id: number; recipeId: string; recipeName: string; bhIndex: number; status: string }[];
}

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 80,
  right: 16,
  width: 320,
  maxHeight: "70vh",
  overflowY: "auto",
  background: "rgba(20, 25, 40, 0.95)",
  border: "2px solid rgba(79,195,247,0.4)",
  borderRadius: 8,
  padding: 12,
  color: "white",
  fontFamily: "monospace",
  fontSize: 12,
  zIndex: 20,
  pointerEvents: "auto",
};

const headerStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 8,
  color: "rgba(79,195,247,1)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const closeButtonStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "rgba(255,255,255,0.5)",
  fontSize: 16,
  padding: "0 4px",
};

const fuelBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 2,
  marginBottom: 12,
};

const fuelSlotStyle = (lit: boolean): React.CSSProperties => ({
  width: 16,
  height: 8,
  borderRadius: 2,
  background: lit ? "#e67e22" : "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.1)",
});

const recipeRowStyle: React.CSSProperties = {
  padding: "6px 8px",
  marginBottom: 4,
  background: "rgba(255,255,255,0.05)",
  borderRadius: 4,
  cursor: "pointer",
  transition: "background 0.15s",
};

const recipeNameStyle: React.CSSProperties = {
  fontWeight: "bold",
  marginBottom: 2,
};

const recipeDetailStyle: React.CSSProperties = {
  fontSize: 10,
  color: "rgba(255,255,255,0.5)",
};

const progressBarStyle: React.CSSProperties = {
  width: "100%",
  height: 12,
  background: "rgba(255,255,255,0.1)",
  borderRadius: 6,
  overflow: "hidden",
  marginBottom: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 10,
  fontFamily: "monospace",
  background: "rgba(79,195,247,0.2)",
  color: "white",
  border: "1px solid rgba(79,195,247,0.4)",
  borderRadius: 4,
  cursor: "pointer",
  marginLeft: 4,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: "bold",
  color: "rgba(255,255,255,0.6)",
  marginTop: 8,
  marginBottom: 4,
  textTransform: "uppercase",
};

export function StationPanel({ ax, ay }: { ax: number; ay: number }) {
  const renderer = useGameStore((s) => s.renderer);
  const setSelectedStation = useGameStore((s) => s.setSelectedStation);
  const inventory = useGameStore((s) => s.inventory);
  const [queue, setQueue] = useState<CraftQueueSummary>({ fuel: 0, activeJob: null, queue: [] });
  const [status, setStatus] = useState<string>("");

  // Poll craft queue every 250ms
  useEffect(() => {
    const interval = setInterval(async () => {
      const r = renderer;
      if (!r) return;
      const host = r.getWorkerHost();
      if (!host) return;
      try {
        const q = await host.getCraftQueue(ax, ay);
        setQueue(q);
      } catch {
        // ignore
      }
    }, 250);
    return () => clearInterval(interval);
  }, [renderer, ax, ay]);

  // Get station def from the block at (ax, ay) — we need to read it from the worker
  const [stationName, setStationName] = useState<string>("Station");
  const [stationFueled, setStationFueled] = useState<boolean>(false);
  const [fuelSlots, setFuelSlots] = useState<number>(10);

  useEffect(() => {
    // Read the block ID from the sim buffer to determine station type
    const r = renderer;
    if (!r) return;
    const reader = r.getSimReader();
    if (!reader) return;
    const blockId = reader.foreground[ay * ACTIVE_GRID_W + ax] & 0xFF;
    const stationDef = getStationByBlock(blockId);
    if (stationDef) {
      setStationName(stationDef.name);
      setStationFueled(stationDef.fueled);
      setFuelSlots(stationDef.fuelSlots);
    }
  }, [renderer, ax, ay]);

  const recipes = recipesForStation(getStationByBlock(
    (renderer?.getSimReader()?.foreground[ay * ACTIVE_GRID_W + ax] ?? 0) & 0xFF
  )?.station ?? "workbench");

  const invCount = (itemId: string): number => {
    let total = 0;
    for (const s of inventory) {
      if (s && s.itemId === itemId) total += s.count;
    }
    return total;
  };

  const handleCraft = async (recipeId: string) => {
    const r = renderer;
    if (!r) return;
    const host = r.getWorkerHost();
    if (!host) return;
    const result = await host.craft(recipeId, ax, ay, 0);
    if (result.ok) {
      setStatus("Crafting...");
    } else {
      setStatus(result.error ?? "Failed");
    }
    setTimeout(() => setStatus(""), 2000);
  };

  const handleRush = async (jobId: number) => {
    const r = renderer;
    if (!r) return;
    const host = r.getWorkerHost();
    if (!host) return;
    const result = await host.rushCraft(ax, ay, jobId, 0);
    setStatus(result.ok ? "Rushed!" : (result.error ?? "Failed"));
    setTimeout(() => setStatus(""), 2000);
  };

  const handleAbort = async (jobId: number) => {
    const r = renderer;
    if (!r) return;
    const host = r.getWorkerHost();
    if (!host) return;
    await host.abortCraft(ax, ay, jobId);
  };

  const handleAddFuel = async (itemId: string) => {
    const r = renderer;
    if (!r) return;
    const host = r.getWorkerHost();
    if (!host) return;
    const result = await host.addFuel(ax, ay, itemId, 1, 0);
    setStatus(result.ok ? "Fuel added" : (result.error ?? "Failed"));
    setTimeout(() => setStatus(""), 2000);
  };

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>{stationName}</span>
        <span style={closeButtonStyle} onClick={() => setSelectedStation(null)}>×</span>
      </div>

      {stationFueled && (
        <>
          <div style={sectionLabelStyle}>Fuel</div>
          <div style={fuelBarStyle}>
            {Array.from({ length: fuelSlots }, (_, i) => (
              <div key={i} style={fuelSlotStyle(i < queue.fuel)} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {["wood", "coal", "stick", "charcoal"].map((fuelId) => {
              const count = invCount(fuelId);
              if (count <= 0) return null;
              return (
                <button
                  key={fuelId}
                  style={buttonStyle}
                  onClick={() => handleAddFuel(fuelId)}
                >
                  +{fuelId} ({count})
                </button>
              );
            })}
          </div>
        </>
      )}

      {queue.activeJob && (
        <>
          <div style={sectionLabelStyle}>Active Craft</div>
          <div style={{ marginBottom: 8 }}>
            <div style={recipeNameStyle}>{queue.activeJob.recipeName}</div>
            <div style={progressBarStyle}>
              <div style={{
                width: `${Math.round(queue.activeJob.progress * 100)}%`,
                height: "100%",
                background: "rgba(79,195,247,0.8)",
                transition: "width 0.2s",
              }} />
            </div>
            <div style={recipeDetailStyle}>
              {queue.activeJob.elapsed.toFixed(1)}s / {queue.activeJob.craftTime}s
              {queue.activeJob.status === "pending" && " (needs fuel)"}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button style={buttonStyle} onClick={() => handleRush(queue.activeJob!.id)}>
                Rush
              </button>
              <button style={buttonStyle} onClick={() => handleAbort(queue.activeJob!.id)}>
                Abort
              </button>
            </div>
          </div>
        </>
      )}

      {queue.queue.length > 0 && (
        <>
          <div style={sectionLabelStyle}>Queue ({queue.queue.length})</div>
          {queue.queue.map((job) => (
            <div key={job.id} style={{ ...recipeRowStyle, cursor: "default", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{job.recipeName}</span>
              <button style={buttonStyle} onClick={() => handleAbort(job.id)}>×</button>
            </div>
          ))}
        </>
      )}

      <div style={sectionLabelStyle}>Recipes</div>
      {recipes.map((recipe) => {
        const canCraft = recipe.inputs.every((inp) => invCount(inp.itemId) >= inp.count);
        const fuelOk = !stationFueled || queue.fuel > 0 || recipe.fuelCost === 0;
        return (
          <div
            key={recipe.id}
            style={{
              ...recipeRowStyle,
              opacity: canCraft && fuelOk ? 1 : 0.4,
              background: canCraft && fuelOk ? "rgba(79,195,247,0.1)" : "rgba(255,255,255,0.05)",
            }}
            onClick={() => canCraft && handleCraft(recipe.id)}
            onMouseEnter={(e) => { if (canCraft) e.currentTarget.style.background = "rgba(79,195,247,0.25)"; }}
            onMouseLeave={(e) => { if (canCraft) e.currentTarget.style.background = "rgba(79,195,247,0.1)"; }}
          >
            <div style={recipeNameStyle}>{recipe.name}</div>
            <div style={recipeDetailStyle}>
              {recipe.inputs.map((inp, i) => {
                const itemDef = getItemDef(inp.itemId);
                const have = invCount(inp.itemId);
                return (
                  <span key={i} style={{ color: have >= inp.count ? "rgba(255,255,255,0.5)" : "#e74c3c" }}>
                    {i > 0 && ", "}{inp.count}× {itemDef?.name ?? inp.itemId}
                  </span>
                );
              })}
              {" → "}
              {recipe.outputs.map((out, i) => {
                const itemDef = getItemDef(out.itemId);
                return (
                  <span key={i}>
                    {i > 0 && ", "}{out.count}× {itemDef?.name ?? out.itemId}
                  </span>
                );
              })}
            </div>
            <div style={recipeDetailStyle}>
              ⏱ {recipe.craftTime}s{recipe.fuelCost > 0 && ` · 🔥 ${recipe.fuelCost} fuel`}
            </div>
          </div>
        );
      })}

      {status && (
        <div style={{ marginTop: 8, color: "rgba(79,195,247,1)", fontSize: 11 }}>{status}</div>
      )}
    </div>
  );
}
