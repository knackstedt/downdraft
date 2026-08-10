import { useCallback, useEffect, useRef, useState } from "react";
import { MATERIALS } from "./simulation/materials";
import { useGameStore, type FieldType } from "./stores/game-store";
import {
    captureThumbnail, deleteSave, listSaves, loadGame, saveGame,
} from "./stores/save-system";

const materialNames = [
  "Empty", "Sand", "Water", "Stone", "Wood", "Fire", "Smoke",
  "Oil", "Gunpowder", "Iron", "Lava", "Steam", "Plant", "Flesh",
  "Dirt", "Seed", "Leaf", "Antimatter", "???", "Flour",
  "Gasoline", "Gas Vapor", "Hydrogen", "Plastic", "Toast", "Salt",
  "Wall", "Fireflies", "Grass", "Snow", "Honey", "Mercury",
  "Fuse", "C4", "Dynamite", "Wax", "Concrete Powder", "Dry Ice",
  "Liquid Nitrogen", "Plasma", "Nanobots", "Magic Powder", "Glitter",
  "Popcorn", "Rubber", "Root", "Brine", "Molten Salt", "Concrete", "Tree Wood",
  "Fuse Fire",
];

/** Convert a material's float color [0-1] to a CSS rgb string. */
function matColorCss(mat: number): string {
  const c = MATERIALS[mat]?.color;
  if (!c) return "rgb(0,0,0)";
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

const overlayStyle: React.CSSProperties = {
  position: "absolute", inset: 0, pointerEvents: "none",
};

const panelStyle: React.CSSProperties = {
  position: "absolute", top: 8, left: 8,
  color: "rgba(255,255,255,0.8)", fontFamily: "monospace", fontSize: 12,
  pointerEvents: "auto", padding: 8, background: "rgba(0,0,0,0.5)", borderRadius: 4,
};

const selectStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.8)", color: "white", fontSize: 12,
  padding: 4, marginTop: 4, borderRadius: 4, border: "1px solid rgba(255,255,255,0.2)",
};

const helpStyle: React.CSSProperties = {
  position: "absolute", bottom: 8, left: 8,
  color: "rgba(255,255,255,0.6)", fontFamily: "monospace", fontSize: 12,
  padding: 8, background: "rgba(0,0,0,0.5)", borderRadius: 4,
};

const settingsPanelStyle: React.CSSProperties = {
  position: "absolute", top: 8, right: 8,
  color: "rgba(255,255,255,0.8)", fontFamily: "monospace", fontSize: 12,
  pointerEvents: "auto", padding: 12, background: "rgba(0,0,0,0.7)",
  borderRadius: 4, minWidth: 280, maxHeight: "calc(100vh - 16px)", overflowY: "auto",
};

const savesPanelStyle: React.CSSProperties = {
  ...settingsPanelStyle,
  minWidth: 360,
};

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.1)", color: "white", fontSize: 12,
  padding: "4px 8px", borderRadius: 4, border: "1px solid rgba(255,255,255,0.2)",
  cursor: "pointer", marginTop: 4,
};

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: "rgba(79,195,247,0.3)",
  border: "1px solid rgba(79,195,247,0.6)",
};

const dangerBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: "rgba(244,67,54,0.2)",
  border: "1px solid rgba(244,67,54,0.5)",
};

const sectionLabelStyle: React.CSSProperties = {
  fontWeight: "bold", marginTop: 12, marginBottom: 4,
  color: "rgba(255,255,255,0.9)",
  borderBottom: "1px solid rgba(255,255,255,0.15)", paddingBottom: 2,
};

const sliderRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, marginTop: 6,
};

const sliderStyle: React.CSSProperties = { flex: 1, accentColor: "#4fc3f7" };

const saveEntryStyle: React.CSSProperties = {
  display: "flex", gap: 8, alignItems: "center", padding: "6px 0",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
};

const thumbStyle: React.CSSProperties = {
  width: 80, height: "auto", objectFit: "contain", borderRadius: 2,
  border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0,
};

const inspectorStyle: React.CSSProperties = {
  position: "absolute", bottom: 8, right: 8,
  color: "rgba(255,255,255,0.85)", fontFamily: "monospace", fontSize: 11,
  padding: 8, background: "rgba(0,0,0,0.6)", borderRadius: 4,
  minWidth: 200, pointerEvents: "none",
};

const toolbarStyle: React.CSSProperties = {
  position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
  display: "flex", flexWrap: "wrap", gap: 2,
  padding: 4, background: "rgba(0,0,0,0.7)", borderRadius: 4,
  pointerEvents: "auto", maxWidth: "calc(100vw - 360px)",
  maxHeight: 120, overflowY: "auto",
};

