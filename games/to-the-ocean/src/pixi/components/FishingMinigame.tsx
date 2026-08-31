import React from "react";
import { useWorkerState } from "../worker-store";

export function FishingMinigame({ width, height }: { width: number; height: number }) {
  const hud = useWorkerState((s) => s.hudState);
  const tension = hud.fishingTension;
  const progress = hud.fishingProgress;
  return (
    <pixiContainer x={width / 2} y={height / 2}>
      <pixiGraphics draw={(g: any) => {
        g.clear();
        g.roundRect(-100, -60, 200, 120, 8).fill({ color: 0x111122, alpha: 0.9 }).stroke({ width: 1, color: 0x4fc3f7, alpha: 0.6 });
      }} />
      <pixiText text="Fishing!" anchor={0.5} y={-40} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiGraphics draw={(g: any) => {
        g.clear();
        g.roundRect(-80, -10, 160, 10, 3).fill({ color: 0x222222, alpha: 0.8 });
        g.roundRect(-80, -10, 160 * Math.max(0, Math.min(1, tension)), 10, 3).fill({ color: 0xe74c3c, alpha: 0.9 });
      }} />
      <pixiText text="Tension" anchor={0.5} y={-18} style={{ fill: 0x999999, fontSize: 9, fontFamily: "sans-serif" }} />
      <pixiGraphics draw={(g: any) => {
        g.clear();
        g.roundRect(-80, 20, 160, 10, 3).fill({ color: 0x222222, alpha: 0.8 });
        g.roundRect(-80, 20, 160 * Math.max(0, Math.min(1, progress)), 10, 3).fill({ color: 0x2ecc71, alpha: 0.9 });
      }} />
      <pixiText text="Progress" anchor={0.5} y={12} style={{ fill: 0x999999, fontSize: 9, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
