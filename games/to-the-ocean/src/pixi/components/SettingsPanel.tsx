import React from "react";
import { postAction } from "../worker-store";

export function SettingsPanel({ width, height }: { width: number; height: number }) {
  const x0 = Math.round((width - 400) / 2);
  const y0 = Math.round((height - 440) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 400, 440, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <pixiText text="Settings" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={368} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "settings" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      <pixiText text="Graphics" x={16} y={40} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif", fontWeight: "bold" }} />
      {[
        { label: "Particle Density", key: "particleDensity", y: 60 },
        { label: "Pixelation", key: "pixelationEnabled", y: 84 },
        { label: "Post Processing", key: "postProcessEnabled", y: 108 },
      ].map((s) => (
        <pixiContainer key={s.key} x={16} y={s.y} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "setSetting", key: s.key, value: true })}>
          <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 18, 18, 3).fill({ color: 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: 0x555577, alpha: 0.7 }); }} />
          <pixiText text={s.label} x={26} y={3} style={{ fill: 0xffffff, fontSize: 11, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
      <pixiContainer x={16} y={400} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "quit" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 120, 28, 4).fill({ color: 0x882222, alpha: 0.5 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="Exit Game" x={60} y={14} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
