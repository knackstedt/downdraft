// ============================================================================
// App — React UI overlay for the model viewer
// ============================================================================

import { useEffect, useState } from "react";
import type { LoadedModel, ModelEntry, ModelStats } from "./model-loader";

interface ViewerState {
  models: ModelEntry[];
  currentModel: LoadedModel | null;
  loading: boolean;
  error: string | null;
  autoRotate: boolean;
  showGrid: boolean;
  wireframe: boolean;
  selectedPartIndices: Set<number> | null; // null = show all
}

interface AppProps {
  getState: () => ViewerState;
  subscribe: (fn: () => void) => () => void;
  onSelectModel: (entry: ModelEntry) => void;
  onSelectPart: (nodeIndex: number) => void;
  onSelectOnlyPart: (nodeIndex: number) => void;
  onSelectAllParts: () => void;
}

export default function App({ getState, subscribe, onSelectModel, onSelectPart, onSelectOnlyPart, onSelectAllParts }: AppProps) {
  const [, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    return subscribe(() => setTick((t) => t + 1));
  }, [subscribe]);

  const state = getState();

  const handleSelect = (entry: ModelEntry) => {
    setSelectedId(entry.id);
    onSelectModel(entry);
  };

  const toggleAutoRotate = () => {
    state.autoRotate = !state.autoRotate;
    setTick((t) => t + 1);
  };

  const toggleGrid = () => {
    state.showGrid = !state.showGrid;
    setTick((t) => t + 1);
  };

  return (
    <div style={overlayStyle}>
      {/* Sidebar */}
      <div style={sidebarStyle}>
        <h1 style={titleStyle}>Model Viewer</h1>

        {state.error && (
          <div style={errorStyle}>{state.error}</div>
        )}

        {state.loading && (
          <div style={loadingStyle}>Loading...</div>
        )}

        <div style={sectionTitleStyle}>Models ({state.models.length})</div>
        <div style={modelListStyle}>
          {state.models.map((entry) => (
            <div
              key={entry.id}
              onClick={() => handleSelect(entry)}
              style={{
                ...modelEntryStyle,
                ...(selectedId === entry.id ? modelEntryActiveStyle : {}),
              }}
            >
              <div style={modelEntryNameStyle}>{entry.name}</div>
              <div style={modelEntrySourceStyle}>{entry.source}</div>
            </div>
          ))}
          {state.models.length === 0 && !state.loading && (
            <div style={emptyStyle}>No models found</div>
          )}
        </div>

        {/* Controls */}
        <div style={sectionTitleStyle}>Controls</div>
        <div style={controlsStyle}>
          <label style={labelStyle}>
            <input type="checkbox" checked={state.autoRotate} onChange={toggleAutoRotate} />
            Auto-rotate
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={state.showGrid} onChange={toggleGrid} />
            Show grid
          </label>
        </div>

        <div style={hintStyle}>
          Drag: rotate | Shift+Drag: pan | Scroll: zoom
        </div>
      </div>

      {/* Info panel */}
      {state.currentModel && (
        <div style={infoPanelStyle}>
          <StatsPanel stats={state.currentModel.stats} />
          <PartsPanel
            stats={state.currentModel.stats}
            selectedPartIndices={state.selectedPartIndices}
            onSelectPart={onSelectPart}
            onSelectOnlyPart={onSelectOnlyPart}
            onSelectAllParts={onSelectAllParts}
          />
        </div>
      )}
    </div>
  );
}

function StatsPanel({ stats }: { stats: ModelStats }) {
  return (
    <div>
      <div style={infoTitleStyle}>Model Info</div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Meshes</span>
        <span style={infoValueStyle}>{stats.meshCount}</span>
      </div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Vertices</span>
        <span style={infoValueStyle}>{stats.totalVertices.toLocaleString()}</span>
      </div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Triangles</span>
        <span style={infoValueStyle}>{stats.totalTriangles.toLocaleString()}</span>
      </div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Texture</span>
        <span style={infoValueStyle}>{stats.hasTexture ? "yes" : "no"}</span>
      </div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Skin</span>
        <span style={infoValueStyle}>{stats.hasSkin ? `yes (${stats.boneCount} bones)` : "no"}</span>
      </div>
      <div style={infoRowStyle}>
        <span style={infoLabelStyle}>Bounds</span>
        <span style={infoValueStyle}>
          {(stats.bounds.max[0] - stats.bounds.min[0]).toFixed(1)} x{" "}
          {(stats.bounds.max[1] - stats.bounds.min[1]).toFixed(1)} x{" "}
          {(stats.bounds.max[2] - stats.bounds.min[2]).toFixed(1)}
        </span>
      </div>
    </div>
  );
}

interface PartsPanelProps {
  stats: ModelStats;
  selectedPartIndices: Set<number> | null;
  onSelectPart: (nodeIndex: number) => void;
  onSelectOnlyPart: (nodeIndex: number) => void;
  onSelectAllParts: () => void;
}

