import React from "react";
import { postAction } from "../worker-store";

export function CreditsScreen({ width, height }: { width: number; height: number }) {
  return (
    <pixiContainer>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x0a0a1a, alpha: 0.95 }); }} />
      <pixiText text="Credits" x={width / 2} y={60} anchor={{ x: 0.5, y: 0 }} style={{ fill: 0xfdcb6e, fontSize: 28, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiText text="To The Ocean — built on the Downdraft Engine" x={width / 2} y={110} anchor={0.5} style={{ fill: 0x999999, fontSize: 14, fontFamily: "sans-serif" }} />
      <pixiText text="Andrew G. Knackstedt — Lead Developer" x={width / 2} y={160} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
      <pixiContainer x={width / 2 - 50} y={height - 60} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "credits" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 100, 32, 6).fill({ color: 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: 0xa29bfe, alpha: 0.6 }); }} />
        <pixiText text="Close" x={50} y={16} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
