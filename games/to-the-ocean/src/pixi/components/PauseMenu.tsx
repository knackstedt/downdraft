import { ScaledText } from "../font-scale-context";
import React from "react";
import { postAction } from "../worker-store";

export function PauseMenu({ width, height }: { width: number; height: number }) {
  const pw = 240, ph = 280;
  const x0 = Math.round((width - pw) / 2);
  const y0 = Math.round((height - ph) / 2);
  const btn = (label: string, action: any, y: number, danger = false) => (
    <pixiContainer x={20} y={y} eventMode="static" cursor="pointer" onPointerDown={() => postAction(action)}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 200, 30, 6).fill({ color: danger ? 0x882222 : 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: danger ? 0xe74c3c : 0xa29bfe, alpha: 0.6 }); }} />
      <ScaledText text={label} x={100} y={15} anchor={0.5} style={{ fill: 0xffffff, fontSize: 15, fontFamily: "sans-serif", fontWeight: "bold" }} />
    </pixiContainer>
  );
  return (
    <pixiContainer>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.6 }); }} />
      <pixiContainer x={x0} y={y0}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, pw, ph, 8).fill({ color: 0x1a1a2e, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
        <ScaledText text="Paused" x={pw / 2} y={14} anchor={{ x: 0.5, y: 0 }} style={{ fill: 0xfdcb6e, fontSize: 20, fontFamily: "sans-serif", fontWeight: "bold" }} />
        {btn("Resume", { kind: "closeMenu", menu: "pauseMenu" }, 48)}
        {btn("Save Game", { kind: "saveGame" }, 84)}
        {btn("Load Game", { kind: "loadGame" }, 120)}
        {btn("Settings", { kind: "toggleMenu", menu: "settings" }, 156)}
        {btn("Reset Game", { kind: "resetGame" }, 192, true)}
        {btn("Quit", { kind: "quit" }, 228, true)}
      </pixiContainer>
    </pixiContainer>
  );
}
