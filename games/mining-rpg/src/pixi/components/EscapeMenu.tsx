import { ScaledText, useFontScale } from "../font-scale-context";
import { postAction } from "../worker-store";

export function EscapeMenu({ width, height }: { width: number; height: number }) {
  const fontScale = useFontScale();
  const panelW = 280;
  const panelH = 200;
  const x0 = Math.round((width - panelW) / 2);
  const y0 = Math.round((height - panelH) / 2);

  return (
    <pixiContainer>
      <pixiGraphics draw={(g) => { g.clear(); g.rect(0, 0, width, height).fill({ color: 0x000000, alpha: 0.6 }); }} />
      <pixiContainer x={x0} y={y0}>
        <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, panelW, panelH, 8).fill({ color: 0x1a1a2e, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
        <ScaledText text="Paused" x={panelW / 2} y={16} anchor={{ x: 0.5, y: 0 }} style={{ fill: 0xfdcb6e, fontSize: 20, fontFamily: "sans-serif", fontWeight: "bold" }} />
        {/* Font scale slider */}
        <ScaledText text="UI Font Scale" x={30} y={50} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
        <ScaledText text={`${fontScale.toFixed(2)}×`} x={panelW - 30} y={50} anchor={{ x: 1 }} style={{ fill: 0x4fc3f7, fontSize: 13, fontFamily: "sans-serif" }} />
        <pixiContainer x={30} y={68} eventMode="static"
          onPointerDown={(e: any) => {
            const trackW = 220;
            const pct = Math.max(0, Math.min(1, (e.global.x - x0 - 30) / trackW));
            postAction({ kind: "setFontScale", scale: 1 + pct * 1.5 });
          }}
          onPointerMove={(e: any) => {
            if (e.buttons === 0) return;
            const trackW = 220;
            const pct = Math.max(0, Math.min(1, (e.global.x - x0 - 30) / trackW));
            postAction({ kind: "setFontScale", scale: 1 + pct * 1.5 });
          }}
        >
          <pixiGraphics draw={(g) => {
            g.clear();
            const trackW = 220;
            g.roundRect(0, 8, trackW, 4, 2).fill({ color: 0x333355 });
            const pct = Math.max(0, Math.min(1, (fontScale - 1) / 1.5));
            g.roundRect(0, 8, trackW * pct, 4, 2).fill({ color: 0x4fc3f7 });
            g.circle(trackW * pct, 10, 8).fill({ color: 0xffffff });
          }} />
        </pixiContainer>
        {/* Resume */}
        <pixiContainer x={30} y={110} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "resume" })}>
          <pixiGraphics draw={(g) => { g.clear(); g.roundRect(0, 0, 220, 32, 6).fill({ color: 0x6c5ce7, alpha: 0.9 }).stroke({ width: 1, color: 0xa29bfe, alpha: 0.7 }); }} />
          <ScaledText text="Resume" x={110} y={16} anchor={0.5} style={{ fill: 0xffffff, fontSize: 16, fontFamily: "sans-serif", fontWeight: "bold" }} />
        </pixiContainer>
      </pixiContainer>
    </pixiContainer>
  );
}
