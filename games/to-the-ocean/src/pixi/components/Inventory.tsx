import React from "react";
import { useWorkerState, postAction } from "../worker-store";

const PANEL_W = 400, PANEL_H = 360;
const SLOT_SIZE = 32, SLOTS_PER_ROW = 10;

export function Inventory({ width, height }: { width: number; height: number }) {
  const shipHold = useWorkerState((s) => s.shipHoldData);
  const x0 = Math.round((width - PANEL_W) / 2);
  const y0 = Math.round((height - PANEL_H) / 2);
  const items = shipHold?.playerItems ?? [];

  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, PANEL_W, PANEL_H, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <pixiText text="Inventory" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={PANEL_W - 32} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "inventory" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <pixiText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {shipHold && (
        <pixiContainer x={16} y={40} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "transferItem", direction: "to_ship" })}>
          <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 120, 24, 4).fill({ color: 0x222244, alpha: 0.8 }).stroke({ width: 1, color: 0x4fc3f7, alpha: 0.5 }); }} />
          <pixiText text="Transfer to Ship" x={60} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 11, fontFamily: "sans-serif" }} />
        </pixiContainer>
      )}
      <pixiContainer x={16} y={76}>
        {items.slice(0, 40).map((item, i) => {
          const col = i % SLOTS_PER_ROW, row = Math.floor(i / SLOTS_PER_ROW);
          return (
            <pixiContainer key={i} x={col * (SLOT_SIZE + 2)} y={row * (SLOT_SIZE + 2)}>
              <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, SLOT_SIZE, SLOT_SIZE, 3).fill({ color: 0x222233, alpha: 0.8 }).stroke({ width: 1, color: 0x444455, alpha: 0.5 }); }} />
              {item.quantity > 0 && <pixiText text={item.quantity.toString()} x={SLOT_SIZE - 4} y={SLOT_SIZE - 12} anchor={1} style={{ fill: 0xffffff, fontSize: 9, fontFamily: "monospace", fontWeight: "bold" }} />}
            </pixiContainer>
          );
        })}
      </pixiContainer>
    </pixiContainer>
  );
}
