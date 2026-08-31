// PauseMenu — pause overlay with Resume / Reset buttons
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function PauseMenu({ width, height }: { width: number; height: number }) {
  const panelW = 260;
  const panelH = 160;
  const x0 = Math.round((width - panelW) / 2);
  const y0 = Math.round((height - panelH) / 2);

  return (
    <pixiContainer>
      {/* Dim background */}
      <pixiGraphics draw={(g) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.6 }); }} />
      {/* Panel */}
      <pixiContainer x={x0} y={y0}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, panelW, panelH, 8).fill({ color: 0x1a1a2e, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
        <pixiText text="Paused" x={panelW / 2} y={16} anchor={{ x: 0.5, y: 0 }} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
        {/* Resume */}
        <pixiContainer x={30} y={56} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "setPaused", paused: false })}>
          <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 200, 32, 6).fill({ color: 0x6c5ce7, alpha: 0.9 }).stroke({ width: 1, color: 0xa29bfe, alpha: 0.7 }); }} />
          <pixiText text="Resume" x={100} y={16} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif", fontWeight: "bold" }} />
        </pixiContainer>
        {/* Reset */}
        <pixiContainer x={30} y={96} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "resetGame" })}>
          <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 200, 32, 6).fill({ color: 0x882222, alpha: 0.5 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
          <pixiText text="Reset Game" x={100} y={16} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
        </pixiContainer>
      </pixiContainer>
    </pixiContainer>
  );
}
