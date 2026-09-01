// FpsBar — FPS, season/day/year, status indicators (top-left)
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

const SEASON_NAMES = ["Spring", "Summer", "Autumn", "Winter"];

export function FpsBar({ width }: { width: number }) {
  const fps = useWorkerState((s) => s.fps);
  const season = useWorkerState((s) => s.season);
  const dayInSeason = useWorkerState((s) => s.dayInSeason);
  const year = useWorkerState((s) => s.year);
  const paused = useWorkerState((s) => s.paused);
  const taskMode = useWorkerState((s) => s.taskMode);
  const cameraDetached = useWorkerState((s) => s.cameraDetached);

  const seasonIdx = ["spring", "summer", "autumn", "winter"].indexOf(season);

  return (
    <pixiContainer x={8} y={8}>
      <ScaledText
        text={`${Math.floor(fps)} FPS  |  ${SEASON_NAMES[seasonIdx] ?? "Spring"} ${dayInSeason} Y${year}`}
        style={{ fill: 0xffffff, fontSize: 14, fontFamily: "monospace" }}
      />
      <ScaledText
        text={`${paused ? "[PAUSED] " : ""}${taskMode ? "[TASK] " : ""}${cameraDetached ? "[CAM] " : ""}`}
        y={16}
        style={{ fill: 0xfdcb6e, fontSize: 13, fontFamily: "monospace" }}
      />
    </pixiContainer>
  );
}
