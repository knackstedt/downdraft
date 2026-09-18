import type { ComputeDispatchConfig, StorageBufferDecl, UniformBufferDecl } from "@downdraft/shader-graph";
import React, { useCallback } from "react";

import { GraphCanvas } from "../shared/graph-canvas";
import { GraphConnectionView, TempConnectionView } from "../shared/graph-connection";
import { GraphNode } from "../shared/graph-node";
import {
    type NodeTypeDefinition,
    type SharedGraphConnection,
    type SharedGraphNodeData,
    useGraphEditor,
} from "../shared/use-graph-editor";

export type ComputeGraphNodeData = SharedGraphNodeData;
export type ComputeGraphConnection = SharedGraphConnection;

export interface ComputeGraphEditorProps {
  nodes: ComputeGraphNodeData[];
  connections: ComputeGraphConnection[];
  storageBuffers: StorageBufferDecl[];
  uniformBuffers: UniformBufferDecl[];
  dispatchConfig: ComputeDispatchConfig;
  onNodesChange?: (nodes: ComputeGraphNodeData[]) => void;
  onConnectionsChange?: (connections: ComputeGraphConnection[]) => void;
  onBuffersChange?: (storage: StorageBufferDecl[], uniform: UniformBufferDecl[]) => void;
  onDispatchChange?: (config: ComputeDispatchConfig) => void;
  onCompile?: () => void;
  onValidate?: () => void;
}

const NODE_W = 170;
const PORT_H = 20;
const HEADER_H = 28;
const ACCENT = "#fa8";

