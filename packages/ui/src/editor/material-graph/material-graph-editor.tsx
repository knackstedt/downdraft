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

export type GraphNodeData = SharedGraphNodeData;
export type GraphConnection = SharedGraphConnection;

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

const NODE_W = 160;
const PORT_H = 20;
const HEADER_H = 28;
const ACCENT = "#8af";

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
  // Sand sparkle
  { type: "sand_sparkle", label: "Sand Sparkle", inputs: [{ name: "worldPos", type: "vec3" }, { name: "N", type: "vec3" }, { name: "V", type: "vec3" }, { name: "L", type: "vec3" }, { name: "sandMask", type: "f32" }], outputs: [{ name: "value", type: "vec3" }] },
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

export const MaterialGraphEditor: React.FC<MaterialGraphEditorProps> = ({
  nodes,
  connections,
  onNodesChange,
  onConnectionsChange,
  onCompile,
  onValidate,
  onPreview,
}) => {
  const [showPalette, setShowPalette] = React.useState(false);

  const editor = useGraphEditor<GraphNodeData, GraphConnection>({
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
      addNode(type, NODE_TYPES as NodeTypeDefinition[]);
      setShowPalette(false);
    },
    [addNode],
  );

  const renderConnection = (conn: GraphConnection) => {
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

  const renderNode = (node: GraphNodeData) => {
    const def = NODE_TYPES.find((t) => t.type === node.type);
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
              onClick={() => handleAddNode(t.type)}
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
      <GraphCanvas
        canvasRef={canvasRef}
        pan={pan}
        zoom={zoom}
        dragging={!!dragging}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* SVG for connections */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
          {connections.map(renderConnection)}
          {renderTempConnection()}
        </svg>

        {/* Nodes */}
        {nodes.map(renderNode)}
      </GraphCanvas>
    </div>
  );
};
