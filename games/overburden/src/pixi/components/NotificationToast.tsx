// NotificationToast — center-top notification banner
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

export function NotificationToast({ width }: { width: number }) {
  const notification = useWorkerState((s) => s.notification);
  if (!notification) return null;

  return (
    <pixiContainer x={Math.round(width / 2)} y={50} anchor={0.5}>
      <pixiGraphics
        draw={(g) => {
          g.clear();
          const w = Math.max(200, notification.length * 8 + 32);
          g.roundRect(-w / 2, 0, w, 32, 6).fill({ color: 0x1a1a2e, alpha: 0.95 }).stroke({ width: 1, color: 0x6c5ce7, alpha: 0.6 });
        }}
      />
      <ScaledText text={notification} y={8} anchor={{ x: 0.5, y: 0 }} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
