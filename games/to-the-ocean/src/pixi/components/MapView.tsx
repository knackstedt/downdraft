import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function MapView({ width, height }: { width: number; height: number }) {
  const snapshot = useWorkerState((s) => s.mapSnapshot);
  const bookmarks = useWorkerState((s) => s.bookmarks);
  return (
    <pixiContainer>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x0a0a1a, alpha: 0.9 }); }} />
      <pixiText text="Map" x={width / 2} y={20} anchor={0.5} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={width - 32} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "map" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {snapshot && (
        <pixiContainer x={width / 2} y={height / 2}>
          <pixiText text={`Player: ${snapshot.playerX.toFixed(0)}, ${snapshot.playerZ.toFixed(0)}`} anchor={0.5} style={{ fill: 0x4fc3f7, fontSize: 12, fontFamily: "monospace" }} />
        </pixiContainer>
      )}
      {bookmarks.map((b) => (
        <pixiContainer key={b.id} x={width / 2 + 100} y={height / 2 + b.id * 20}>
          <pixiText text={`${b.label}: ${b.x.toFixed(0)},${b.z.toFixed(0)}`} style={{ fill: 0xfdcb6e, fontSize: 10, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
    </pixiContainer>
  );
}
