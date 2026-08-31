// BlockheadSelector — multi-character tabs (top-center)
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function BlockheadSelector() {
  const blockheads = useWorkerState((s) => s.blockheads);
  const activeBhIndex = useWorkerState((s) => s.activeBhIndex);
  const count = useWorkerState((s) => s.blockheadCount);

  const tabs = [];
  for (let i = 0; i < count; i++) {
    const isActive = i === activeBhIndex;
    tabs.push(
      <pixiContainer
        key={i}
        x={i * 36}
        y={0}
       
        eventMode="static"
        cursor="pointer"
        onPointerDown={() => postAction({ kind: "setActiveBhIndex", index: i })}
      >
        <pixiGraphics
          draw={(g) => {
            g.clear();
            g.roundRect(0, 0, 32, 32, 4).fill({ color: isActive ? 0x6c5ce7 : 0x222244, alpha: 0.9 }).stroke({ width: 1, color: isActive ? 0xa29bfe : 0x444466, alpha: 0.7 });
          }}
        />
        <pixiText text={`B${i + 1}`} x={16} y={16} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif", fontWeight: "bold" }} />
      </pixiContainer>,
    );
  }

  return <pixiContainer x={120} y={8}>{tabs}</pixiContainer>;
}