const swatchStyle: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 3, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.15)",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 9, color: "rgba(255,255,255,0.7)", fontFamily: "monospace",
  flexShrink: 0, position: "relative",
};

const swatchActiveStyle: React.CSSProperties = {
  ...swatchStyle,
  border: "2px solid #4fc3f7",
  boxShadow: "0 0 4px rgba(79,195,247,0.6)",
};

const tooltipStyle: React.CSSProperties = {
  position: "fixed",
  background: "rgba(0,0,0,0.9)",
  color: "white",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.25)",
  pointerEvents: "none",
  zIndex: 1000,
  whiteSpace: "nowrap",
};

const brushCircleStyle: React.CSSProperties = {
  position: "fixed",
  borderRadius: "50%",
  border: "1.5px solid rgba(255,255,255,0.6)",
  background: "rgba(255,255,255,0.08)",
  pointerEvents: "none",
  zIndex: 999,
  transform: "translate(-50%, -50%)",
};

const inspectorRowStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", gap: 12,
};

const inspectorLabelStyle: React.CSSProperties = {
  color: "rgba(255,255,255,0.5)",
};

const inspectorHeaderStyle: React.CSSProperties = {
  fontWeight: "bold", marginBottom: 4, paddingBottom: 2,
  borderBottom: "1px solid rgba(255,255,255,0.15)",
  color: "rgba(255,255,255,0.9)",
};

