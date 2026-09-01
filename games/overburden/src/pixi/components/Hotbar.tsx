// Hotbar — bottom-center 9-slot hotbar
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

const SLOT_SIZE = 40;
const SLOT_GAP = 4;
const HOTBAR_SLOTS = 9;

export function Hotbar({ width, height }: { width: number; height: number }) {
  const inventory = useWorkerState((s) => s.inventory);
  const selectedSlot = useWorkerState((s) => s.selectedSlot);

  const totalW = HOTBAR_SLOTS * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP;
  const x0 = Math.round((width - totalW) / 2);
  const y0 = height - SLOT_SIZE - 12;

  const slots = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const slot = inventory[i];
    const isSelected = i === selectedSlot;
    slots.push(
      <pixiContainer key={i} x={i * (SLOT_SIZE + SLOT_GAP)} y={0}>
        <pixiGraphics
          draw={(g) => {
            g.clear();
            g.roundRect(0, 0, SLOT_SIZE, SLOT_SIZE, 4).fill({ color: isSelected ? 0x333366 : 0x222233, alpha: 0.9 }).stroke({ width: isSelected ? 2 : 1, color: isSelected ? 0x6c5ce7 : 0x444455, alpha: 0.8 });
          }}
        />
        <ScaledText text={String(i + 1)} x={4} y={2} style={{ fill: 0x666677, fontSize: 11, fontFamily: "monospace" }} />
        {slot && slot.count > 0 && (
          <ScaledText text={slot.count.toString()} x={SLOT_SIZE - 6} y={SLOT_SIZE - 14} anchor={1} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }} />
        )}
      </pixiContainer>,
    );
  }

  return <pixiContainer x={x0} y={y0}>{slots}</pixiContainer>;
}
