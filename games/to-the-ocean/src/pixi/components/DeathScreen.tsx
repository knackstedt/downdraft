import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function DeathScreen({ width, height }: { width: number; height: number }) {
  const data = useWorkerState((s) => s.playerDiedData);
  return (
    <pixiContainer>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.8 }); }} />
      <pixiText text="You Died" x={width / 2} y={height / 2 - 40} anchor={0.5} style={{ fill: 0xe74c3c, fontSize: 36, fontFamily: "sans-serif", fontWeight: "bold" }} />
      {data && <pixiText text={data.cause} x={width / 2} y={height / 2 + 0} anchor={0.5} style={{ fill: 0x999999, fontSize: 14, fontFamily: "sans-serif" }} />}
      <pixiContainer x={width / 2 - 80} y={height / 2 + 40} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "respawn" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 160, 36, 6).fill({ color: 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: 0xa29bfe, alpha: 0.6 }); }} />
        <pixiText text="Respawn" x={80} y={18} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
