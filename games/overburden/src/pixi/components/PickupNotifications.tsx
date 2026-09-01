// PickupNotifications — top-right pickup toasts
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

export function PickupNotifications({ width }: { width: number }) {
  const pickups = useWorkerState((s) => s.pickups);
  if (pickups.length === 0) return null;

  const toasts = pickups.slice(0, 6).map((p, i) => (
    <pixiContainer key={p.id} x={width - 200} y={50 + i * 28}>
      <pixiGraphics
        draw={(g) => {
          g.clear();
          g.roundRect(0, 0, 180, 24, 4).fill({ color: 0x1a1a2e, alpha: 0.9 }).stroke({ width: 1, color: 0x2ecc71, alpha: 0.5 });
        }}
      />
      <ScaledText text={`+${p.count} ${p.itemId}`} x={10} y={6} style={{ fill: 0x2ecc71, fontSize: 14, fontFamily: "sans-serif" }} />
    </pixiContainer>
  ));

  return <pixiContainer>{toasts}</pixiContainer>;
}
