import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function BuildMenu({ width, height }: { width: number; height: number }) {
  const modules = useWorkerState((s) => s.buildModules);
  const x0 = Math.round((width - 360) / 2);
  const y0 = Math.round((height - 400) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 360, 400, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <pixiText text="Build" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={328} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "buildMenu" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {modules.slice(0, 10).map((m, i) => (
        <pixiContainer key={m.id} x={16} y={40 + i * 32} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "build", moduleId: m.id })}>
          <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 328, 28, 4).fill({ color: 0x222244, alpha: 0.8 }).stroke({ width: 1, color: 0x444466, alpha: 0.5 }); }} />
          <pixiText text={`${m.name} (${m.cost}g)`} x={10} y={8} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
    </pixiContainer>
  );
}
