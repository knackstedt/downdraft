import React, { useState, useEffect, useRef } from "react";
import { DevToolsPanel, DEFAULT_TOGGLES, type DebugToggleState, type TelemetryData, type EntityInfo } from "../devtools/panel.tsx";

export const App: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TelemetryData>({ frameTime: 0, p95: 0, p99: 0 });
  const [frameHistory, setFrameHistory] = useState<number[]>([]);
  const [showDevtools, setShowDevtools] = useState(true);
  const [toggles, setToggles] = useState<DebugToggleState>(DEFAULT_TOGGLES);
  const [entityCount, setEntityCount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineInitialized = useRef(false);

  useEffect(() => {
    if (engineInitialized.current) return;
    engineInitialized.current = true;

    const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
    if (!canvas) return;

    if (window.downdraft?.initEngine) {
      window.downdraft.initEngine(canvas);
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (window.downdraft?.rpc) {
        try {
          const data = await window.downdraft.rpc.call("getTelemetry") as TelemetryData;
          setTelemetry(data);
          setFrameHistory((prev) => [...prev, data.frameTime].slice(-300));
        } catch {
          // Engine not ready yet
        }
        try {
          const count = await window.downdraft.rpc.call("getEntityCount") as number;
          setEntityCount(count);
        } catch {
          // Engine not ready yet
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, []);

  const fpsDisplay = telemetry.frameTime > 0 ? (1000 / telemetry.frameTime).toFixed(1) : "—";

  const entities: EntityInfo[] = entityCount > 0
    ? Array.from({ length: entityCount }, (_, i) => ({
        id: i,
        name: i === 0 ? "root" : `entity_${i}`,
        components: [],
      }))
    : [];

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
          frame: {telemetry.frameTime.toFixed(2)}ms | p95: {telemetry.p95.toFixed(2)}ms | p99: {telemetry.p99.toFixed(2)}ms
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
        <DevToolsPanel
          telemetry={telemetry}
          frameHistory={frameHistory}
          entities={entities}
          toggles={toggles}
          onTogglesChange={setToggles}
        />
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

const mouseButtonsHeld = new Set<number>();
const keysHeld = new Set<number>();

function forwardInput(type: string, ...args: number[]): void {
  if (!window.downdraft?.rpc) return;

  if (type === "mouseDown") {
    const [button, x, y] = args;
    mouseButtonsHeld.add(button);
    window.downdraft.rpc.emit("input", {
      keys: [...keysHeld],
      mouseX: x,
      mouseY: y,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      mouseButtons: [mouseButtonsHeld.has(0) ? 1 : 0, mouseButtonsHeld.has(1) ? 1 : 0, mouseButtonsHeld.has(2) ? 1 : 0],
      wheelDelta: 0,
    });
  } else if (type === "mouseUp") {
    const [button, x, y] = args;
    mouseButtonsHeld.delete(button);
    window.downdraft.rpc.emit("input", {
      keys: [...keysHeld],
      mouseX: x,
      mouseY: y,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      mouseButtons: [mouseButtonsHeld.has(0) ? 1 : 0, mouseButtonsHeld.has(1) ? 1 : 0, mouseButtonsHeld.has(2) ? 1 : 0],
      wheelDelta: 0,
    });
  } else if (type === "mouseMove") {
    const [, , x, y, deltaX, deltaY] = args;
    window.downdraft.rpc.emit("input", {
      keys: [...keysHeld],
      mouseX: x,
      mouseY: y,
      mouseDeltaX: deltaX,
      mouseDeltaY: deltaY,
      mouseButtons: [mouseButtonsHeld.has(0) ? 1 : 0, mouseButtonsHeld.has(1) ? 1 : 0, mouseButtonsHeld.has(2) ? 1 : 0],
      wheelDelta: 0,
    });
  } else if (type === "wheel") {
    const [, , , , , , delta] = args;
    window.downdraft.rpc.emit("input", {
      keys: [...keysHeld],
      mouseX: 0,
      mouseY: 0,
      mouseDeltaX: 0,
      mouseDeltaY: 0,
      mouseButtons: [mouseButtonsHeld.has(0) ? 1 : 0, mouseButtonsHeld.has(1) ? 1 : 0, mouseButtonsHeld.has(2) ? 1 : 0],
      wheelDelta: delta,
    });
  } else if (type === "keyDown") {
    const [keyCode] = args;
    keysHeld.add(keyCode);
  } else if (type === "keyUp") {
    const [keyCode] = args;
    keysHeld.delete(keyCode);
  }
}
