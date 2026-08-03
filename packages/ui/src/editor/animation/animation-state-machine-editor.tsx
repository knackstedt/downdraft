import React, { useState, useCallback } from "react";

export interface AnimStateData {
  id: string;
  name: string;
  clipName: string;
  x: number;
  y: number;
  speed: number;
  isDefault: boolean;
}

export interface AnimTransitionData {
  id: string;
  fromState: string;
  toState: string;
  condition: string;
  blendDuration: number;
  blendType: "crossfade" | "immediate";
}

export interface BlendTree1DData {
  parameter: string;
  thresholds: Array<{ value: number; clipName: string }>;
}

export interface BlendTree2DData {
  paramX: string;
  paramY: string;
  nodes: Array<{ x: number; y: number; clipName: string }>;
}

export interface AnimationStateMachineEditorProps {
  states: AnimStateData[];
  transitions: AnimTransitionData[];
  parameters: Array<{ name: string; type: "float" | "bool" | "int"; value: number | boolean }>;
  onStatesChange?: (states: AnimStateData[]) => void;
  onTransitionsChange?: (transitions: AnimTransitionData[]) => void;
  onParametersChange?: (params: Array<{ name: string; type: "float" | "bool" | "int"; value: number | boolean }>) => void;
}

let stateIdCounter = 0;
let transIdCounter = 0;

const STATE_W = 140;
const STATE_H = 60;

