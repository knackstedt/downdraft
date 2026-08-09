import React, { type RefObject } from "react";

import type { PanZoom } from "./use-graph-editor";

export interface GraphCanvasProps {
  /** Ref to the scrollable canvas container (used for coordinate math). */
  canvasRef: RefObject<HTMLDivElement | null>;
  /** Current pan offset in screen pixels. */
  pan: PanZoom;
  /** Current zoom factor. */
  zoom: number;
  /** Whether a node is currently being dragged (drives cursor). */
  dragging: boolean;
  /** Mouse move handler (forwarded to the container). */
  onMouseMove: (e: React.MouseEvent) => void;
  /** Mouse up / leave handler (forwarded to the container). */
  onMouseUp: (e: React.MouseEvent) => void;
  /** Children rendered inside the pan/zoom transform layer. */
  children: React.ReactNode;
}

/**
 * Shared graph canvas. Renders the scrollable container with a dot-grid
 * background and a pan/zoom transformed layer that holds the SVG connection
 * and the node elements.
 *
 * Pointer events on the background start a pan; wheel events adjust zoom.
 * The actual node dragging / connection logic is delegated to the parent via
 * `onMouseMove` / `onMouseUp`.
 */
export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  canvasRef,
  pan,
  zoom,
  dragging,
  onMouseMove,
  onMouseUp,
  children,
}) => {
  return (
    <div
      ref={canvasRef}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{ flex: 1, position: "relative", overflow: "hidden", cursor: dragging ? "grabbing" : "default" }}
    >
      {/* Grid background */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, #333 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          opacity: 0.3,
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {children}
      </div>
    </div>
  );
};
