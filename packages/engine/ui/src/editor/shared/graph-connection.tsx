import React from "react";

import type { SharedGraphConnection } from "./use-graph-editor";

export interface GraphConnectionViewProps {
  connection: SharedGraphConnection;
  /** Start position (output port) in graph units. */
  from: { x: number; y: number };
  /** End position (input port) in graph units. */
  to: { x: number; y: number };
  /** Accent color for the visible curve. */
  accentColor: string;
  /** Called when the connection is clicked (used to delete). */
  onClick: (id: string) => void;
}

/**
 * Shared connection renderer. Draws a cubic bezier curve between two ports
 * with a darker outline and a brighter accent stroke on top. Clicking the
 * connection invokes `onClick` (the parent uses this to delete the link).
 */
export const GraphConnectionView: React.FC<GraphConnectionViewProps> = ({ connection, from, to, accentColor, onClick }) => {
  const midX = (from.x + to.x) / 2;
  const path = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
  return (
    <g key={connection.id} onClick={() => onClick(connection.id)} style={{ cursor: "pointer" }}>
      <path d={path} stroke="#555" strokeWidth={3} fill="none" opacity={0.5} />
      <path d={path} stroke={accentColor} strokeWidth={2} fill="none" />
    </g>
  );
};

export interface TempConnectionViewProps {
  from: { x: number; y: number };
  to: { x: number; y: number };
  accentColor: string;
}

/**
 * Renders the dashed in-progress connection while the user drags from a port.
 */
export const TempConnectionView: React.FC<TempConnectionViewProps> = ({ from, to, accentColor }) => {
  const midX = (from.x + to.x) / 2;
  const path = `M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`;
  return <path d={path} stroke={accentColor} strokeWidth={2} fill="none" strokeDasharray="4 4" />;
};
