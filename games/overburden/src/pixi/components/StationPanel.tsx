// StationPanel — station craft queue + fuel + recipes (top-right)
import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

const PANEL_W = 320;
const PANEL_H = 400;

export function StationPanel() {
  const ax = useWorkerState((s) => s.selectedStationAx);
  const ay = useWorkerState((s) => s.selectedStationAy);
  const craftQueue = useWorkerState((s) => s.craftQueue);
  const recipes = useWorkerState((s) => s.recipes);

  const stationName = craftQueue?.stationName ?? "Station";
  const fuelCount = craftQueue?.fuelCount ?? 0;
  const fuelMax = craftQueue?.fuelMax ?? 0;
  const stationFueled = craftQueue?.stationFueled ?? false;
  const active = craftQueue?.active ?? null;
  const queued = craftQueue?.queued ?? [];

  return (
    <pixiContainer x={8} y={120}>
      <pixiGraphics
        draw={(g) => {
          g.clear();
          g.roundRect(0, 0, PANEL_W, PANEL_H, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 });
        }}
      />
      {/* Title + close */}
      <ScaledText text={stationName} x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={PANEL_W - 32} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "closeStation" })}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <ScaledText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 18, fontFamily: "sans-serif" }} />
      </pixiContainer>

      {/* Fuel bar */}
      {stationFueled && (
        <pixiContainer x={16} y={40}>
          <ScaledText text="Fuel" style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
          <pixiGraphics
            x={40}
            y={0}
            draw={(g) => {
              g.clear();
              const ratio = fuelMax > 0 ? fuelCount / fuelMax : 0;
              g.roundRect(0, 0, 200, 12, 3).fill({ color: 0x222222, alpha: 0.8 });
              g.roundRect(0, 0, 200 * ratio, 12, 3).fill({ color: 0xe67e22, alpha: 0.9 });
              g.roundRect(0, 0, 200, 12, 3).stroke({ width: 1, color: 0x444444, alpha: 0.6 });
            }}
          />
          <ScaledText text={`${fuelCount}/${fuelMax}`} x={250} y={0} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "monospace" }} />
        </pixiContainer>
      )}

      {/* Active job */}
      {active && (
        <pixiContainer x={16} y={70}>
          <ScaledText text={active.recipeName} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
          <pixiGraphics
            y={16}
            draw={(g) => {
              g.clear();
              g.roundRect(0, 0, 280, 10, 3).fill({ color: 0x222222, alpha: 0.8 });
              g.roundRect(0, 0, 280 * (active.progress ?? 0), 10, 3).fill({ color: 0x2ecc71, alpha: 0.9 });
            }}
          />
          {active.rushable && (
            <pixiContainer x={200} y={32} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "rushCraft", ax, ay, jobId: active.jobId })}>
              <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 60, 20, 4).fill({ color: 0xf39c12, alpha: 0.3 }).stroke({ width: 1, color: 0xf39c12, alpha: 0.6 }); }} />
              <ScaledText text="Rush" x={30} y={10} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
            </pixiContainer>
          )}
          <pixiContainer x={265} y={32} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "abortCraft", ax, ay, jobId: active.jobId })}>
            <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 50, 20, 4).fill({ color: 0x882222, alpha: 0.3 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
            <ScaledText text="Abort" x={25} y={10} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
          </pixiContainer>
        </pixiContainer>
      )}

      {/* Queued jobs */}
      {queued.length > 0 && (
        <pixiContainer x={16} y={130}>
          <ScaledText text="Queued" style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
          {queued.slice(0, 4).map((job, i) => (
            <pixiContainer key={job.jobId} y={20 + i * 24}>
              <ScaledText text={job.recipeName} x={0} y={4} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
              <pixiContainer x={240} y={0} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "abortCraft", ax, ay, jobId: job.jobId })}>
                <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 50, 20, 4).fill({ color: 0x882222, alpha: 0.3 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
                <ScaledText text="Abort" x={25} y={10} anchor={0.5} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "sans-serif" }} />
              </pixiContainer>
            </pixiContainer>
          ))}
        </pixiContainer>
      )}

      {/* Recipes */}
      <pixiContainer x={16} y={250}>
        <ScaledText text="Recipes" style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
        {recipes.slice(0, 5).map((r, i) => (
          <pixiContainer
            key={r.id}
            y={20 + i * 24}
           
            eventMode="static"
            cursor="pointer"
            onPointerDown={() => postAction({ kind: "craft", recipeId: r.id, ax, ay })}
          >
            <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 280, 20, 4).fill({ color: 0x222244, alpha: 0.6 }).stroke({ width: 1, color: 0x444466, alpha: 0.4 }); }} />
            <ScaledText text={r.name} x={8} y={4} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
          </pixiContainer>
        ))}
      </pixiContainer>
    </pixiContainer>
  );
}
