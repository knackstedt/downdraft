import React from "react";
import { useWorkerState } from "../worker-store";

export function Reticule({ width, height }: { width: number; height: number }) {
  const size = useWorkerState((s) => s.reticleSize);
  const showBuilderWheel = useWorkerState((s) => s.showBuilderWheel);
  if (showBuilderWheel) return null;
  const half = size / 2;
  return (
    <pixiContainer x={width / 2} y={height / 2}>
      <pixiGraphics draw={(g: any) => {
        g.clear();
        g.circle(0, 0, half).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
        g.moveTo(-half - 4, 0).lineTo(-half + 4, 0).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
        g.moveTo(half - 4, 0).lineTo(half + 4, 0).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
        g.moveTo(0, -half - 4).lineTo(0, -half + 4).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
        g.moveTo(0, half - 4).lineTo(0, half + 4).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
      }} />
    </pixiContainer>
  );
}