export const AnimationStateMachineEditor: React.FC<AnimationStateMachineEditorProps> = ({
  states,
  transitions,
  parameters,
  onStatesChange,
  onTransitionsChange,
  onParametersChange,
}) => {
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [selectedTransition, setSelectedTransition] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const [showParamForm, setShowParamForm] = useState(false);
  const [newParamName, setNewParamName] = useState("");
  const [newParamType, setNewParamType] = useState<"float" | "bool" | "int">("float");
  const canvasRef = React.useRef<HTMLDivElement>(null);

  const handleStateMouseDown = useCallback((e: React.MouseEvent, state: AnimStateData) => {
    if (e.button !== 0) return;
    setSelectedState(state.id);
    setSelectedTransition(null);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging({
      id: state.id,
      offsetX: e.clientX - rect.left - state.x,
      offsetY: e.clientY - rect.top - state.y,
    });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left - dragging.offsetX;
      const y = e.clientY - rect.top - dragging.offsetY;
      onStatesChange?.(states.map((s) => (s.id === dragging.id ? { ...s, x, y } : s)));
    } else if (connecting) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setConnecting({ ...connecting, x: e.clientX - rect.left, y: e.clientY - rect.top });
    }
  }, [dragging, connecting, states, onStatesChange]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    if (connecting) setConnecting(null);
  }, [connecting]);

  const addState = useCallback(() => {
    const id = `state_${stateIdCounter++}`;
    const name = `State ${states.length + 1}`;
    onStatesChange?.([...states, {
      id,
      name,
      clipName: "idle",
      x: 150 + Math.random() * 200,
      y: 100 + Math.random() * 100,
      speed: 1,
      isDefault: states.length === 0,
    }]);
  }, [states, onStatesChange]);

  const deleteState = useCallback((id: string) => {
    onStatesChange?.(states.filter((s) => s.id !== id));
    onTransitionsChange?.(transitions.filter((t) => t.fromState !== id && t.toState !== id));
    setSelectedState(null);
  }, [states, transitions, onStatesChange, onTransitionsChange]);

  const startConnecting = useCallback((e: React.MouseEvent, stateId: string) => {
    e.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const state = states.find((s) => s.id === stateId);
    if (!state) return;
    setConnecting({ fromId: stateId, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, [states]);

  const finishConnecting = useCallback((e: React.MouseEvent, targetId: string) => {
    e.stopPropagation();
    if (!connecting || connecting.fromId === targetId) {
      setConnecting(null);
      return;
    }
    const id = `trans_${transIdCounter++}`;
    onTransitionsChange?.([...transitions, {
      id,
      fromState: connecting.fromId,
      toState: targetId,
      condition: "true",
      blendDuration: 0.2,
      blendType: "crossfade",
    }]);
    setConnecting(null);
  }, [connecting, transitions, onTransitionsChange]);

  const deleteTransition = useCallback((id: string) => {
    onTransitionsChange?.(transitions.filter((t) => t.id !== id));
    setSelectedTransition(null);
  }, [transitions, onTransitionsChange]);

  const setDefaultState = useCallback((id: string) => {
    onStatesChange?.(states.map((s) => ({ ...s, isDefault: s.id === id })));
  }, [states, onStatesChange]);

  const addParameter = useCallback(() => {
    if (!newParamName.trim()) return;
    const param = {
      name: newParamName.trim(),
      type: newParamType,
      value: newParamType === "bool" ? false : 0,
    };
    onParametersChange?.([...parameters, param]);
    setNewParamName("");
    setShowParamForm(false);
  }, [newParamName, newParamType, parameters, onParametersChange]);

  const deleteParameter = useCallback((name: string) => {
    onParametersChange?.(parameters.filter((p) => p.name !== name));
  }, [parameters, onParametersChange]);

  const updateTransition = useCallback((id: string, updates: Partial<AnimTransitionData>) => {
    onTransitionsChange?.(transitions.map((t) => (t.id === id ? { ...t, ...updates } : t)));
  }, [transitions, onTransitionsChange]);

  const getStateCenter = (state: AnimStateData) => ({
    x: state.x + STATE_W / 2,
    y: state.y + STATE_H / 2,
  });

  const renderTransition = (trans: AnimTransitionData) => {
    const from = states.find((s) => s.id === trans.fromState);
    const to = states.find((s) => s.id === trans.toState);
    if (!from || !to) return null;
    const fc = getStateCenter(from);
    const tc = getStateCenter(to);
    const isSelected = selectedTransition === trans.id;

    // Arrow direction
    const dx = tc.x - fc.x;
    const dy = tc.y - fc.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return null;
    const nx = dx / len;
    const ny = dy / len;

    // Adjust endpoints to state borders
    const fromBorder = {
      x: fc.x + nx * STATE_W / 2,
      y: fc.y + ny * STATE_H / 2,
    };
    const toBorder = {
      x: tc.x - nx * STATE_W / 2,
      y: tc.y - ny * STATE_H / 2,
    };

    const midX = (fromBorder.x + toBorder.x) / 2;
    const midY = (fromBorder.y + toBorder.y) / 2;
    const arrowSize = 8;
    const angle = Math.atan2(ny, nx);

    return (
      <g key={trans.id} onClick={(e) => { e.stopPropagation(); setSelectedTransition(trans.id); setSelectedState(null); }} style={{ cursor: "pointer" }}>
        <line
          x1={fromBorder.x} y1={fromBorder.y}
          x2={toBorder.x} y2={toBorder.y}
          stroke={isSelected ? "#fa8" : "#666"}
          strokeWidth={isSelected ? 3 : 2}
          markerEnd="url(#arrowhead)"
        />
        <polygon
          points={`${toBorder.x},${toBorder.y} ${toBorder.x - arrowSize * Math.cos(angle - 0.4)},${toBorder.y - arrowSize * Math.sin(angle - 0.4)} ${toBorder.x - arrowSize * Math.cos(angle + 0.4)},${toBorder.y - arrowSize * Math.sin(angle + 0.4)}`}
          fill={isSelected ? "#fa8" : "#666"}
        />
        <text x={midX} y={midY - 6} fill="#888" fontSize={10} textAnchor="middle">
          {trans.condition}
        </text>
      </g>
    );
  };

  const renderState = (state: AnimStateData) => {
    const isSelected = selectedState === state.id;
    return (
      <div
        key={state.id}
        onMouseDown={(e) => handleStateMouseDown(e, state)}
        onMouseUp={(e) => { if (connecting) finishConnecting(e, state.id); }}
        style={{
          position: "absolute",
          left: state.x,
          top: state.y,
          width: STATE_W,
          height: STATE_H,
          background: state.isDefault ? "rgba(40, 60, 40, 0.95)" : "rgba(30, 30, 35, 0.95)",
          border: isSelected ? "2px solid #8af" : state.isDefault ? "2px solid #4a8" : "1px solid #444",
          borderRadius: 8,
          cursor: "move",
          userSelect: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: "bold", color: "#ccc" }}>
          {state.isDefault ? "★ " : ""}{state.name}
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>{state.clipName}</div>
        {isSelected && (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); startConnecting(e, state.id); }}
              style={miniBtnStyle}
            >
              →
            </button>
            {!state.isDefault && (
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setDefaultState(state.id); }}
                style={miniBtnStyle}
              >
                ★
              </button>
            )}
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); deleteState(state.id); }}
              style={{ ...miniBtnStyle, color: "#f44" }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    );
  };

  const selectedStateData = states.find((s) => s.id === selectedState);
  const selectedTransData = transitions.find((t) => t.id === selectedTransition);

  return (
    <div style={{ display: "flex", height: "100%", background: "#1a1a1e", color: "#ccc", fontFamily: "monospace" }}>
      {/* Canvas */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {/* Toolbar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          background: "#252530",
          borderBottom: "1px solid #333",
          fontSize: 12,
        }}>
          <span style={{ fontWeight: "bold", color: "#fff" }}>Animation State Machine</span>
          <button onClick={addState} style={btnStyle}>+ Add State</button>
          <div style={{ flex: 1 }} />
          <span style={{ color: "#666", fontSize: 11 }}>{states.length} states, {transitions.length} transitions</span>
        </div>

        <div
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ flex: 1, position: "relative", overflow: "hidden" }}
        >
          <div style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "radial-gradient(circle, #333 1px, transparent 1px)",
            backgroundSize: "20px 20px",
            opacity: 0.3,
          }} />

          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#666" />
              </marker>
            </defs>
            {transitions.map(renderTransition)}
            {connecting && states.find((s) => s.id === connecting.fromId) && (() => {
              const from = getStateCenter(states.find((s) => s.id === connecting.fromId)!);
              return <line x1={from.x} y1={from.y} x2={connecting.x} y2={connecting.y} stroke="#8af" strokeWidth={2} strokeDasharray="4 4" />;
            })()}
          </svg>

          {states.map(renderState)}
        </div>
      </div>

      {/* Side panel */}
      <div style={{
        width: 240,
        background: "#252530",
        borderLeft: "1px solid #333",
        padding: 12,
        overflowY: "auto",
        fontSize: 12,
      }}>
        {/* Parameters */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontWeight: "bold", color: "#fff" }}>Parameters</span>
            <button onClick={() => setShowParamForm(!showParamForm)} style={miniBtnStyle}>+</button>
          </div>
          {showParamForm && (
            <div style={{ marginBottom: 8, padding: 8, background: "#1a1a1e", borderRadius: 4 }}>
              <input
                type="text"
                placeholder="param name"
                value={newParamName}
                onChange={(e) => setNewParamName(e.target.value)}
                style={inputStyle}
              />
              <select
                value={newParamType}
                onChange={(e) => setNewParamType(e.target.value as "float" | "bool" | "int")}
                style={{ ...inputStyle, marginTop: 4 }}
              >
                <option value="float">float</option>
                <option value="bool">bool</option>
                <option value="int">int</option>
              </select>
              <button onClick={addParameter} style={{ ...btnStyle, marginTop: 4, width: "100%" }}>Add</button>
            </div>
          )}
          {parameters.length === 0 ? (
            <div style={{ color: "#666" }}>No parameters</div>
          ) : (
            parameters.map((p) => (
              <div key={p.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ color: "#8af" }}>{p.name}</span>
                <span style={{ color: "#888" }}>{p.type}: {String(p.value)}</span>
                <button onClick={() => deleteParameter(p.name)} style={{ ...miniBtnStyle, color: "#f44" }}>×</button>
              </div>
            ))
          )}
        </div>

        {/* Selected state properties */}
        {selectedStateData && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: "bold", color: "#fff", marginBottom: 8 }}>State Properties</div>
            <label style={labelStyle}>Name</label>
            <input
              type="text"
              value={selectedStateData.name}
              onChange={(e) => onStatesChange?.(states.map((s) => s.id === selectedStateData.id ? { ...s, name: e.target.value } : s))}
              style={inputStyle}
            />
            <label style={labelStyle}>Clip</label>
            <input
              type="text"
              value={selectedStateData.clipName}
              onChange={(e) => onStatesChange?.(states.map((s) => s.id === selectedStateData.id ? { ...s, clipName: e.target.value } : s))}
              style={inputStyle}
            />
            <label style={labelStyle}>Speed: {selectedStateData.speed.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={selectedStateData.speed}
              onChange={(e) => onStatesChange?.(states.map((s) => s.id === selectedStateData.id ? { ...s, speed: parseFloat(e.target.value) } : s))}
              style={{ width: "100%" }}
            />
          </div>
        )}

        {/* Selected transition properties */}
        {selectedTransData && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: "bold", color: "#fff" }}>Transition</span>
              <button onClick={() => deleteTransition(selectedTransData.id)} style={{ ...miniBtnStyle, color: "#f44" }}>Delete</button>
            </div>
            <label style={labelStyle}>Condition</label>
            <input
              type="text"
              value={selectedTransData.condition}
              onChange={(e) => updateTransition(selectedTransData.id, { condition: e.target.value })}
              style={inputStyle}
            />
            <label style={labelStyle}>Blend Duration: {selectedTransData.blendDuration.toFixed(2)}s</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={selectedTransData.blendDuration}
              onChange={(e) => updateTransition(selectedTransData.id, { blendDuration: parseFloat(e.target.value) })}
              style={{ width: "100%" }}
            />
            <label style={labelStyle}>Blend Type</label>
            <select
              value={selectedTransData.blendType}
              onChange={(e) => updateTransition(selectedTransData.id, { blendType: e.target.value as "crossfade" | "immediate" })}
              style={inputStyle}
            >
              <option value="crossfade">Crossfade</option>
              <option value="immediate">Immediate</option>
            </select>
          </div>
        )}
      </div>
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#333",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

const miniBtnStyle: React.CSSProperties = {
  padding: "2px 6px",
  background: "#333",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 3,
  cursor: "pointer",
  fontSize: 11,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#1a1a1e",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 12,
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "#888",
  marginBottom: 2,
};
