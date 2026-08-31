import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function SignpostPrompt({ width, height }: { width: number; height: number }) {
  return (
    <pixiContainer>
      <pixiText text="SignpostPrompt" x={width / 2} y={height / 2} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
