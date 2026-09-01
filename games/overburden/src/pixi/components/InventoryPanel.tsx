// InventoryPanel — inventory + crafting + creative tabs
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState, postAction } from "../worker-store";
import type { InventoryTab } from "../bridge-protocol";

const PANEL_W = 360;
const PANEL_H = 420;
const SLOT_SIZE = 36;
const SLOTS_PER_ROW = 9;
const SLOT_GAP = 2;

const TABS: { id: InventoryTab; label: string }[] = [
  { id: "inventory", label: "Inventory" },
  { id: "crafting", label: "Crafting" },
  { id: "creative", label: "Creative" },
];

export function InventoryPanel({ width, height }: { width: number; height: number }) {
  const inventory = useWorkerState((s) => s.inventory);
  const inventoryTab = useWorkerState((s) => s.inventoryTab);
  const recipes = useWorkerState((s) => s.recipes);

  const x0 = Math.round((width - PANEL_W) / 2);
  const y0 = Math.round((height - PANEL_H) / 2);

  return (
    <pixiContainer x={x0} y={y0}>
      {/* Background */}
      <pixiGraphics
        draw={(g) => {
          g.clear();
          g.roundRect(0, 0, PANEL_W, PANEL_H, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 });
        }}
      />
      {/* Title */}
      <ScaledText text="Inventory" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
      {/* Close button */}
      <pixiContainer x={PANEL_W - 32} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleInventoryPanel" })}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <ScaledText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 18, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {/* Tabs */}
      {TABS.map((tab, i) => {
        const isActive = inventoryTab === tab.id;
        return (
          <pixiContainer
            key={tab.id}
            x={16 + i * 100}
            y={36}
           
            eventMode="static"
            cursor="pointer"
            onPointerDown={() => postAction({ kind: "setInventoryTab", tab: tab.id })}
          >
            <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 92, 24, 4).fill({ color: isActive ? 0x6c5ce7 : 0x222244, alpha: 0.9 }).stroke({ width: 1, color: isActive ? 0xa29bfe : 0x444466, alpha: 0.6 }); }} />
            <ScaledText text={tab.label} x={46} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
          </pixiContainer>
        );
      })}
      {/* Content */}
      {inventoryTab === "inventory" && (
        <InventoryGrid inventory={inventory} />
      )}
      {inventoryTab === "crafting" && (
        <RecipeList recipes={recipes} />
      )}
      {inventoryTab === "creative" && (
        <CreativePanel />
      )}
    </pixiContainer>
  );
}

function InventoryGrid({ inventory }: { inventory: (import("../bridge-protocol").InventorySlotUI | null)[] }) {
  const slots = [];
  for (let i = 0; i < 54; i++) {
    const slot = inventory[i];
    const col = i % SLOTS_PER_ROW;
    const row = Math.floor(i / SLOTS_PER_ROW);
    slots.push(
      <pixiContainer key={i} x={16 + col * (SLOT_SIZE + SLOT_GAP)} y={72 + row * (SLOT_SIZE + SLOT_GAP)}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, SLOT_SIZE, SLOT_SIZE, 3).fill({ color: 0x222233, alpha: 0.8 }).stroke({ width: 1, color: 0x444455, alpha: 0.5 }); }} />
        {slot && slot.count > 0 && (
          <ScaledText text={slot.count.toString()} x={SLOT_SIZE - 4} y={SLOT_SIZE - 12} anchor={1} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }} />
        )}
      </pixiContainer>
    );
  }
  return <pixiContainer>{slots}</pixiContainer>;
}

function RecipeList({ recipes }: { recipes: import("../bridge-protocol").RecipeUI[] }) {
  const rows = recipes.slice(0, 10).map((r, i) => (
    <pixiContainer
      key={r.id}
      x={16}
      y={72 + i * 28}
     
      eventMode="static"
      cursor="pointer"
      onPointerDown={() => postAction({ kind: "craft", recipeId: r.id, ax: -1, ay: -1 })}
    >
      <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 328, 24, 4).fill({ color: 0x222244, alpha: 0.8 }).stroke({ width: 1, color: 0x444466, alpha: 0.5 }); }} />
      <ScaledText text={r.name} x={10} y={6} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
    </pixiContainer>
  ));
  return <pixiContainer>{rows}</pixiContainer>;
}

function CreativePanel() {
  return (
    <pixiContainer x={16} y={72}>
      <ScaledText text="Creative mode — click to give items" style={{ fill: 0x999999, fontSize: 14, fontFamily: "sans-serif" }} />
      <pixiContainer y={30} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "spawnBlockhead" })}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 160, 28, 4).fill({ color: 0x2ecc71, alpha: 0.3 }).stroke({ width: 1, color: 0x2ecc71, alpha: 0.6 }); }} />
        <ScaledText text="Spawn Blockhead" x={80} y={14} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
