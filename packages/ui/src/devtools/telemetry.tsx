import React from "react";

export interface TelemetryData {
  frameTime: number;
  p95: number;
  p99: number;
}

export const TelemetryGraphs: React.FC<{
  data: TelemetryData;
  frameHistory: number[];
}> = ({ data, frameHistory }) => {
  const maxFrameTime = Math.max(...frameHistory, 1);
  const barHeight = 40;

  return (
    <div>
      <div style={{ fontWeight: "bold", marginBottom: 4, color: "#fff" }}>Telemetry</div>
      <div style={{ marginBottom: 4 }}>
        Frame: <span style={{ color: "#0f0" }}>{data.frameTime.toFixed(2)}ms</span>
      </div>
      <div style={{ marginBottom: 4 }}>
        p95: <span style={{ color: "#ff0" }}>{data.p95.toFixed(2)}ms</span> | p99:{" "}
        <span style={{ color: "#f80" }}>{data.p99.toFixed(2)}ms</span>
      </div>
      {frameHistory.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            height: barHeight,
            gap: 1,
            marginTop: 4,
          }}
        >
          {frameHistory.slice(-60).map((ft, i) => (
            <div
              key={i}
              style={{
                width: 3,
                height: `${(ft / maxFrameTime) * 100}%`,
                background: ft > 33 ? "#f44" : ft > 20 ? "#ff0" : "#0f0",
                minHeight: 1,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
