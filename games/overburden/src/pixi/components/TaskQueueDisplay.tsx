// TaskQueueDisplay — active blockhead's task list (top-left)
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

const STATUS_COLORS: Record<string, number> = {
  active: 0x2ecc71,
  pending: 0xf1c40f,
  failed: 0xe74c3c,
  done: 0x999999,
};

export function TaskQueueDisplay() {
  const tasks = useWorkerState((s) => s.tasks);

  return (
    <pixiContainer x={8} y={120}>
      <pixiGraphics
        draw={(g) => {
          g.clear();
          const h = 30 + tasks.length * 22;
          g.roundRect(0, 0, 240, Math.max(60, h), 6).fill({ color: 0x111122, alpha: 0.9 }).stroke({ width: 1, color: 0x333355, alpha: 0.6 });
        }}
      />
      <ScaledText text="Tasks" x={12} y={8} style={{ fill: 0xfdcb6e, fontSize: 14, fontFamily: "sans-serif", fontWeight: "bold" }} />
      {tasks.length === 0 && (
        <ScaledText text="No tasks" x={12} y={30} style={{ fill: 0x999999, fontSize: 13, fontFamily: "sans-serif" }} />
      )}
      {tasks.slice(0, 8).map((t, i) => (
        <pixiContainer key={t.id} y={28 + i * 22}>
          <pixiGraphics
            x={0}
            y={4}
            draw={(g) => {
              g.clear();
              g.circle(6, 6, 4).fill({ color: STATUS_COLORS[t.status] ?? 0x999999, alpha: 0.9 });
            }}
          />
          <ScaledText
            text={`${t.type} (${t.targetX},${t.targetY})${t.blockId ? ` b=${t.blockId}` : ""}`}
            x={16}
            y={4}
            style={{ fill: 0xffffff, fontSize: 12, fontFamily: "monospace" }}
          />
        </pixiContainer>
      ))}
    </pixiContainer>
  );
}
