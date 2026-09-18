import React from "react";

import type { GraphPortData, SharedGraphNodeData } from "./use-graph-editor";

export interface GraphNodeProps {
  node: SharedGraphNodeData;
  /** Display label for the node header. */
  label: string;
  /** Whether this node is currently selected. */
  isSelected: boolean;
  /** Accent color (selected border + used by callers for consistency). */
  accentColor: string;
  /** Node body width in graph units. */
  nodeWidth: number;
  /** Height of a single port row in graph units. */
  portHeight: number;
  /** Height of the node title header in graph units. */
  headerHeight: number;
  /** Start dragging the node (mouse down on body). */
  onMouseDown: (e: React.MouseEvent, node: SharedGraphNodeData) => void;
  /** Mouse down on a port — begin a connection drag. */
  onPortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => void;
  /** Mouse up on a port — complete a connection. */
  onPortMouseUp: (e: React.MouseEvent, nodeId: string, portId: string, portType: "input" | "output") => void;
  /** Delete the node (click on the × button). */
  onDelete: (id: string) => void;
}

/**
 * Shared graph node. Renders a titled card with input ports on the left
 * and output ports on the right. Handles drag-to-move (via `onMouseDown`)
 * and shows a selection outline + delete button when selected.
 */
export const GraphNode: React.FC<GraphNodeProps> = ({
  node,
  label,
  isSelected,
  accentColor,
  nodeWidth,
  portHeight,
  headerHeight,
  onMouseDown,
  onPortMouseDown,
  onPortMouseUp,
  onDelete,
}) => {
  const totalPorts = Math.max(node.inputs.length, node.outputs.length);
  const height = headerHeight + totalPorts * portHeight + 8;

  const renderPort = (port: GraphPortData, index: number, isInput: boolean) => {
    const handlers = {
      onMouseDown: (e: React.MouseEvent) => onPortMouseDown(e, node.id, port.id, isInput ? "input" : "output"),
      onMouseUp: (e: React.MouseEvent) => onPortMouseUp(e, node.id, port.id, isInput ? "input" : "output"),
    };

    if (isInput) {
      return (
        <div
          key={port.id}
          {...handlers}
          style={{
            position: "absolute",
            left: 0,
            top: index * portHeight,
            height: portHeight,
            display: "flex",
            alignItems: "center",
            paddingLeft: 8,
            fontSize: 10,
            color: "#aaa",
            cursor: "crosshair",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: -5,
              top: portHeight / 2 - 4,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#6a8",
              border: "1px solid #4a6",
            }}
          />
          {port.name}
        </div>
      );
    }

    return (
      <div
        key={port.id}
        {...handlers}
        style={{
          position: "absolute",
          right: 0,
          top: index * portHeight,
          height: portHeight,
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
        <div
          style={{
            position: "absolute",
            right: -5,
            top: portHeight / 2 - 4,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#a86",
            border: "1px solid #864",
          }}
        />
      </div>
    );
  };

  return (
    <div
      onMouseDown={(e) => onMouseDown(e, node)}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: nodeWidth,
        height,
        background: "rgba(30, 30, 35, 0.95)",
        border: isSelected ? `2px solid ${accentColor}` : "1px solid #444",
        borderRadius: 6,
        cursor: "move",
        userSelect: "none",
      }}
    >
      <div
        style={{
          padding: "4px 8px",
          fontSize: 11,
          fontWeight: "bold",
          color: "#ccc",
          borderBottom: "1px solid #444",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{label}</span>
        {isSelected && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.id);
            }}
            style={{ background: "none", border: "none", color: "#f44", cursor: "pointer", fontSize: 14, padding: 0 }}
          >
            ×
          </button>
        )}
      </div>
      <div style={{ position: "relative", height: totalPorts * portHeight }}>
        {node.inputs.map((port, i) => renderPort(port, i, true))}
        {node.outputs.map((port, i) => renderPort(port, i, false))}
      </div>
    </div>
  );
};
