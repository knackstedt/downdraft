import React, { useState, useEffect, useRef } from "react";

interface FPSData {
  frameTime: number;
  p95: number;
  p99: number;
}

export const App: React.FC = () => {
  const [fps, setFps] = useState<FPSData>({ frameTime: 0, p95: 0, p99: 0 });
  const [showDevtools, setShowDevtools] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineInitialized = useRef(false);

  useEffect(() => {
    if (engineInitialized.current) return;
    engineInitialized.current = true;

    const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
    if (!canvas) return;

    // Initialize engine via preload bridge
    if (window.downdraft?.initEngine) {
      window.downdraft.initEngine(canvas);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (window.downdraft?.rpc) {
        try {
          const data = await window.downdraft.rpc.call("getTelemetry") as FPSData;
          setFps(data);
        } catch {
          // Engine not ready yet
        }
      }
    }, 500);

    return () => clearInterval(interval);
  }, []);

  const fpsDisplay = fps.frameTime > 0 ? (1000 / fps.frameTime).toFixed(1) : "—";

  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
      {/* FPS Counter */}
      <div style={{
        position: "absolute",
        top: 12,
        left: 12,
        padding: "8px 12px",
        background: "rgba(0, 0, 0, 0.7)",
        color: "#0f0",
        fontFamily: "monospace",
        fontSize: 14,
        borderRadius: 6,
        pointerEvents: "auto",
      }}>
        <div>FPS: {fpsDisplay}</div>
        <div style={{ fontSize: 11, color: "#888" }}>
          frame: {fps.frameTime.toFixed(2)}ms | p95: {fps.p95.toFixed(2)}ms | p99: {fps.p99.toFixed(2)}ms
        </div>
      </div>

      {/* Devtools toggle */}
      <button
        onClick={() => setShowDevtools(!showDevtools)}
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          padding: "6px 12px",
          background: "rgba(0, 0, 0, 0.7)",
          color: "#fff",
          border: "1px solid #333",
          borderRadius: 6,
          cursor: "pointer",
          fontFamily: "monospace",
          fontSize: 12,
          pointerEvents: "auto",
        }}
      >
        {showDevtools ? "Hide Devtools" : "Show Devtools"}
      </button>

      {/* Devtools panel */}
      {showDevtools && (
        <div style={{
          position: "absolute",
          top: 50,
          right: 12,
          width: 280,
          background: "rgba(0, 0, 0, 0.8)",
          color: "#ccc",
          border: "1px solid #333",
          borderRadius: 6,
          padding: 12,
          fontFamily: "monospace",
          fontSize: 12,
          pointerEvents: "auto",
        }}>
          <div style={{ fontWeight: "bold", marginBottom: 8, color: "#fff" }}>Devtools</div>
          <div style={{ marginBottom: 4 }}>Entity Count: 1 (cube)</div>
          <div style={{ marginBottom: 4 }}>Camera: orbit</div>
          <div style={{ marginBottom: 4 }}>Builder: dev</div>
          <hr style={{ borderColor: "#333", margin: "8px 0" }} />
          <div style={{ fontWeight: "bold", marginBottom: 4, color: "#fff" }}>Debug Toggles</div>
          <label style={{ display: "block", marginBottom: 2 }}>
            <input type="checkbox" /> Wireframe
          </label>
          <label style={{ display: "block", marginBottom: 2 }}>
            <input type="checkbox" /> Hitboxes
          </label>
          <label style={{ display: "block", marginBottom: 2 }}>
            <input type="checkbox" /> Normals
          </label>
          <label style={{ display: "block" }}>
            <input type="checkbox" /> Velocity
          </label>
        </div>
      )}

      {/* Input capture — transparent overlay that forwards to engine */}
      <div
        style={{ position: "absolute", inset: 0, pointerEvents: "auto" }}
        onMouseDown={(e) => forwardInput("mouseDown", e.button, e.clientX, e.clientY)}
        onMouseUp={(e) => forwardInput("mouseUp", e.button, e.clientX, e.clientY)}
        onMouseMove={(e) => forwardInput("mouseMove", 0, e.clientX, e.clientY, e.movementX, e.movementY)}
        onWheel={(e) => forwardInput("wheel", 0, 0, 0, 0, 0, e.deltaY)}
        onKeyDown={(e) => forwardInput("keyDown", e.keyCode)}
        onKeyUp={(e) => forwardInput("keyUp", e.keyCode)}
        tabIndex={0}
      />
    </div>
  );
};

function forwardInput(type: string, ...args: number[]): void {
  if (!window.downdraft?.rpc) return;

  if (type === "mouseDown" || type === "mouseUp") {
    // Track button state
  } else if (type === "mouseMove") {
    const [, , x, y, deltaX, deltaY] = args;
    window.downdraft.rpc.emit("input", {
      keys: [],
      mouseX: x,
      mouseY: y,
      mouseDeltaX: deltaX,
      mouseDeltaY: deltaY,
      mouseButtons: [],
      wheelDelta: 0,
    });
  } else if (type === "wheel") {
    const [, , , , , , delta] = args;
    window.downdraft.rpc.emit("input", {
      keys: [],
      mouseX: 0,
      mouseY: 0,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      mouseButtons: [],
      wheelDelta: delta,
    });
  }
}
