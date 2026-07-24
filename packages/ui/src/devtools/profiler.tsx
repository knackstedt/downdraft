import React, { useState, useEffect, useRef, useCallback } from "react";

export interface ProfilerSample {
  frameTime: number;
  cpuTime: number;
  gpuTime: number;
  timestamp: number;
}

export interface SystemTiming {
  name: string;
  cpuMs: number;
  gpuMs: number;
  calls: number;
}

export interface ProfilerProps {
  samples?: ProfilerSample[];
  systemTimings?: SystemTiming[];
  maxSamples?: number;
}

const MAX_SAMPLES_DEFAULT = 120;

export const ProfilerPanel: React.FC<ProfilerProps> = ({
  samples: propSamples,
  systemTimings: propTimings,
  maxSamples = MAX_SAMPLES_DEFAULT,
}) => {
  const [samples, setSamples] = useState<ProfilerSample[]>(propSamples ?? []);
  const [systemTimings, setSystemTimings] = useState<SystemTiming[]>(propTimings ?? []);
  const [paused, setPaused] = useState(false);
  const [viewMode, setViewMode] = useState<"graph" | "flame" | "table">("graph");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (propSamples !== undefined) {
      setSamples(propSamples);
    } else if (window.downdraft?.rpc) {
      const interval = setInterval(() => {
        if (paused) return;
        window.downdraft!.rpc.call("getTelemetry").then((data) => {
          if (data && typeof data === "object") {
            const d = data as Record<string, unknown>;
            const sample: ProfilerSample = {
              frameTime: (d.frameTime as number) ?? 16.67,
              cpuTime: (d.cpuTime as number) ?? 10,
              gpuTime: (d.gpuTime as number) ?? 8,
              timestamp: performance.now(),
            };
            setSamples((prev) => [...prev.slice(-maxSamples + 1), sample]);
            if (Array.isArray(d.systemTimings)) {
              setSystemTimings(d.systemTimings as SystemTiming[]);
            }
          }
        }).catch(() => {});
      }, 100);
      return () => clearInterval(interval);
    }
  }, [propSamples, paused, maxSamples]);

  const drawGraph = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#1a1a1e";
    ctx.fillRect(0, 0, w, h);

    if (samples.length < 2) {
      ctx.fillStyle = "#666";
      ctx.font = "12px monospace";
      ctx.fillText("Waiting for data...", w / 2 - 50, h / 2);
      return;
    }

    const maxFrameTime = Math.max(33.33, ...samples.map((s) => s.frameTime));
    const yScale = (h - 40) / maxFrameTime;
    const xStep = w / maxSamples;

    // Grid lines
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "#555";
    for (let ms = 0; ms <= maxFrameTime; ms += Math.ceil(maxFrameTime / 5)) {
      const y = h - 20 - ms * yScale;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${ms}ms`, 4, y - 2);
    }

    // 16.67ms line (60fps target)
    const targetY = h - 20 - 16.67 * yScale;
    ctx.strokeStyle = "#4a6";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, targetY);
    ctx.lineTo(w, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#4a6";
    ctx.fillText("60fps", w - 40, targetY - 2);

    // 33.33ms line (30fps)
    const thirtyY = h - 20 - 33.33 * yScale;
    ctx.strokeStyle = "#a64";
    ctx.beginPath();
    ctx.moveTo(0, thirtyY);
    ctx.lineTo(w, thirtyY);
    ctx.stroke();
    ctx.fillStyle = "#a64";
    ctx.fillText("30fps", w - 40, thirtyY - 2);

    // Frame time graph
    ctx.strokeStyle = "#8af";
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = i * xStep;
      const y = h - 20 - s.frameTime * yScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill under curve
    ctx.lineTo((samples.length - 1) * xStep, h - 20);
    ctx.lineTo(0, h - 20);
    ctx.closePath();
    ctx.fillStyle = "rgba(100, 150, 255, 0.1)";
    ctx.fill();

    // CPU time
    ctx.strokeStyle = "#fa8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = i * xStep;
      const y = h - 20 - s.cpuTime * yScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // GPU time
    ctx.strokeStyle = "#a8f";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = i * xStep;
      const y = h - 20 - s.gpuTime * yScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [samples, maxSamples]);

  useEffect(() => {
    if (viewMode === "graph") {
      drawGraph();
    }
  }, [drawGraph, viewMode]);

  // Stats
  const frameTimes = samples.map((s) => s.frameTime);
  const avgFrame = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const maxFrame = sorted[sorted.length - 1] ?? 0;
  const minFrame = sorted[0] ?? 0;
  const fps = avgFrame > 0 ? (1000 / avgFrame).toFixed(1) : "—";

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
        <span style={{ fontWeight: "bold", color: "#fff" }}>Profiler</span>
        <button onClick={() => setPaused(!paused)} style={btnStyle}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
        <button onClick={() => setSamples([])} style={btnStyle}>Clear</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => setViewMode("graph")} style={{ ...btnStyle, background: viewMode === "graph" ? "#3a3a45" : "#333" }}>Graph</button>
        <button onClick={() => setViewMode("table")} style={{ ...btnStyle, background: viewMode === "table" ? "#3a3a45" : "#333" }}>Table</button>
      </div>

      {/* Stats summary */}
      <div style={{
        display: "flex",
        gap: 16,
        padding: "6px 12px",
        background: "#1e1e25",
        borderBottom: "1px solid #333",
        fontSize: 11,
      }}>
        <Stat label="FPS" value={fps} color="#8af" />
        <Stat label="Avg" value={`${avgFrame.toFixed(2)}ms`} color="#ccc" />
        <Stat label="p50" value={`${p50.toFixed(2)}ms`} color="#ccc" />
        <Stat label="p95" value={`${p95.toFixed(2)}ms`} color="#fa8" />
        <Stat label="p99" value={`${p99.toFixed(2)}ms`} color="#f88" />
        <Stat label="Min" value={`${minFrame.toFixed(2)}ms`} color="#4a8" />
        <Stat label="Max" value={`${maxFrame.toFixed(2)}ms`} color="#a64" />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: viewMode === "graph" ? 0 : 8 }}>
        {viewMode === "graph" ? (
          <>
            <canvas
              ref={canvasRef}
              width={800}
              height={300}
              style={{ width: "100%", height: "300px" }}
            />
            <div style={{ display: "flex", gap: 16, padding: "6px 12px", fontSize: 11 }}>
              <span style={{ color: "#8af" }}>━ Frame Time</span>
              <span style={{ color: "#fa8" }}>━ CPU Time</span>
              <span style={{ color: "#a8f" }}>━ GPU Time</span>
            </div>
          </>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", textAlign: "left" }}>
                <th style={{ padding: "4px 8px", color: "#888" }}>System</th>
                <th style={{ padding: "4px 8px", color: "#888", textAlign: "right" }}>CPU (ms)</th>
                <th style={{ padding: "4px 8px", color: "#888", textAlign: "right" }}>GPU (ms)</th>
                <th style={{ padding: "4px 8px", color: "#888", textAlign: "right" }}>Calls</th>
                <th style={{ padding: "4px 8px", color: "#888" }}>CPU Bar</th>
              </tr>
            </thead>
            <tbody>
              {systemTimings.length === 0 ? (
                <tr><td colSpan={5} style={{ padding: "12px", textAlign: "center", color: "#666" }}>No system timing data available</td></tr>
              ) : (
                systemTimings.sort((a, b) => b.cpuMs - a.cpuMs).map((t) => {
                  const maxCpu = Math.max(...systemTimings.map((s) => s.cpuMs), 1);
                  const barWidth = (t.cpuMs / maxCpu) * 100;
                  return (
                    <tr key={t.name} style={{ borderBottom: "1px solid #222" }}>
                      <td style={{ padding: "4px 8px" }}>{t.name}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", color: "#fa8" }}>{t.cpuMs.toFixed(3)}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", color: "#a8f" }}>{t.gpuMs.toFixed(3)}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", color: "#888" }}>{t.calls}</td>
                      <td style={{ padding: "4px 8px" }}>
                        <div style={{
                          width: `${barWidth}%`,
                          height: 8,
                          background: "linear-gradient(90deg, #4a6, #fa8)",
                          borderRadius: 2,
                        }} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div style={{ display: "flex", flexDirection: "column" }}>
    <span style={{ color: "#666", fontSize: 10 }}>{label}</span>
    <span style={{ color, fontWeight: "bold" }}>{value}</span>
  </div>
);

const btnStyle: React.CSSProperties = {
  padding: "4px 10px",
  background: "#333",
  color: "#ccc",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
