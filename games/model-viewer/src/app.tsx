// ============================================================================
// App — React UI overlay for the model viewer
// ============================================================================

import { useEffect, useState } from "react";
import type { AnimationData, LoadedModel, ModelEntry, ModelStats } from "./model-loader";

interface ViewerState {
  models: ModelEntry[];
  currentModel: LoadedModel | null;
  loading: boolean;
  error: string | null;
  autoRotate: boolean;
  showGrid: boolean;
  wireframe: boolean;
  selectedPartIndices: Set<number> | null; // null = show all
  // Animation
  animationIndex: number | null; // null = none selected
  animationPlaying: boolean;
  animationTime: number; // seconds
  // Parts grouping
  groupMode: "tree" | "prefix";
}

interface AppProps {
  getState: () => ViewerState;
  subscribe: (fn: () => void) => () => void;
  onSelectModel: (entry: ModelEntry) => void;
  onSelectPart: (nodeIndex: number) => void;
  onSelectOnlyPart: (nodeIndex: number) => void;
  onSelectAllParts: () => void;
  onSelectAnimation: (index: number | null) => void;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSetGroupMode: (mode: "tree" | "prefix") => void;
  onToggleGroupParts: (indices: number[]) => void;
}

export default function App({
  getState,
  subscribe,
  onSelectModel,
  onSelectPart,
  onSelectOnlyPart,
  onSelectAllParts,
  onSelectAnimation,
  onTogglePlay,
  onSeek,
  onSetGroupMode,
  onToggleGroupParts,
}: AppProps) {
  const [, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    return subscribe(() => setTick((t) => t + 1));
  }, [subscribe]);

  const state = getState();
  const showPickerDialog = !state.currentModel || pickerOpen;

  const handleSelect = (entry: ModelEntry) => {
    setSelectedId(entry.id);
    onSelectModel(entry);
    setPickerOpen(false);
  };

  const toggleAutoRotate = () => {
    state.autoRotate = !state.autoRotate;
    setTick((t) => t + 1);
  };

  const toggleGrid = () => {
    state.showGrid = !state.showGrid;
    setTick((t) => t + 1);
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div style={overlayStyle}>
      {/* Top-left "Models" button — visible once a model is loaded */}
      {state.currentModel && (
        <button style={pickerBtnStyle} onClick={() => setPickerOpen(true)}>
          ☰ Models
        </button>
      )}

      {/* Model picker dialog — auto-shown when no model selected */}
      {showPickerDialog && (
        <div style={dialogBackdropStyle} onClick={() => state.currentModel && setPickerOpen(false)}>
          <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
            <div style={dialogHeaderStyle}>
              <h1 style={titleStyle}>Model Viewer</h1>
              {state.currentModel && (
                <button style={closeBtnStyle} onClick={() => setPickerOpen(false)}>✕</button>
              )}
            </div>

            {state.error && <div style={errorStyle}>{state.error}</div>}
            {state.loading && <div style={loadingStyle}>Loading...</div>}

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
        </div>
      )}

      {/* Right sidebar — full height */}
      {state.currentModel && (
        <div style={sidebarRightStyle}>
          <StatsPanel stats={state.currentModel.stats} />
          <PartsPanel
            stats={state.currentModel.stats}
            selectedPartIndices={state.selectedPartIndices}
            onSelectPart={onSelectPart}
            onSelectOnlyPart={onSelectOnlyPart}
            onSelectAllParts={onSelectAllParts}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            groupMode={state.groupMode}
            onSetGroupMode={onSetGroupMode}
            onToggleGroupParts={onToggleGroupParts}
          />
        </div>
      )}

      {/* Bottom animation panel */}
      {state.currentModel && state.currentModel.stats.animations.length > 0 && (
        <AnimationPanel
          animations={state.currentModel.stats.animations}
          animationIndex={state.animationIndex}
          playing={state.animationPlaying}
          time={state.animationTime}
          onSelect={onSelectAnimation}
          onTogglePlay={onTogglePlay}
          onSeek={onSeek}
        />
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
        <span style={infoLabelStyle}>Animations</span>
        <span style={infoValueStyle}>{stats.animations.length}</span>
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
  collapsedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  groupMode: "tree" | "prefix";
  onSetGroupMode: (mode: "tree" | "prefix") => void;
  onToggleGroupParts: (indices: number[]) => void;
}

// Strip a trailing ".<digits>" suffix to get the group prefix.
// e.g. "ash_backpack.01" -> "ash_backpack", "ash_leg.02" -> "ash_leg"
function namePrefix(name: string): string {
  return name.replace(/\.\d+$/, "");
}

function PartsPanel({
  stats,
  selectedPartIndices,
  onSelectPart,
  onSelectOnlyPart,
  onSelectAllParts,
  collapsedGroups,
  onToggleGroup,
  groupMode,
  onSetGroupMode,
  onToggleGroupParts,
}: PartsPanelProps) {
  const meshPartCount = stats.parts.filter(p => p.hasMesh).length;
  if (meshPartCount === 0) return null;

  const allSelected = selectedPartIndices === null;
  const partIsSelected = (idx: number) => allSelected || selectedPartIndices!.has(idx);

  // Count selected mesh parts for the header
  const selectedMeshCount = allSelected
    ? meshPartCount
    : stats.parts.filter(p => p.hasMesh && selectedPartIndices!.has(p.nodeIndex)).length;

  // Shared row renderer for a single part (used in both modes)
  const renderRow = (
    nodeIndex: number,
    depth: number,
    caret: "expand" | "collapse" | "none",
    onCaret?: () => void,
  ): React.ReactNode => {
    const part = stats.parts[nodeIndex];
    if (!part) return null;
    const selected = partIsSelected(nodeIndex);
    return (
      <div
        key={`row-${part.nodeIndex}`}
        style={{
          ...partEntryStyle,
          paddingLeft: 6 + depth * 14,
          ...(selected ? partEntryActiveStyle : {}),
        }}
      >
        {caret !== "none" ? (
          <button
            style={caretBtnStyle}
            onClick={onCaret}
            title={caret === "expand" ? "Expand" : "Collapse"}
          >
            {caret === "expand" ? "▶" : "▼"}
          </button>
        ) : (
          <span style={caretSpacerStyle} />
        )}
        <label style={partLabelStyle} onClick={() => onSelectPart(part.nodeIndex)}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelectPart(part.nodeIndex)}
            style={{ pointerEvents: "none" }}
          />
          <span style={partNameStyle}>{part.name || `node_${part.nodeIndex}`}</span>
        </label>
        {part.hasMesh && (
          <button
            style={soloBtnStyle}
            onClick={() => onSelectOnlyPart(part.nodeIndex)}
            title="Show only this part"
          >
            solo
          </button>
        )}
        {part.hasMesh && (
          <span style={partStatsStyle}>
            {part.vertexCount.toLocaleString()}v
          </span>
        )}
      </div>
    );
  };

  // ── Tree mode: recurse the node hierarchy ──
  const renderTreeNode = (nodeIndex: number, depth: number): React.ReactNode => {
    const part = stats.parts[nodeIndex];
    if (!part) return null;
    const hasChildren = part.children && part.children.length > 0;
    const key = `tree:${part.nodeIndex}`;
    const isCollapsed = collapsedGroups.has(key);
    return (
      <div key={`tree-${part.nodeIndex}`}>
        {renderRow(
          part.nodeIndex,
          depth,
          hasChildren ? (isCollapsed ? "expand" : "collapse") : "none",
          hasChildren ? () => onToggleGroup(key) : undefined,
        )}
        {hasChildren && !isCollapsed && part.children!.map((c) => renderTreeNode(c, depth + 1))}
      </div>
    );
  };

  // ── Prefix mode: bucket mesh parts by name prefix ──
  const prefixGroups = new Map<string, number[]>();
  for (const p of stats.parts) {
    if (!p.hasMesh) continue;
    const pref = namePrefix(p.name || `node_${p.nodeIndex}`);
    if (!prefixGroups.has(pref)) prefixGroups.set(pref, []);
    prefixGroups.get(pref)!.push(p.nodeIndex);
  }
  const sortedPrefixes = Array.from(prefixGroups.keys()).sort();

  const renderPrefixGroup = (prefix: string): React.ReactNode => {
    const indices = prefixGroups.get(prefix)!;
    // Singleton → render as a flat leaf, no group header
    if (indices.length === 1) {
      return <div key={`pfx-single-${prefix}`}>{renderRow(indices[0], 0, "none")}</div>;
    }
    const key = `prefix:${prefix}`;
    const isCollapsed = collapsedGroups.has(key);
    const allIn = indices.every((i) => partIsSelected(i));
    const totalVerts = indices.reduce((s, i) => s + (stats.parts[i]?.vertexCount ?? 0), 0);
    return (
      <div key={`pfx-${prefix}`}>
        <div style={{ ...partEntryStyle, ...(allIn ? partEntryActiveStyle : {}) }}>
          <button
            style={caretBtnStyle}
            onClick={() => onToggleGroup(key)}
            title={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? "▶" : "▼"}
          </button>
          <label style={partLabelStyle} onClick={() => onToggleGroupParts(indices)}>
            <input
              type="checkbox"
              checked={allIn}
              onChange={() => onToggleGroupParts(indices)}
              style={{ pointerEvents: "none" }}
            />
            <span style={{ ...partNameStyle, fontWeight: 600 }}>{prefix}</span>
          </label>
          <span style={partStatsStyle}>
            {indices.length}p · {totalVerts.toLocaleString()}v
          </span>
        </div>
        {!isCollapsed && indices.map((i) => renderRow(i, 1, "none"))}
      </div>
    );
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={partsHeaderStyle}>
        <span style={{ ...infoTitleStyle, marginBottom: 0 }}>
          Parts ({selectedMeshCount}/{meshPartCount})
          {!allSelected && (
            <button style={showAllBtnStyle} onClick={onSelectAllParts}>Show All</button>
          )}
        </span>
        <div style={groupToggleStyle}>
          <button
            style={groupMode === "tree" ? groupToggleBtnActiveStyle : groupToggleBtnStyle}
            onClick={() => onSetGroupMode("tree")}
            title="Group by node hierarchy"
          >
            Tree
          </button>
          <button
            style={groupMode === "prefix" ? groupToggleBtnActiveStyle : groupToggleBtnStyle}
            onClick={() => onSetGroupMode("prefix")}
            title="Group by name prefix (e.g. ash_leg.01 + ash_leg.02)"
          >
            Prefix
          </button>
        </div>
      </div>
      <div style={partsListStyle}>
        {groupMode === "tree"
          ? stats.rootNodes.map((n) => renderTreeNode(n, 0))
          : sortedPrefixes.map((p) => renderPrefixGroup(p))}
      </div>
    </div>
  );
}

interface AnimationPanelProps {
  animations: AnimationData[];
  animationIndex: number | null;
  playing: boolean;
  time: number;
  onSelect: (index: number | null) => void;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
}

function AnimationPanel({ animations, animationIndex, playing, time, onSelect, onTogglePlay, onSeek }: AnimationPanelProps) {
  const current = animationIndex !== null ? animations[animationIndex] : null;
  const duration = current?.duration ?? 0;
  const clampedTime = duration > 0 ? Math.min(time, duration) : 0;

  return (
    <div style={animPanelStyle}>
      <div style={animHeaderStyle}>
        <span style={{ ...infoTitleStyle, marginBottom: 0 }}>Animations</span>
        <span style={animCountStyle}>{animations.length}</span>
      </div>
      <div style={animBodyStyle}>
        <select
          style={animSelectStyle}
          value={animationIndex === null ? "" : String(animationIndex)}
          onChange={(e) => onSelect(e.target.value === "" ? null : Number(e.target.value))}
        >
          <option value="">— none —</option>
          {animations.map((a, i) => (
            <option key={i} value={String(i)}>{a.name || `anim_${i}`}</option>
          ))}
        </select>

        <button
          style={playBtnStyle}
          onClick={onTogglePlay}
          disabled={animationIndex === null}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>

        <input
          type="range"
          style={scrubberStyle}
          min={0}
          max={duration > 0 ? duration : 0}
          step={duration > 0 ? duration / 1000 : 1}
          value={clampedTime}
          disabled={animationIndex === null}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
        <span style={timeStyle}>
          {clampedTime.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
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

const pickerBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: 12, left: 12,
  padding: "8px 14px",
  background: "rgba(10, 10, 20, 0.85)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  color: "#4fc3f7",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  pointerEvents: "auto",
  backdropFilter: "blur(8px)",
};

const dialogBackdropStyle: React.CSSProperties = {
  position: "absolute",
  top: 0, left: 0, right: 0, bottom: 0,
  background: "rgba(0, 0, 0, 0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "auto",
  zIndex: 10,
};

const dialogStyle: React.CSSProperties = {
  width: 360,
  maxHeight: "calc(100vh - 80px)",
  overflowY: "auto",
  background: "rgba(10, 10, 20, 0.95)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 12,
  padding: 16,
  backdropFilter: "blur(12px)",
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};

const dialogHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
};

const closeBtnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  color: "#aaa",
  cursor: "pointer",
  fontSize: 14,
  padding: "2px 8px",
  lineHeight: 1,
};

const titleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: 0,
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

// Right sidebar — full height
const sidebarRightStyle: React.CSSProperties = {
  position: "absolute",
  top: 0, right: 0, bottom: 0,
  width: 320,
  overflowY: "auto",
  background: "rgba(10, 10, 20, 0.9)",
  borderLeft: "1px solid rgba(255,255,255,0.1)",
  padding: 16,
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
  maxHeight: "calc(100vh - 360px)",
  overflowY: "auto",
};

const partsHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8,
};