function Slider({ label, min, max, step, value, display, onChange }: {
  label: string; min: number; max: number; step: number; value: number;
  display: string; onChange: (v: number) => void;
}) {
  return (
    <div style={sliderRowStyle}>
      <span style={{ width: 70 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        style={sliderStyle} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span style={{ width: 50, textAlign: "right" }}>{display}</span>
    </div>
  );
}

const fieldTypes: { value: FieldType; label: string }[] = [
  { value: "gravity", label: "Gravity" },
  { value: "temperature", label: "Temperature" },
  { value: "windX", label: "Wind X" },
  { value: "windY", label: "Wind Y" },
];

export default function App() {
  const {
    fps, selectedMaterial, health, paused, settings, showSettings,
    brushMode, fieldType, fieldGravity, fieldTemperature, fieldWindX, fieldWindY,
    showFieldOverlay, activeLayer, renderer, saves, showSaves, inspector, brushRadius,
  } = useGameStore();
  const setSettings = useGameStore((s) => s.setSettings);
  const setShowSettings = useGameStore((s) => s.setShowSettings);
  const setBrushMode = useGameStore((s) => s.setBrushMode);
  const setFieldType = useGameStore((s) => s.setFieldType);
  const setFieldGravity = useGameStore((s) => s.setFieldGravity);
  const setFieldTemperature = useGameStore((s) => s.setFieldTemperature);
  const setFieldWindX = useGameStore((s) => s.setFieldWindX);
  const setFieldWindY = useGameStore((s) => s.setFieldWindY);
  const setShowFieldOverlay = useGameStore((s) => s.setShowFieldOverlay);
  const setActiveLayer = useGameStore((s) => s.setActiveLayer);
  const setSaves = useGameStore((s) => s.setSaves);
  const setShowSaves = useGameStore((s) => s.setShowSaves);
  const setBrushRadius = useGameStore((s) => s.setBrushRadius);
  const [selected, setSelected] = useState(selectedMaterial);
  const [saveName, setSaveName] = useState("");
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const brushRef = useRef<HTMLDivElement | null>(null);
  const cellCssPxRef = useRef(0);

  // Recompute cell size (CSS px per grid cell) when renderer or brush radius changes.
  // This is the only thing that needs React — mouse moves are handled via direct DOM.
  useEffect(() => {
    if (!renderer) return;
    const canvas = renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    cellCssPxRef.current = rect.width / renderer.getGridW();
    const diameter = (brushRadius + 0.5) * 2 * cellCssPxRef.current;
    if (brushRef.current) {
      brushRef.current.style.width = `${diameter}px`;
      brushRef.current.style.height = `${diameter}px`;
    }
  }, [renderer, brushRadius]);

  // Track mouse position via direct DOM manipulation — no React state updates on mousemove.
  // This avoids re-rendering the entire App component 60-120 times per second.
  useEffect(() => {
    const canvas = useGameStore.getState().renderer?.getCanvas() ?? null;
    const onMove = (e: MouseEvent) => {
      const el = brushRef.current;
      if (!el) return;
      const onCanvas = e.target === canvas;
      if (onCanvas) {
        el.style.display = "block";
        el.style.left = `${e.clientX}px`;
        el.style.top = `${e.clientY}px`;
        if (canvas) canvas.style.cursor = "none";
      } else {
        el.style.display = "none";
        if (canvas) canvas.style.cursor = "default";
      }
    };
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget === null) {
        if (brushRef.current) brushRef.current.style.display = "none";
        if (canvas) canvas.style.cursor = "default";
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseout", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      if (canvas) canvas.style.cursor = "default";
    };
  }, [renderer]);

  useEffect(() => {
    useGameStore.getState().setSelectedMaterial(selected);
  }, [selected]);

  const refreshSaves = useCallback(async () => {
    try {
      const list = await listSaves();
      setSaves(list);
    } catch (e) {
      console.error("Failed to list saves:", e);
    }
  }, [setSaves]);

  const handleSave = useCallback(async () => {
    if (!renderer) return;
    try {
      const canvas = renderer.getCanvas();
      const thumb = await captureThumbnail(canvas);
      const { grids, fields, gridW, gridH } = renderer.snapshotGrids();
      const name = saveName.trim() || `Save ${new Date().toLocaleString()}`;
      await saveGame(name, thumb, gridW, gridH, grids, fields);
      setSaveName("");
      await refreshSaves();
    } catch (e) {
      console.error("[save] Failed:", e);
    }
  }, [renderer, saveName, refreshSaves]);

  const handleLoad = useCallback(async (id: string) => {
    if (!renderer) return;
    try {
      const entry = await loadGame(id);
      if (!entry) return;
      await renderer.loadSave(entry.grids, entry.fields, entry.gridW, entry.gridH);
    } catch (e) {
      console.error("Failed to load:", e);
    }
  }, [renderer]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteSave(id);
      await refreshSaves();
    } catch (e) {
      console.error("Failed to delete save:", e);
    }
  }, [refreshSaves]);

  const handleClear = useCallback(() => {
    renderer?.clearAll();
  }, [renderer]);

  const handleToggleSaves = useCallback(() => {
    const next = !showSaves;
    setShowSaves(next);
    if (next) refreshSaves();
  }, [showSaves, setShowSaves, refreshSaves]);

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div>FPS: {fps ?? 0}</div>
        <div>Health: {health}</div>

        {/* Brush mode toggle */}
        <div style={{ marginTop: 6, display: "flex", gap: 4 }}>
          <button
            style={brushMode === "material" ? activeBtnStyle : btnStyle}
            onClick={() => setBrushMode("material")}
          >Material</button>
          <button
            style={brushMode === "field" ? activeBtnStyle : btnStyle}
            onClick={() => setBrushMode("field")}
          >Field</button>
        </div>

        {/* Layer selector */}
        <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
          <button
            style={activeLayer === 0 ? activeBtnStyle : btnStyle}
            onClick={() => setActiveLayer(0)}
          >Layer 0 (back)</button>
          <button
            style={activeLayer === 1 ? activeBtnStyle : btnStyle}
            onClick={() => setActiveLayer(1)}
          >Layer 1 (front)</button>
        </div>

        {brushMode === "material" ? (
          <div>Material: {materialNames[selected] ?? "Unknown"}</div>
        ) : (
          <>
            <div style={{ marginTop: 4 }}>Field Type:</div>
            <select style={selectStyle} value={fieldType}
              onChange={(e) => setFieldType(e.target.value as FieldType)}>
              {fieldTypes.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            {fieldType === "gravity" && (
              <Slider label="Gravity" min={0} max={255} step={1} value={fieldGravity}
                display={`${(fieldGravity / 128).toFixed(2)}×`}
                onChange={setFieldGravity} />
            )}
            {fieldType === "temperature" && (
              <Slider label="Temp" min={0} max={255} step={1} value={fieldTemperature}
                display={`${(fieldTemperature / 128).toFixed(2)}`}
                onChange={setFieldTemperature} />
            )}
            {fieldType === "windX" && (
              <Slider label="Wind X" min={-128} max={127} step={1} value={fieldWindX}
                display={fieldWindX.toString()}
                onChange={setFieldWindX} />
            )}
            {fieldType === "windY" && (
              <Slider label="Wind Y" min={-128} max={127} step={1} value={fieldWindY}
                display={fieldWindY.toString()}
                onChange={setFieldWindY} />
            )}
            <button
              style={showFieldOverlay ? activeBtnStyle : btnStyle}
              onClick={() => setShowFieldOverlay(!showFieldOverlay)}
            >{showFieldOverlay ? "Hide Fields" : "Show Fields"}</button>
          </>
        )}

        <Slider label="Brush" min={0} max={20} step={1} value={brushRadius}
          display={brushRadius.toString()}
          onChange={setBrushRadius} />

        {paused && <div style={{ color: "yellow" }}>PAUSED</div>}

        {/* Save / Load / Clear buttons */}
        <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button style={btnStyle} onClick={handleSave}>Save</button>
          <button style={btnStyle} onClick={handleToggleSaves}>
            {showSaves ? "Close Saves" : "Load"}
          </button>
          <button style={dangerBtnStyle} onClick={handleClear}>Clear</button>
        </div>
        {showSaves && (
          <input
            type="text"
            placeholder="Save name (optional)"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            style={{
              ...selectStyle, marginTop: 4, width: "100%",
              boxSizing: "border-box",
            }}
          />
        )}

        <button style={btnStyle} onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? "Close Settings" : "Settings"}
        </button>
      </div>

      {/* Material toolbar — color swatch grid (only in material brush mode) */}
      {brushMode === "material" && (
        <div style={toolbarStyle}>
          {materialNames.map((name, i) => (
            <div
              key={i}
              style={selected === i ? swatchActiveStyle : swatchStyle}
              onMouseEnter={(e) => setTooltip({ text: `${i}: ${name}`, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setTooltip({ text: `${i}: ${name}`, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => setSelected(i)}
            >
              <div style={{
                position: "absolute", inset: 2, borderRadius: 2,
                background: matColorCss(i),
                opacity: MATERIALS[i]?.color?.[3] ?? 1,
              }} />
            </div>
          ))}
        </div>
      )}

      {/* Real DOM tooltip for material swatches */}
      {tooltip && (
        <div style={{
          ...tooltipStyle,
          left: tooltip.x + 14,
          top: tooltip.y + 14,
        }}>{tooltip.text}</div>
      )}

      {/* Phantom brush circle — positioned via direct DOM in mousemove (no React re-render) */}
      <div ref={brushRef} style={{ ...brushCircleStyle, display: "none" }} />

      {/* Cell inspector — live readout of cell under cursor */}
      <div style={inspectorStyle}>
        <div style={inspectorHeaderStyle}>Cell Inspector</div>
        {inspector.valid ? (
          <>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Position</span>
              <span>({inspector.gx}, {inspector.gy}) L{inspector.layer}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Material</span>
              <span>{inspector.mat}: {inspector.matName}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Lifetime</span>
              <span>{inspector.lifetime}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Shade</span>
              <span>{inspector.shade}/3</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Gravity</span>
              <span>{inspector.gravityMult.toFixed(2)}× ({inspector.gravity})</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Temp</span>
              <span>{inspector.temperatureMult.toFixed(2)} ({inspector.temperature})</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Wind X</span>
              <span>{inspector.windX}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Wind Y</span>
              <span>{inspector.windY}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Wind Mag</span>
              <span>{inspector.windMag.toFixed(1)}</span>
            </div>
            <div style={inspectorRowStyle}>
              <span style={inspectorLabelStyle}>Wind Dir</span>
              <span>{inspector.windDir.toFixed(0)}°</span>
            </div>
          </>
        ) : (
          <div style={{ color: "rgba(255,255,255,0.4)" }}>Hover over the grid</div>
        )}
      </div>

      {showSettings && (
        <div style={settingsPanelStyle}>
          <div style={{ fontWeight: "bold", marginBottom: 4 }}>Impulse Settings</div>
          <Slider label="Chance" min={0} max={0.2} step={0.005}
            value={settings.horizontalImpulseChance}
            display={`${(settings.horizontalImpulseChance * 100).toFixed(1)}%`}
            onChange={(v) => setSettings({ horizontalImpulseChance: v })} />
          <Slider label="Force" min={0} max={5} step={0.5}
            value={settings.horizontalImpulseStrength}
            display={settings.horizontalImpulseStrength.toFixed(1)}
            onChange={(v) => setSettings({ horizontalImpulseStrength: v })} />
        </div>
      )}

      {showSaves && (
        <div style={savesPanelStyle}>
          <div style={{ fontWeight: "bold", marginBottom: 4 }}>Saves</div>
          {saves.length === 0 && (
            <div style={{ color: "rgba(255,255,255,0.5)", padding: "8px 0" }}>
              No saves yet. Click "Save" to create one.
            </div>
          )}
          {saves.map((save) => (
            <div key={save.id} style={saveEntryStyle}>
              <img src={save.thumbnailUrl} style={thumbStyle} alt="thumbnail" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>{save.name}</div>
                <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10 }}>
                  {new Date(save.timestamp).toLocaleString()} • {save.gridW}×{save.gridH}
                </div>
              </div>
              <button style={btnStyle} onClick={() => handleLoad(save.id)}>Load</button>
              <button style={dangerBtnStyle} onClick={() => handleDelete(save.id)}>Del</button>
            </div>
          ))}
        </div>
      )}

      <div style={helpStyle}>
        WASD / Space • Left-click paint {brushMode === "field" ? "field" : "material"} • Right-click ignite • Middle-click pick material
      </div>
    </div>
  );
}
