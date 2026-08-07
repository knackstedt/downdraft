import React, { useCallback, useRef, useState } from "react";

export interface GraphNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  inputs: Array<{ id: string; name: string; type: string }>;
  outputs: Array<{ id: string; name: string; type: string }>;
  properties: Record<string, unknown>;
}

export interface GraphConnection {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface MaterialGraphEditorProps {
  nodes: GraphNodeData[];
  connections: GraphConnection[];
  onNodesChange?: (nodes: GraphNodeData[]) => void;
  onConnectionsChange?: (connections: GraphConnection[]) => void;
  onCompile?: () => void;
  onValidate?: () => void;
  /** Live preview — called when the user clicks "Preview" to compile the graph
   * and set the resulting material on the preview mesh renderer. */
  onPreview?: () => void;
}

const NODE_TYPES: Array<{ type: string; label: string; inputs: Array<{ name: string; type: string }>; outputs: Array<{ name: string; type: string }> }> = [
  { type: "input", label: "Input", inputs: [], outputs: [{ name: "value", type: "vec4" }] },
  { type: "output", label: "Output", inputs: [{ name: "value", type: "vec4" }], outputs: [] },
  { type: "texture_sample", label: "Texture Sample", inputs: [{ name: "uv", type: "vec2" }], outputs: [{ name: "color", type: "vec4" }] },
  { type: "multiply", label: "Multiply", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "add", label: "Add", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "subtract", label: "Subtract", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "lerp", label: "Lerp", inputs: [{ name: "a", type: "vec4" }, { name: "b", type: "vec4" }, { name: "t", type: "f32" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "constant", label: "Constant", inputs: [], outputs: [{ name: "value", type: "f32" }] },
  { type: "vec3_constant", label: "Vec3 Constant", inputs: [], outputs: [{ name: "value", type: "vec3" }] },
  { type: "vec4_constant", label: "Vec4 Constant", inputs: [], outputs: [{ name: "value", type: "vec4" }] },
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
  { type: "swizzle_xyz", label: "Swizzle XYZ", inputs: [{ name: "v", type: "vec4" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "swizzle_rgb", label: "Swizzle RGB", inputs: [{ name: "v", type: "vec4" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "vec3_from_xy", label: "Vec3 from XYZ", inputs: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "z", type: "f32" }], outputs: [{ name: "result", type: "vec3" }] },
  { type: "vec4_from_xyzw", label: "Vec4 from XYZW", inputs: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "z", type: "f32" }, { name: "w", type: "f32" }], outputs: [{ name: "result", type: "vec4" }] },
  { type: "time", label: "Time", inputs: [], outputs: [{ name: "value", type: "f32" }] },
  { type: "uv", label: "UV", inputs: [], outputs: [{ name: "value", type: "vec2" }] },
  { type: "normal", label: "Normal", inputs: [], outputs: [{ name: "value", type: "vec3" }] },
  { type: "world_pos", label: "World Position", inputs: [], outputs: [{ name: "value", type: "vec3" }] },
  { type: "camera_pos", label: "Camera Position", inputs: [], outputs: [{ name: "value", type: "vec3" }] },
  { type: "vertex_color", label: "Vertex Color", inputs: [], outputs: [{ name: "value", type: "vec4" }] },
  { type: "entity_type", label: "Entity Type", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  { type: "entity_flags", label: "Entity Flags", inputs: [], outputs: [{ name: "value", type: "u32" }] },
  // PBR nodes
  { type: "pbr_lighting", label: "PBR Lighting", inputs: [{ name: "N", type: "vec3" }, { name: "worldPos", type: "vec3" }, { name: "baseColor", type: "vec3" }, { name: "metallic", type: "f32" }, { name: "roughness", type: "f32" }], outputs: [{ name: "value", type: "vec3" }] },
  { type: "pbr_params", label: "PBR Params", inputs: [], outputs: [{ name: "value", type: "vec4" }] },
  { type: "metallic_roughness", label: "Metallic/Roughness", inputs: [], outputs: [{ name: "value", type: "vec2" }] },
  // Dynamic lights
  { type: "dynamic_lights", label: "Dynamic Lights", inputs: [{ name: "N", type: "vec3" }, { name: "worldPos", type: "vec3" }, { name: "viewDir", type: "vec3" }, { name: "specPower", type: "f32" }, { name: "specIntensity", type: "f32" }], outputs: [{ name: "value", type: "vec3" }] },
  // Fog
  { type: "fog", label: "Fog", inputs: [{ name: "color", type: "vec3" }, { name: "dist", type: "f32" }, { name: "source", type: "vec3" }], outputs: [{ name: "value", type: "vec3" }] },
  // Noise
  { type: "value_noise", label: "Value Noise", inputs: [{ name: "p", type: "vec3" }], outputs: [{ name: "value", type: "f32" }] },
  { type: "fbm", label: "FBM", inputs: [{ name: "p", type: "vec3" }, { name: "octaves", type: "u32" }], outputs: [{ name: "value", type: "f32" }] },
  { type: "fbm_warp", label: "FBM Warp", inputs: [{ name: "p", type: "vec3" }, { name: "octaves", type: "u32" }, { name: "warpScale", type: "f32" }, { name: "warpStrength", type: "f32" }], outputs: [{ name: "value", type: "vec3" }] },
  // Sand sparkle (island-specific)
  { type: "sand_sparkle", label: "Sand Sparkle", inputs: [{ name: "worldPos", type: "vec3" }, { name: "N", type: "vec3" }, { name: "V", type: "vec3" }, { name: "L", type: "vec3" }, { name: "sandMask", type: "f32" }], outputs: [{ name: "value", type: "vec3" }] },
];

const NODE_W = 160;
const PORT_H = 20;
const HEADER_H = 28;

let nodeIdCounter = 0;
let connIdCounter = 0;

export const MaterialGraphEditor: React.FC<MaterialGraphEditorProps> = ({
  nodes,
  connections,
  onNodesChange,
  onConnectionsChange,
  onCompile,
  onValidate,
  onPreview,
}) => {
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<{ nodeId: string; portId: string; portType: "input" | "output"; x: number; y: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [showPalette, setShowPalette] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent, node: GraphNodeData) => {
    if (e.button !== 0) return;
    setSelectedNode(node.id);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDragging({
      id: node.id,
      offsetX: (e.clientX - rect.left - pan.x) / zoom - node.x,
      offsetY: (e.clientY - rect.top - pan.y) / zoom - node.y,
    });
  }, [pan, zoom]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = (e.clientX - rect.left - pan.x) / zoom - dragging.offsetX;
      const y = (e.clientY - rect.top - pan.y) / zoom - dragging.offsetY;
      onNodesChange?.(nodes.map((n) => (n.id === dragging.id ? { ...n, x, y } : n)));
    } else if (connecting) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setConnecting({ ...connecting, x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom });
    }
  }, [dragging, connecting, nodes, onNodesChange, pan, zoom]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    if (connecting) {
      setConnecting(null);
    }
  }, [connecting]);

  const handlePortMouseDown = useCallback((e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => {
    e.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setConnecting({
      nodeId,
      portId,
      portType,
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom,
    });
  }, [pan, zoom]);

  const handlePortMouseUp = useCallback((e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => {
    e.stopPropagation();
    if (!connecting) return;
    if (connecting.portType === portType) return; // can't connect input-to-input or output-to-output
    if (connecting.nodeId === nodeId) return; // can't connect to self

    const fromNode = connecting.portType === "output" ? connecting.nodeId : nodeId;
    const fromPort = connecting.portType === "output" ? connecting.portId : portId;
    const toNode = connecting.portType === "input" ? connecting.nodeId : nodeId;
    const toPort = connecting.portType === "input" ? connecting.portId : portId;

    const connId = `conn_${connIdCounter++}`;
    onConnectionsChange?.([...connections, { id: connId, fromNode, fromPort, toNode, toPort }]);
    setConnecting(null);
  }, [connecting, connections, onConnectionsChange]);

  const addNode = useCallback((type: string) => {
    const def = NODE_TYPES.find((t) => t.type === type);
    if (!def) return;
    const id = `node_${nodeIdCounter++}`;
    const node: GraphNodeData = {
      id,
      type,
      x: 200 + Math.random() * 200,
      y: 100 + Math.random() * 100,
      inputs: def.inputs.map((inp, i) => ({ id: `in_${i}`, name: inp.name, type: inp.type })),
      outputs: def.outputs.map((out, i) => ({ id: `out_${i}`, name: out.name, type: out.type })),
      properties: {},
    };
    onNodesChange?.([...nodes, node]);
    setShowPalette(false);
  }, [nodes, onNodesChange]);

  const deleteNode = useCallback((id: string) => {
    onNodesChange?.(nodes.filter((n) => n.id !== id));
    onConnectionsChange?.(connections.filter((c) => c.fromNode !== id && c.toNode !== id));
    setSelectedNode(null);
  }, [nodes, connections, onNodesChange, onConnectionsChange]);

  const deleteConnection = useCallback((id: string) => {
    onConnectionsChange?.(connections.filter((c) => c.id !== id));
  }, [connections, onConnectionsChange]);

  const getNodePortPos = (node: GraphNodeData, portId: string, isInput: boolean): { x: number; y: number } => {
    const ports = isInput ? node.inputs : node.outputs;
    const idx = ports.findIndex((p) => p.id === portId);
    const y = node.y + HEADER_H + (idx >= 0 ? idx * PORT_H + PORT_H / 2 : 0);
    const x = isInput ? node.x : node.x + NODE_W;
    return { x, y };
  };

  const renderConnection = (conn: GraphConnection) => {
    const fromNode = nodes.find((n) => n.id === conn.fromNode);
    const toNode = nodes.find((n) => n.id === conn.toNode);
    if (!fromNode || !toNode) return null;
    const from = getNodePortPos(fromNode, conn.fromPort, false);
    const to = getNodePortPos(toNode, conn.toPort, true);
    const midX = (from.x + to.x) / 2;
    const path = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
    return (
      <g key={conn.id} onClick={() => deleteConnection(conn.id)} style={{ cursor: "pointer" }}>
        <path d={path} stroke="#555" strokeWidth={3} fill="none" opacity={0.5} />
        <path d={path} stroke="#8af" strokeWidth={2} fill="none" />
      </g>
    );
  };

  const renderTempConnection = () => {
    if (!connecting) return null;
    const fromNode = nodes.find((n) => n.id === connecting.nodeId);
    if (!fromNode) return null;
    const from = getNodePortPos(fromNode, connecting.portId, connecting.portType === "input");
    const to = { x: connecting.x, y: connecting.y };
    const midX = (from.x + to.x) / 2;
    const path = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
    return <path d={path} stroke="#8af" strokeWidth={2} fill="none" strokeDasharray="4 4" />;
  };

  const renderNode = (node: GraphNodeData) => {
    const def = NODE_TYPES.find((t) => t.type === node.type);
    const label = def?.label ?? node.type;
    const isSelected = selectedNode === node.id;
    const totalPorts = Math.max(node.inputs.length, node.outputs.length);
    const height = HEADER_H + totalPorts * PORT_H + 8;

    return (
      <div
        key={node.id}
        onMouseDown={(e) => handleMouseDown(e, node)}
        style={{
          position: "absolute",
          left: node.x,
          top: node.y,
          width: NODE_W,
          height,
          background: "rgba(30, 30, 35, 0.95)",
          border: isSelected ? "2px solid #8af" : "1px solid #444",
          borderRadius: 6,
          cursor: "move",
          userSelect: "none",
        }}
      >
        <div style={{
          padding: "4px 8px",
          fontSize: 11,
          fontWeight: "bold",
          color: "#ccc",
          borderBottom: "1px solid #444",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <span>{label}</span>
          {isSelected && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
              style={{
                background: "none",
                border: "none",
                color: "#f44",
                cursor: "pointer",
                fontSize: 14,
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
        <div style={{ position: "relative", height: totalPorts * PORT_H }}>
          {node.inputs.map((port, i) => (
            <div
              key={port.id}
              onMouseDown={(e) => handlePortMouseDown(e, node.id, port.id, "input")}
              onMouseUp={(e) => handlePortMouseUp(e, node.id, port.id, "input")}
              style={{
                position: "absolute",
                left: 0,
                top: i * PORT_H,
                height: PORT_H,
                display: "flex",
                alignItems: "center",
                paddingLeft: 8,
                fontSize: 10,
                color: "#aaa",
                cursor: "crosshair",
              }}
            >
              <div style={{
                position: "absolute",
                left: -5,
                top: PORT_H / 2 - 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#6a8",
                border: "1px solid #4a6",
              }} />
              {port.name}
            </div>
          ))}
          {node.outputs.map((port, i) => (
            <div
              key={port.id}
              onMouseDown={(e) => handlePortMouseDown(e, node.id, port.id, "output")}
              onMouseUp={(e) => handlePortMouseUp(e, node.id, port.id, "output")}
              style={{
                position: "absolute",
                right: 0,
                top: i * PORT_H,
                height: PORT_H,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                paddingRight: 8,
                fontSize: 10,
                color: "#aaa",
                cursor: "crosshair",
              }}
            >
              {port.name}
              <div style={{
                position: "absolute",
                right: -5,
                top: PORT_H / 2 - 4,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#a86",
                border: "1px solid #864",
              }} />
            </div>
          ))}
        </div>
      </div>
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
        <span style={{ fontWeight: "bold", color: "#fff" }}>Material Graph</span>
        <button onClick={() => setShowPalette(!showPalette)} style={btnStyle}>+ Add Node</button>
        <button onClick={onValidate} style={btnStyle}>Validate</button>
        <button onClick={onCompile} style={{ ...btnStyle, background: "#2a5a3a", borderColor: "#3a7a4a" }}>Compile WGSL</button>
        {onPreview && (
          <button onClick={onPreview} style={{ ...btnStyle, background: "#2a3a5a", borderColor: "#3a4a7a" }}>Preview</button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: "#666", fontSize: 11 }}>{nodes.length} nodes, {connections.length} connections</span>
      </div>

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
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Node Types</div>
          {NODE_TYPES.map((t) => (
            <div
              key={t.type}
              onClick={() => addNode(t.type)}
              style={{
                padding: "4px 12px",
                cursor: "pointer",
                fontSize: 12,
                borderRadius: 3,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#3a3a45"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {t.label}
            </div>
          ))}
        </div>
      )}

      {/* Canvas */}
      <div
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ flex: 1, position: "relative", overflow: "hidden", cursor: dragging ? "grabbing" : "default" }}
      >
        {/* Grid background */}
        <div style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, #333 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          opacity: 0.3,
        }} />

        <div style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}>
          {/* SVG for connections */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
            {connections.map(renderConnection)}
            {renderTempConnection()}
          </svg>

          {/* Nodes */}
          {nodes.map(renderNode)}
        </div>
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
