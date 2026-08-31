import React from "react";
import { useWorkerState, postAction } from "../worker-store";

const CATEGORIES = ["Foundation", "Walls", "Roofs", "Decor"];

export function BuilderWheel({ width, height }: { width: number; height: number }) {
  const cellType = useWorkerState((s) => s.builderCellType);
  const cx = width / 2, cy = height / 2;
  const radius = 100;
  return (
    <pixiContainer>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.4 }); }} />
      <pixiContainer x={cx} y={cy}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.circle(0, 0, radius + 20).fill({ color: 0x111122, alpha: 0.9 }).stroke({ width: 2, color: 0x6c5ce7, alpha: 0.6 }); }} />
        {CATEGORIES.map((cat, i) => {
          const angle = (i / CATEGORIES.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          const isActive = i === cellType;
          return (
            <pixiContainer key={cat} x={x} y={y} eventMode="static" cursor="pointer" onPointerDown={() => { postAction({ kind: "setBuilderCellType", idx: i }); postAction({ kind: "closeMenu", menu: "builderWheel" }); postAction({ kind: "lockPointer" }); }}>
              <pixiGraphics draw={(g: any) => { g.clear(); g.circle(0, 0, 24).fill({ color: isActive ? 0x6c5ce7 : 0x222244, alpha: 0.9 }).stroke({ width: 1, color: isActive ? 0xa29bfe : 0x444466, alpha: 0.7 }); }} />
              <pixiText text={cat[0]} x={0} y={0} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif", fontWeight: "bold" }} />
            </pixiContainer>
          );
        })}
      </pixiContainer>
    </pixiContainer>
  );
}
