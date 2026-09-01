import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState } from "../worker-store";

export function LoadingScreen({ width, height }: { width: number; height: number }) {
  const ready = useWorkerState((s) => s.ready);
  const simReady = useWorkerState((s) => s.simReady);
  const lutReady = useWorkerState((s) => s.lutReady);
  const msg = !ready ? "Initializing renderer..." : !simReady ? "Starting simulation..." : !lutReady ? "Loading color LUT..." : "Ready";
  return (
    <>
      <pixiGraphics draw={(g: any) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x0a0a1a, alpha: 1 }); }} />
      <ScaledText text="To The Ocean" x={width / 2} y={height / 2 - 30} anchor={0.5} style={{ fill: 0x4fc3f7, fontSize: 38, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <ScaledText text={msg} x={width / 2} y={height / 2 + 20} anchor={0.5} style={{ fill: 0x999999, fontSize: 18, fontFamily: "sans-serif" }} />
    </>
  );
}
