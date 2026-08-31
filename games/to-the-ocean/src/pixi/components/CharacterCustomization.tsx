import React from "react";
import { postAction } from "../worker-store";

export function CharacterCustomization({ width, height }: { width: number; height: number }) {
  const pw = 340, ph = 300;
  const x0 = Math.round((width - pw) / 2);
  const y0 = Math.round((height - ph) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, pw, ph, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <pixiText text="Character" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={pw - 32} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "characterCustomization" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      <pixiText text="Outfit" x={16} y={40} style={{ fill: 0x999999, fontSize: 11, fontFamily: "sans-serif" }} />
      {["Hat", "Shirt", "Pants", "Boots"].map((slot, i) => (
        <pixiContainer key={slot} x={16} y={60 + i * 30} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "equipItem", slot: slot.toLowerCase(), itemId: null })}>
          <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 200, 24, 4).fill({ color: 0x222244, alpha: 0.6 }).stroke({ width: 1, color: 0x444466, alpha: 0.4 }); }} />
          <pixiText text={slot} x={10} y={6} style={{ fill: 0xffffff, fontSize: 11, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
      <pixiContainer x={16} y={250} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "characterCustomization" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 140, 28, 4).fill({ color: 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: 0xa29bfe, alpha: 0.6 }); }} />
        <pixiText text="Confirm" x={70} y={14} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
