// GenderIndicator — bottom-right Male/Female label
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

export function GenderIndicator({ width, height }: { width: number; height: number }) {
  const gender = useWorkerState((s) => s.characterGender);
  return (
    <pixiContainer x={width - 80} y={height - 20}>
      <ScaledText text={gender === "male" ? "Male" : "Female"} style={{ fill: 0x999999, fontSize: 13, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
