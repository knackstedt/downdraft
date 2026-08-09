import React, { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Shared data types                                                   */
/* ------------------------------------------------------------------ */

export interface GraphPortData {
  id: string;
  name: string;
  type: string;
}

export interface SharedGraphNodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  inputs: GraphPortData[];
  outputs: GraphPortData[];
  properties: Record<string, unknown>;
}

export interface SharedGraphConnection {
  id: string;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface NodeTypeDefinition {
  type: string;
  label: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}

/* ------------------------------------------------------------------ */
/* Internal interaction state                                          */
/* ------------------------------------------------------------------ */

export interface DraggingState {
  id: string;
  offsetX: number;
  offsetY: number;
}

export interface ConnectingState {
  nodeId: string;
  portId: string;
  portType: "input" | "output";
  x: number;
  y: number;
}

export interface PanZoom {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/* Hook options                                                        */
/* ------------------------------------------------------------------ */

export interface UseGraphEditorOptions<
  TNode extends SharedGraphNodeData = SharedGraphNodeData,
  TConn extends SharedGraphConnection = SharedGraphConnection,
> {
  nodes: TNode[];
  connections: TConn[];
  /** Node body width in graph units. */
  nodeWidth: number;
  /** Height of a single port row in graph units. */
  portHeight: number;
  /** Height of the node title header in graph units. */
  headerHeight: number;
  onNodesChange?: (nodes: TNode[]) => void;
  onConnectionsChange?: (connections: TConn[]) => void;
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export interface GraphEditorApi<
  TNode extends SharedGraphNodeData = SharedGraphNodeData,
  TConn extends SharedGraphConnection = SharedGraphConnection,
> {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  selectedNode: string | null;
  setSelectedNode: (id: string | null) => void;
  dragging: DraggingState | null;
  connecting: ConnectingState | null;
  pan: PanZoom;
  setPan: (pan: PanZoom) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  handleMouseDown: (e: React.MouseEvent, node: TNode) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: () => void;
  handlePortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => void;
  handlePortMouseUp: (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => void;
  addNode: (type: string, nodeTypes: NodeTypeDefinition[]) => void;
  deleteNode: (id: string) => void;
  deleteConnection: (id: string) => void;
  getNodePortPos: (node: TNode, portId: string, isInput: boolean) => { x: number; y: number };
  /** Generate a unique node id for this editor instance. */
  nextNodeId: () => string;
  /** Generate a unique connection id for this editor instance. */
  nextConnId: () => string;
}

/**
 * Shared graph editor hook. Encapsulates the ~80% of logic that is
 * identical between the Material and Compute graph editors:
 * node dragging, canvas panning/zooming, connection creation,
 * node selection, node/connection deletion and id generation.
 *
 * ID counters are ref-based (per-instance) to avoid collisions when
 * multiple editor instances coexist.
 */
export function useGraphEditor<
  TNode extends SharedGraphNodeData = SharedGraphNodeData,
  TConn extends SharedGraphConnection = SharedGraphConnection,
>(options: UseGraphEditorOptions<TNode, TConn>): GraphEditorApi<TNode, TConn> {
  const { nodes, connections, nodeWidth, portHeight, headerHeight, onNodesChange, onConnectionsChange } = options;

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DraggingState | null>(null);
  const [connecting, setConnecting] = useState<ConnectingState | null>(null);
  const [pan, setPan] = useState<PanZoom>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Ref-based id counters — per instance, avoids cross-instance collisions.
  const nodeIdCounterRef = useRef(0);
  const connIdCounterRef = useRef(0);
  const nextNodeId = useCallback(() => `node_${nodeIdCounterRef.current++}`, []);
  const nextConnId = useCallback(() => `conn_${connIdCounterRef.current++}`, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, node: TNode) => {
      if (e.button !== 0) return;
      setSelectedNode(node.id);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDragging({
        id: node.id,
        offsetX: (e.clientX - rect.left - pan.x) / zoom - node.x,
        offsetY: (e.clientY - rect.top - pan.y) / zoom - node.y,
      });
    },
    [pan, zoom],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = (e.clientX - rect.left - pan.x) / zoom - dragging.offsetX;
        const y = (e.clientY - rect.top - pan.y) / zoom - dragging.offsetY;
        onNodesChange?.(nodes.map((n) => (n.id === dragging.id ? ({ ...n, x, y } as TNode) : n)));
      } else if (connecting) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        setConnecting({ ...connecting, x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom });
      }
    },
    [dragging, connecting, nodes, onNodesChange, pan, zoom],
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    if (connecting) setConnecting(null);
  }, [connecting]);

  const handlePortMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => {
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
    },
    [pan, zoom],
  );

  const handlePortMouseUp = useCallback(
    (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => {
      e.stopPropagation();
      if (!connecting) return;
      if (connecting.portType === portType) return; // can't connect input-to-input or output-to-output
      if (connecting.nodeId === nodeId) return; // can't connect to self

      const fromNode = connecting.portType === "output" ? connecting.nodeId : nodeId;
      const fromPort = connecting.portType === "output" ? connecting.portId : portId;
      const toNode = connecting.portType === "input" ? connecting.nodeId : nodeId;
      const toPort = connecting.portType === "input" ? connecting.portId : portId;

      const connId = nextConnId();
      onConnectionsChange?.([...connections, { id: connId, fromNode, fromPort, toNode, toPort } as TConn]);
      setConnecting(null);
    },
    [connecting, connections, onConnectionsChange, nextConnId],
  );

  const addNode = useCallback(
    (type: string, nodeTypes: NodeTypeDefinition[]) => {
      const def = nodeTypes.find((t) => t.type === type);
      if (!def) return;
      const id = nextNodeId();
      const node = {
        id,
        type,
        x: 200 + Math.random() * 200,
        y: 100 + Math.random() * 100,
        inputs: def.inputs.map((inp, i) => ({ id: `in_${i}`, name: inp.name, type: inp.type })),
        outputs: def.outputs.map((out, i) => ({ id: `out_${i}`, name: out.name, type: out.type })),
        properties: {},
      } as TNode;
      onNodesChange?.([...nodes, node]);
    },
    [nodes, onNodesChange, nextNodeId],
  );

  const deleteNode = useCallback(
    (id: string) => {
      onNodesChange?.(nodes.filter((n) => n.id !== id));
      onConnectionsChange?.(connections.filter((c) => c.fromNode !== id && c.toNode !== id));
      setSelectedNode(null);
    },
    [nodes, connections, onNodesChange, onConnectionsChange],
  );

  const deleteConnection = useCallback(
    (id: string) => {
      onConnectionsChange?.(connections.filter((c) => c.id !== id));
    },
    [connections, onConnectionsChange],
  );

  // Delete key handling for the selected node.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedNode) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        e.preventDefault();
        deleteNode(selectedNode);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedNode, deleteNode]);

  const getNodePortPos = useCallback(
    (node: TNode, portId: string, isInput: boolean): { x: number; y: number } => {
      const ports = isInput ? node.inputs : node.outputs;
      const idx = ports.findIndex((p) => p.id === portId);
      const y = node.y + headerHeight + (idx >= 0 ? idx * portHeight + portHeight / 2 : 0);
      const x = isInput ? node.x : node.x + nodeWidth;
      return { x, y };
    },
    [headerHeight, portHeight, nodeWidth],
  );

  return {
    canvasRef,
    selectedNode,
    setSelectedNode,
    dragging,
    connecting,
    pan,
    setPan,
    zoom,
    setZoom,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handlePortMouseDown,
    handlePortMouseUp,
    addNode,
    deleteNode,
    deleteConnection,
    getNodePortPos,
    nextNodeId,
    nextConnId,
  };
}