const COMPUTE_NODE_TYPES: Array<{
  type: string;
  label: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}> = [
  // Compute built-ins
  { type: "global_id", label: "Global Invocation ID", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  { type: "global_id_vec", label: "Global ID (vec3)", inputs: [], outputs: [{ name: "value", type: "vec3u" }] },
  { type: "local_id", label: "Local Invocation ID", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  { type: "workgroup_id", label: "Workgroup ID", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  { type: "num_workgroups", label: "Num Workgroups", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  // Buffer I/O
  { type: "buffer_load", label: "Buffer Load", inputs: [{ name: "index", type: "u32" }], outputs: [{ name: "value", type: "vec4" }] },
  { type: "buffer_load_element", label: "Buffer Load Element", inputs: [{ name: "index", type: "u32" }], outputs: [{ name: "value", type: "vec4" }] },
  { type: "buffer_store", label: "Buffer Store", inputs: [{ name: "index", type: "u32" }, { name: "value", type: "vec4" }], outputs: [] },
  // Atomics
  { type: "atomic_add", label: "Atomic Add", inputs: [{ name: "index", type: "u32" }, { name: "value", type: "u32" }], outputs: [{ name: "result", type: "u32" }] },
  { type: "atomic_sub", label: "Atomic Sub", inputs: [{ name: "index", type: "u32" }, { name: "value", type: "u32" }], outputs: [{ name: "result", type: "u32" }] },
  { type: "atomic_min", label: "Atomic Min", inputs: [{ name: "index", type: "u32" }, { name: "value", type: "u32" }], outputs: [{ name: "result", type: "u32" }] },
  { type: "atomic_max", label: "Atomic Max", inputs: [{ name: "index", type: "u32" }, { name: "value", type: "u32" }], outputs: [{ name: "result", type: "u32" }] },
  // Barriers
  { type: "workgroup_barrier", label: "Workgroup Barrier", inputs: [], outputs: [] },
  { type: "storage_barrier", label: "Storage Barrier", inputs: [], outputs: [] },
  { type: "all_barrier", label: "All Barrier", inputs: [], outputs: [] },
  // Constants
  { type: "constant", label: "Constant (f32)", inputs: [], outputs: [{ name: "value", type: "f32" }] },
  { type: "u32_constant", label: "Constant (u32)", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  { type: "vec3_constant", label: "Vec3 Constant", inputs: [], outputs: [{ name: "value", type: "vec3" }] },
  { type: "vec4_constant", label: "Vec4 Constant", inputs: [], outputs: [{ name: "value", type: "vec4" }] },
  // Math
  { type: "multiply", label: "Multiply", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "add", label: "Add", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "subtract", label: "Subtract", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "lerp", label: "Lerp", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }, { name: "t", type: "f32" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "normalize", label: "Normalize", inputs: [{ name: "v", type: "vec3" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "dot", label: "Dot Product", inputs: [{ name: "a", type: "vec3" }, { name: "b", type: "vec3" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "cross", label: "Cross Product", inputs: [{ name: "a", type: "vec3" }, { name: "b", type: "vec3" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "power", label: "Power", inputs: [{ name: "base", type: "f32" }, { name: "exp", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "saturate", label: "Saturate", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "max", label: "Max", inputs: [{ name: "a", type: "f32" }, { name: "b", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "min", label: "Min", inputs: [{ name: "a", type: "f32" }, { name: "b", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "abs", label: "Abs", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "sin", label: "Sin", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "cos", label: "Cos", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "fract", label: "Fract", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "floor", label: "Floor", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "smoothstep", label: "Smoothstep", inputs: [{ name: "edge0", type: "f32" }, { name: "edge1", type: "f32" }, { name: "x", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "mix3", label: "Mix3", inputs: [{ name: "a", type: "vec3" }, { name: "b", type: "vec3" }, { name: "t", type: "f32" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "length", label: "Length", inputs: [{ name: "v", type: "vec3" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "exp", label: "Exp", inputs: [{ name: "v", type: "f32" }], outputs: [{ name: "result", type: "f32" }] },
  { type: "swizzle_xyz", label: "Swizzle XYZ", inputs: [{ name: "v", type: "vec4" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "swizzle_rgb", label: "Swizzle RGB", inputs: [{ name: "v", type: "vec4" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "vec3_from_xy", label: "Vec3 from XYZ", inputs: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "z", type: "f32" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "vec4_from_xyzw", label: "Vec4 from XYZW", inputs: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "z", type: "f32" }, { name: "w", type: "f32" }], outputs: [{ name: "result", type: "vec4" }] },
  // Noise
  { type: "value_noise", label: "Value Noise", inputs: [{ name: "p", type: "vec3" }], outputs: [{ name: "value", type: "f32" }] },
  { type: "fbm", label: "FBM", inputs: [{ name: "p", type: "vec3" }, { name: "octaves", type: "u32" }], outputs: [{ name: "value", type: "f32" }] },
];

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#333",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  padding: "2px 6px",
  background: "#1a1a1e",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 3,
  fontSize: 11,
  width: 80,
};

export const ComputeGraphEditor: React.FC<ComputeGraphEditorProps> = ({
  nodes,
  connections,
  storageBuffers,
  uniformBuffers,
  dispatchConfig,
  onNodesChange,
  onConnectionsChange,
  onBuffersChange,
  onDispatchChange,
  onCompile,
  onValidate,
}) => {
  const [showPalette, setShowPalette] = React.useState(false);
  const [showBufferPanel, setShowBufferPanel] = React.useState(false);

  const editor = useGraphEditor<ComputeGraphNodeData, ComputeGraphConnection>({
    nodes,
    connections,
    nodeWidth: NODE_W,
    portHeight: PORT_H,
    headerHeight: HEADER_H,
    onNodesChange,
    onConnectionsChange,
  });

  const {
    canvasRef,
    selectedNode,
    dragging,
    connecting,
    pan,
    zoom,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handlePortMouseDown,
    handlePortMouseUp,
    addNode,
    deleteNode,
    deleteConnection,
    getNodePortPos,
  } = editor;

  const handleAddNode = useCallback(
    (type: string) => {
      addNode(type, COMPUTE_NODE_TYPES as NodeTypeDefinition[]);
      setShowPalette(false);
    },
    [addNode],
  );

  const addStorageBuffer = () => {
    const newBuf: StorageBufferDecl = {
      name: `buffer_${storageBuffers.length}`,
      binding: storageBuffers.length + uniformBuffers.length,
      group: 0,
      access: "read_write",
      structName: `Buf${storageBuffers.length}`,
      structFields: [{ name: "value", type: "f32" }],
    };
    onBuffersChange?.([...storageBuffers, newBuf], uniformBuffers);
  };

  const addUniformBuffer = () => {
    const newBuf: UniformBufferDecl = {
      name: `uniform_${uniformBuffers.length}`,
      binding: storageBuffers.length + uniformBuffers.length,
      group: 0,
      structName: `Uni${uniformBuffers.length}`,
      structFields: [{ name: "value", type: "f32" }],
    };
    onBuffersChange?.(storageBuffers, [...uniformBuffers, newBuf]);
  };

  const removeStorageBuffer = (index: number) => {
    onBuffersChange?.(storageBuffers.filter((_, i) => i !== index), uniformBuffers);
  };

  const removeUniformBuffer = (index: number) => {
    onBuffersChange?.(storageBuffers, uniformBuffers.filter((_, i) => i !== index));
  };

  const renderConnection = (conn: ComputeGraphConnection) => {
    const fromNode = nodes.find((n) => n.id === conn.fromNode);
    const toNode = nodes.find((n) => n.id === conn.toNode);
    if (!fromNode || !toNode) return null;
    const from = getNodePortPos(fromNode, conn.fromPort, false);
    const to = getNodePortPos(toNode, conn.toPort, true);
    return (
      <GraphConnectionView
        key={conn.id}
        connection={conn}
        from={from}
        to={to}
        accentColor={ACCENT}
        onClick={deleteConnection}
      />
    );
  };

  const renderTempConnection = () => {
    if (!connecting) return null;
    const fromNode = nodes.find((n) => n.id === connecting.nodeId);
    if (!fromNode) return null;
    const from = getNodePortPos(fromNode, connecting.portId, connecting.portType === "input");
    const to = { x: connecting.x, y: connecting.y };
    return <TempConnectionView from={from} to={to} accentColor={ACCENT} />;
  };

  const renderNode = (node: ComputeGraphNodeData) => {
    const def = COMPUTE_NODE_TYPES.find((t) => t.type === node.type);
    const label = def?.label ?? node.type;
    return (
      <GraphNode
        key={node.id}
        node={node}
        label={label}
        isSelected={selectedNode === node.id}
        accentColor={ACCENT}
        nodeWidth={NODE_W}
        portHeight={PORT_H}
        headerHeight={HEADER_H}
        onMouseDown={handleMouseDown}
        onPortMouseDown={handlePortMouseDown}
        onPortMouseUp={handlePortMouseUp}
        onDelete={deleteNode}
      />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1a1a1e", color: "#ccc", fontFamily: "monospace" }}>
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
        <span style={{ fontWeight: "bold", color: "#fff" }}>Compute Graph</span>
        <button onClick={() => setShowPalette(!showPalette)} style={btnStyle}>+ Add Node</button>
        <button onClick={() => setShowBufferPanel(!showBufferPanel)} style={btnStyle}>Buffers</button>
        <button onClick={onValidate} style={btnStyle}>Validate</button>
        <button onClick={onCompile} style={{ ...btnStyle, background: "#5a3a2a", borderColor: "#7a4a3a" }}>Compile WGSL</button>
        <div style={{ flex: 1 }} />
        <span style={{ color: "#666", fontSize: 11 }}>
          {nodes.length} nodes, {connections.length} connections, {storageBuffers.length} storage, {uniformBuffers.length} uniform
        </span>
      </div>

      {/* Buffer declaration panel */}
      {showBufferPanel && (
        <div style={{
          padding: "8px 12px",
          background: "#222230",
          borderBottom: "1px solid #333",
          fontSize: 11,
          maxHeight: 200,
          overflowY: "auto",
        }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <strong style={{ color: "#fa8" }}>Storage Buffers</strong>
            <button onClick={addStorageBuffer} style={btnStyle}>+ Add</button>
          </div>
          {storageBuffers.map((buf, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <input
                value={buf.name}
                onChange={(e) => {
                  const updated = [...storageBuffers];
                  updated[i] = { ...buf, name: e.target.value };
                  onBuffersChange?.(updated, uniformBuffers);
                }}
                style={inputStyle}
              />
              <input
                value={buf.structName}
                onChange={(e) => {
                  const updated = [...storageBuffers];
                  updated[i] = { ...buf, structName: e.target.value };
                  onBuffersChange?.(updated, uniformBuffers);
                }}
                style={inputStyle}
              />
              <select
                value={buf.access}
                onChange={(e) => {
                  const updated = [...storageBuffers];
                  updated[i] = { ...buf, access: e.target.value as StorageBufferDecl["access"] };
                  onBuffersChange?.(updated, uniformBuffers);
                }}
                style={inputStyle}
              >
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="read_write">read_write</option>
              </select>
              <span style={{ color: "#666" }}>@binding({buf.binding})</span>
              <button onClick={() => removeStorageBuffer(i)} style={{ ...btnStyle, padding: "2px 6px", color: "#f44" }}>×</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginBottom: 8, marginTop: 12 }}>
            <strong style={{ color: "#8af" }}>Uniform Buffers</strong>
            <button onClick={addUniformBuffer} style={btnStyle}>+ Add</button>
          </div>
          {uniformBuffers.map((buf, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <input
                value={buf.name}
                onChange={(e) => {
                  const updated = [...uniformBuffers];
                  updated[i] = { ...buf, name: e.target.value };
                  onBuffersChange?.(storageBuffers, updated);
                }}
                style={inputStyle}
              />
              <input
                value={buf.structName}
                onChange={(e) => {
                  const updated = [...uniformBuffers];
                  updated[i] = { ...buf, structName: e.target.value };
                  onBuffersChange?.(storageBuffers, updated);
                }}
                style={inputStyle}
              />
              <span style={{ color: "#666" }}>@binding({buf.binding})</span>
              <button onClick={() => removeUniformBuffer(i)} style={{ ...btnStyle, padding: "2px 6px", color: "#f44" }}>×</button>
            </div>
          ))}
          {/* Dispatch config */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
            <strong>Workgroup:</strong>
            <input
              type="number"
              value={dispatchConfig.workgroupSize[0]}
              onChange={(e) => onDispatchChange?.({
                ...dispatchConfig,
                workgroupSize: [parseInt(e.target.value) || 1, dispatchConfig.workgroupSize[1], dispatchConfig.workgroupSize[2]],
              })}
              style={{ ...inputStyle, width: 50 }}
            />
            <input
              type="number"
              value={dispatchConfig.workgroupSize[1]}
              onChange={(e) => onDispatchChange?.({
                ...dispatchConfig,
                workgroupSize: [dispatchConfig.workgroupSize[0], parseInt(e.target.value) || 1, dispatchConfig.workgroupSize[2]],
              })}
              style={{ ...inputStyle, width: 50 }}
            />
            <input
              type="number"
              value={dispatchConfig.workgroupSize[2]}
              onChange={(e) => onDispatchChange?.({
                ...dispatchConfig,
                workgroupSize: [dispatchConfig.workgroupSize[0], dispatchConfig.workgroupSize[1], parseInt(e.target.value) || 1],
              })}
              style={{ ...inputStyle, width: 50 }}
            />
            <strong>Dispatch:</strong>
            <input
              type="number"
              value={typeof dispatchConfig.dispatchCount === "object" ? dispatchConfig.dispatchCount[0] : 1}
              onChange={(e) => onDispatchChange?.({
                ...dispatchConfig,
                dispatchCount: [parseInt(e.target.value) || 1, 1, 1],
              })}
              style={{ ...inputStyle, width: 50 }}
            />
          </div>
        </div>
      )}

      {/* Node palette */}
      {showPalette && (
        <div style={{
          position: "absolute",
          top: 40,
          left: 12,
          background: "#2a2a35",
          border: "1px solid #444",
          borderRadius: 6,
          padding: 8,
          zIndex: 100,
          maxHeight: 300,
          overflowY: "auto",
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Compute Node Types</div>
          {COMPUTE_NODE_TYPES.map((t) => (
            <div
              key={t.type}
              onClick={() => handleAddNode(t.type)}
              style={{ padding: "4px 12px", cursor: "pointer", fontSize: 12, borderRadius: 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#3a3a45"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {t.label}
            </div>
          ))}
        </div>
      )}

      {/* Canvas */}
      <GraphCanvas
        canvasRef={canvasRef}
        pan={pan}
        zoom={zoom}
        dragging={!!dragging}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
          {connections.map(renderConnection)}
          {renderTempConnection()}
        </svg>
        {nodes.map(renderNode)}
      </GraphCanvas>
    </div>
  );
};
