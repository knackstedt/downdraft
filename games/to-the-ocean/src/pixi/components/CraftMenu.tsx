import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

export function CraftMenu({ width, height }: { width: number; height: number }) {
  const recipes = useWorkerState((s) => s.recipes);
  const queue = useWorkerState((s) => s.craftQueue);
  const x0 = Math.round((width - 400) / 2);
  const y0 = Math.round((height - 420) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 400, 420, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <ScaledText text="Crafting" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={368} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "craftMenu" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <ScaledText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 18, fontFamily: "sans-serif" }} />
      </pixiContainer>
      {queue.length > 0 && (
        <pixiContainer x={16} y={36}>
          <ScaledText text="Queue" style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
          {queue.slice(0, 4).map((q, i) => (
            <pixiContainer key={q.id} y={16 + i * 22}>
              <ScaledText text={`${q.recipeName} (${Math.round(q.progress * 100)}%)`} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
              <pixiContainer x={300} y={0} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "abortCraft", jobId: q.id })}>
                <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 60, 18, 3).fill({ color: 0x882222, alpha: 0.3 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.5 }); }} />
                <ScaledText text="Abort" x={30} y={9} anchor={0.5} style={{ fill: 0xffffff, fontSize: 11, fontFamily: "sans-serif" }} />
              </pixiContainer>
            </pixiContainer>
          ))}
        </pixiContainer>
      )}
      <pixiContainer x={16} y={140}>
        <ScaledText text="Recipes" style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
        {recipes.slice(0, 10).map((r, i) => (
          <pixiContainer key={r.id} y={16 + i * 26} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "craft", recipeId: r.id })}>
            <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 368, 22, 4).fill({ color: 0x222244, alpha: 0.6 }).stroke({ width: 1, color: 0x444466, alpha: 0.4 }); }} />
            <ScaledText text={r.name} x={10} y={5} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
          </pixiContainer>
        ))}
      </pixiContainer>
    </pixiContainer>
  );
}
