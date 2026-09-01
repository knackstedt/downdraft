import { ScaledText, useFontScale } from "../font-scale-context";
import { postAction } from "../worker-store";

export function SettingsPanel({ width, height }: { width: number; height: number }) {
  const fontScale = useFontScale();
  const x0 = Math.round((width - 400) / 2);
  const y0 = Math.round((height - 480) / 2);
  return (
    <pixiContainer x={x0} y={y0}>
      <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 400, 480, 8).fill({ color: 0x111122, alpha: 0.95 }).stroke({ width: 1, color: 0x333355, alpha: 0.7 }); }} />
      <ScaledText text="Settings" x={16} y={10} style={{ fill: 0xfdcb6e, fontSize: 18, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <pixiContainer x={368} y={8} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "toggleMenu", menu: "settings" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 24, 24, 4).fill({ color: 0x882222, alpha: 0.8 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <ScaledText text="×" x={12} y={12} anchor={0.5} style={{ fill: 0xffffff, fontSize: 18, fontFamily: "sans-serif" }} />
      </pixiContainer>
      <ScaledText text="Graphics" x={16} y={40} style={{ fill: 0x999999, fontSize: 14, fontFamily: "sans-serif", fontWeight: "bold" }} />
      {[
        { label: "Particle Density", key: "particleDensity", y: 60 },
        { label: "Pixelation", key: "pixelationEnabled", y: 84 },
        { label: "Post Processing", key: "postProcessEnabled", y: 108 },
      ].map((s) => (
        <pixiContainer key={s.key} x={16} y={s.y} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "setSetting", key: s.key, value: true })}>
          <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 18, 18, 3).fill({ color: 0x6c5ce7, alpha: 0.8 }).stroke({ width: 1, color: 0x555577, alpha: 0.7 }); }} />
          <ScaledText text={s.label} x={26} y={3} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
        </pixiContainer>
      ))}
      <ScaledText text="Accessibility" x={16} y={140} style={{ fill: 0x999999, fontSize: 14, fontFamily: "sans-serif", fontWeight: "bold" }} />
      <ScaledText text="UI Font Scale" x={16} y={162} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "sans-serif" }} />
      <ScaledText text={`${fontScale.toFixed(2)}×`} x={368} y={162} anchor={{ x: 1 }} style={{ fill: 0x4fc3f7, fontSize: 13, fontFamily: "sans-serif" }} />
      <pixiContainer x={16} y={184} eventMode="static"
        onPointerDown={(e: any) => {
          const trackX = 0, trackW = 368;
          const pct = Math.max(0, Math.min(1, (e.global.x - (x0 + 16) - trackX) / trackW));
          postAction({ kind: "setFontScale", scale: 1 + pct * 1.5 });
        }}
        onPointerMove={(e: any) => {
          if (e.buttons === 0) return;
          const trackX = 0, trackW = 368;
          const pct = Math.max(0, Math.min(1, (e.global.x - (x0 + 16) - trackX) / trackW));
          postAction({ kind: "setFontScale", scale: 1 + pct * 1.5 });
        }}
      >
        <pixiGraphics draw={(g: any) => {
          g.clear();
          g.roundRect(0, 8, 368, 4, 2).fill({ color: 0x333355 });
          const pct = Math.max(0, Math.min(1, (fontScale - 1) / 1.5));
          g.roundRect(0, 8, 368 * pct, 4, 2).fill({ color: 0x4fc3f7 });
          g.circle(368 * pct, 10, 8).fill({ color: 0xffffff });
        }} />
      </pixiContainer>
      <pixiContainer x={16} y={440} eventMode="static" cursor="pointer" onPointerDown={() => postAction({ kind: "quit" })}>
        <pixiGraphics draw={(g: any) => { g.clear(); g.roundRect(0, 0, 120, 28, 4).fill({ color: 0x882222, alpha: 0.5 }).stroke({ width: 1, color: 0xe74c3c, alpha: 0.6 }); }} />
        <ScaledText text="Exit Game" x={60} y={14} anchor={0.5} style={{ fill: 0xffffff, fontSize: 14, fontFamily: "sans-serif" }} />
      </pixiContainer>
    </pixiContainer>
  );
}