function PartsPanel({ stats, selectedPartIndices, onSelectPart, onSelectOnlyPart, onSelectAllParts }: PartsPanelProps) {
  const meshParts = stats.parts.filter(p => p.hasMesh);
  if (meshParts.length === 0) return null;

  const allSelected = selectedPartIndices === null;
  const partIsSelected = (idx: number) => allSelected || selectedPartIndices!.has(idx);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={infoTitleStyle}>
        Parts ({meshParts.length})
        {!allSelected && (
          <button style={showAllBtnStyle} onClick={onSelectAllParts}>Show All</button>
        )}
      </div>
      <div style={partsListStyle}>
        {meshParts.map((part) => (
          <div
            key={part.nodeIndex}
            style={{
              ...partEntryStyle,
              ...(partIsSelected(part.nodeIndex) ? partEntryActiveStyle : {}),
            }}
          >
            <label style={partLabelStyle} onClick={() => onSelectPart(part.nodeIndex)}>
              <input
                type="checkbox"
                checked={partIsSelected(part.nodeIndex)}
                onChange={() => onSelectPart(part.nodeIndex)}
                style={{ pointerEvents: "none" }}
              />
              <span style={partNameStyle}>{part.name}</span>
            </label>
            <button
              style={soloBtnStyle}
              onClick={() => onSelectOnlyPart(part.nodeIndex)}
              title="Show only this part"
            >
              solo
            </button>
            <span style={partStatsStyle}>
              {part.vertexCount.toLocaleString()}v
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Styles ──

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 0, left: 0, right: 0, bottom: 0,
  pointerEvents: "none",
  fontFamily: "system-ui, -apple-system, sans-serif",
  color: "#e0e0e0",
};

const sidebarStyle: React.CSSProperties = {
  position: "absolute",
  top: 12, left: 12,
  width: 240,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  background: "rgba(10, 10, 20, 0.85)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: 12,
  pointerEvents: "auto",
  backdropFilter: "blur(8px)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: "0 0 12px 0",
  color: "#4fc3f7",
};

const errorStyle: React.CSSProperties = {
  color: "#ef5350",
  fontSize: 12,
  marginBottom: 8,
  padding: "6px 8px",
  background: "rgba(239,83,80,0.1)",
  borderRadius: 4,
};

const loadingStyle: React.CSSProperties = {
  color: "#ffb74d",
  fontSize: 12,
  marginBottom: 8,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  color: "#888",
  margin: "12px 0 6px 0",
  letterSpacing: 1,
};

const modelListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const modelEntryStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  cursor: "pointer",
  background: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  transition: "all 0.15s",
};

const modelEntryActiveStyle: React.CSSProperties = {
  background: "rgba(79,195,247,0.15)",
  borderColor: "rgba(79,195,247,0.4)",
};

const modelEntryNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const modelEntrySourceStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#888",
  marginTop: 2,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#666",
  padding: "8px 0",
};

const controlsStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  display: "flex",
  alignItems: "center",
  gap: 6,
  cursor: "pointer",
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#666",
  marginTop: 12,
  lineHeight: 1.5,
};

const infoPanelStyle: React.CSSProperties = {
  position: "absolute",
  top: 12, right: 12,
  width: 280,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  background: "rgba(10, 10, 20, 0.85)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: 12,
  pointerEvents: "auto",
  backdropFilter: "blur(8px)",
};

const infoTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  color: "#888",
  marginBottom: 8,
  letterSpacing: 1,
};

const infoRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
  padding: "3px 0",
};

const infoLabelStyle: React.CSSProperties = {
  color: "#aaa",
};

const infoValueStyle: React.CSSProperties = {
  color: "#e0e0e0",
  fontWeight: 500,
};

const partsListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  maxHeight: 300,
  overflowY: "auto",
};

const partEntryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 6px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.03)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  transition: "all 0.15s",
};

const partEntryActiveStyle: React.CSSProperties = {
  background: "rgba(79,195,247,0.1)",
  borderColor: "rgba(79,195,247,0.3)",
};

const partLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  cursor: "pointer",
  flex: 1,
  minWidth: 0,
  fontSize: 11,
};

const partNameStyle: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
};

const soloBtnStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 6px",
  background: "rgba(255,255,255,0.1)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(255,255,255,0.15)",
  borderRadius: 3,
  color: "#aaa",
  cursor: "pointer",
  flexShrink: 0,
};

const showAllBtnStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "1px 6px",
  marginLeft: 6,
  background: "rgba(79,195,247,0.15)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(79,195,247,0.3)",
  borderRadius: 3,
  color: "#4fc3f7",
  cursor: "pointer",
  verticalAlign: "middle",
};

const partStatsStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#666",
  flexShrink: 0,
};
