import React from "react";
import { postAction } from "../worker-store";

export function ClickToResume({ width, height }: { width: number; height: number }) {
  return (
    <pixiContainer eventMode="static" onPointerDown={() => postAction({ kind: "lockPointer" })}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.5 }); }} />
      <pixiText text="Click to resume" x={width / 2} y={height / 2} anchor={0.5} style={{ fill: 0xffffff, fontSize: 24, fontFamily: "sans-serif" }} />
    </pixiContainer>
  );
}
