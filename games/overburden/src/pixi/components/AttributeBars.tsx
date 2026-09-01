// AttributeBars — HP/Food/Energy/Air/Happy/Env bars (left side)
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

const BARS = [
  { key: "health", label: "HP", color: 0xe74c3c },
  { key: "hunger", label: "Food", color: 0xe67e22 },
  { key: "energy", label: "Energy", color: 0xf1c40f },
  { key: "air", label: "Air", color: 0x3498db },
  { key: "happiness", label: "Happy", color: 0x2ecc71 },
  { key: "environment", label: "Env", color: 0x9b59b6 },
] as const;

const BAR_W = 120;
const BAR_H = 12;
const BAR_GAP = 4;

export function AttributeBars() {
  const bh = useWorkerState((s) => s.blockheads[s.activeBhIndex] ?? s.blockheads[0]);

  return (
    <pixiContainer x={8} y={48}>
      {BARS.map((bar, i) => {
        const value = bh?.[bar.key] ?? 0;
        const ratio = Math.max(0, Math.min(1, value / 100));
        return (
          <pixiContainer key={bar.key} y={i * (BAR_H + BAR_GAP)}>
            <ScaledText text={bar.label} x={0} y={0} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
            <pixiGraphics
              x={50}
              y={0}
              draw={(g) => {
                g.clear();
                g.roundRect(0, 0, BAR_W, BAR_H, 3).fill({ color: 0x222222, alpha: 0.8 });
                g.roundRect(0, 0, BAR_W * ratio, BAR_H, 3).fill({ color: bar.color, alpha: 0.9 });
                g.roundRect(0, 0, BAR_W, BAR_H, 3).stroke({ width: 1, color: 0x444444, alpha: 0.6 });
              }}
            />
            <ScaledText text={Math.round(value).toString()} x={50 + BAR_W + 6} y={0} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "monospace" }} />
          </pixiContainer>
        );
      })}
    </pixiContainer>
  );
}
