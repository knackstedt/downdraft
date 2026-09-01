import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function AchievementNotification({ width, height }: { width: number; height: number }) {
  return (
    <pixiContainer>
      <ScaledText text="AchievementNotification" x={width / 2} y={height / 2} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
