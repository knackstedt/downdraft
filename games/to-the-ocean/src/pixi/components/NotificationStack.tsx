import React from "react";
import { useWorkerState } from "../worker-store";

export function NotificationStack({ width }: { width: number }) {
  const notifications = useWorkerState((s) => s.notifications);
  return (
    <pixiContainer x={width - 300} y={80}>
      {notifications.slice(-6).map((n, i) => (
        <pixiContainer key={n.id} y={i * 28}>
          <pixiGraphics draw={(g: any) => {
            g.clear();
            const w = Math.max(200, n.text.length * 7 + 24);
            g.roundRect(0, 0, w, 24, 4).fill({ color: 0x1a1a2e, alpha: 0.9 }).stroke({ width: 1, color: n.type === "error" ? 0xe74c3c : 0x4fc3f7, alpha: 0.5 });
          }} />
          <pixiText text={n.text} x={12} y={6} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
    </pixiContainer>
  );
}