const groupToggleStyle: React.CSSProperties = {
  display: "flex",
  gap: 0,
  flexShrink: 0,
};

const groupToggleBtnStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "2px 8px",
  background: "rgba(255,255,255,0.05)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(255,255,255,0.1)",
  color: "#888",
  cursor: "pointer",
};

const groupToggleBtnActiveStyle: React.CSSProperties = {
  fontSize: 9,
  padding: "2px 8px",
  background: "rgba(79,195,247,0.2)",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(79,195,247,0.4)",
  color: "#4fc3f7",
  cursor: "pointer",
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

const caretBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#888",
  cursor: "pointer",
  fontSize: 9,
  padding: 0,
  width: 12,
  flexShrink: 0,
  lineHeight: 1,
};

const caretSpacerStyle: React.CSSProperties = {
  display: "inline-block",
  width: 12,
  flexShrink: 0,
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

// Bottom animation panel
const animPanelStyle: React.CSSProperties = {
  position: "absolute",
  left: 0, right: 320, bottom: 0,
  background: "rgba(10, 10, 20, 0.9)",
  borderTop: "1px solid rgba(255,255,255,0.1)",
  padding: "8px 16px",
  pointerEvents: "auto",
  backdropFilter: "blur(8px)",
};

const animHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const animCountStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
};

const animBodyStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const animSelectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  color: "#e0e0e0",
  fontSize: 12,
  padding: "4px 8px",
  minWidth: 160,
  flexShrink: 0,
};

const playBtnStyle: React.CSSProperties = {
  background: "rgba(79,195,247,0.15)",
  border: "1px solid rgba(79,195,247,0.3)",
  borderRadius: 4,
  color: "#4fc3f7",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 10px",
  flexShrink: 0,
};

const scrubberStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  cursor: "pointer",
};

const timeStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#aaa",
  fontVariantNumeric: "tabular-nums",
  flexShrink: 0,
  minWidth: 120,
  textAlign: "right",
};
