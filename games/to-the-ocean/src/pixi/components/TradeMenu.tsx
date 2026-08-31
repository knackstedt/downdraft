import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function TradeMenu({ width, height }: { width: number; height: number }) {
  const items = useWorkerState((s) => s.tradeItems);
  const x0 = Math.round((width - 360) / 2);
  const y0 = Math.round((height - 400) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 360, 400, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <pixiText text="Trade" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={328} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "tradeMenu" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {items.slice(0, 10).map((item, i) => (
        <pixiContainer key={item.id} x={16} y={40 + i * 32}>
          <pixiText text={`${item.name} (${item.basePrice}g)`} x={0} y={6} style={{ fill: 0xffffff, fontSize: 11, fontFamily: "sans-serif" }} />
          <pixiContainer x={200} y={0} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "trade", itemId: item.id, quantity: 1, buy: true })}>
            <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 60, 22, 4).fill({ color: 0x2ecc71, alpha: 0.2 }).stroke({ width: 1, color: 0x2ecc71, alpha: 0.5 }); }} />
            <pixiText text="Buy" x={30} y={11} anchor={0.5} style={{ fill: 0xffffff, fontSize: 10, fontFamily: "sans-serif" }} />
          </pixiContainer>
          <pixiContainer x={268} y={0} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "trade", itemId: item.id, quantity: 1, buy: false })}>
            <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 60, 22, 4).fill({ color: 0xe67e22, alpha: 0.2 }).stroke({ width: 1, color: 0xe67e22, alpha: 0.5 }); }} />
            <pixiText text="Sell" x={30} y={11} anchor={0.5} style={{ fill: 0xffffff, fontSize: 10, fontFamily: "sans-serif" }} />
          </pixiContainer>
        </pixiContainer>
      ))}
    </pixiContainer>
  );
}
