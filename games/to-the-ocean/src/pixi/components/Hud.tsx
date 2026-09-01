import { ScaledText } from "../font-scale-context";
import React from "react";
import { useWorkerState, postAction } from "../worker-store";

const WEATHER_NAMES = ["Clear", "Cloudy", "Rain", "Storm", "Fog"];
const BIOME_NAMES = ["Ocean", "Coast", "Island", "River", "Lake"];

function Bar({ label, value, max, color, x, y, w }: { label: string; value: number; max: number; color: number; x: number; y: number; w: number }) {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <>
      <ScaledText text={label} x={x} y={y} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
      <pixiGraphics x={x + 40} y={y} draw={(g: any) => {
        g.clear();
        g.roundRect(0, 0, w, 10, 3).fill({ color: 0x222222, alpha: 0.8 });
        g.roundRect(0, 0, w * ratio, 10, 3).fill({ color, alpha: 0.9 });
        g.roundRect(0, 0, w, 10, 3).stroke({ width: 1, color: 0x444444, alpha: 0.5 });
      }} />
      <ScaledText text={Math.round(value).toString()} x={x + 40 + w + 4} y={y} style={{ fill: 0xffffff, fontSize: 12, fontFamily: "monospace" }} />
    </>
  );
}

export function Hud({ width, height }: { width: number; height: number }) {
  const hud = useWorkerState((s) => s.hudState);
  const fps = useWorkerState((s) => s.fps);
  const waypoint = useWorkerState((s) => s.waypoint);
  // postAction imported at top

  return (
    <>
      {/* Top-left: stats */}
      <pixiContainer x={8} y={8}>
        <ScaledText text={`${Math.floor(fps)} FPS`} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "monospace" }} />
        <Bar label="HP" value={hud.health} max={hud.maxHealth} color={0xe74c3c} x={0} y={16} w={100} />
        <Bar label="Food" value={hud.hunger} max={100} color={0xe67e22} x={0} y={30} w={100} />
        <Bar label="Water" value={hud.thirst} max={100} color={0x3498db} x={0} y={44} w={100} />
        <Bar label="O2" value={hud.oxygen} max={hud.maxOxygen} color={0x2ecc71} x={0} y={58} w={100} />
        <ScaledText text={`Temp: ${hud.temperature.toFixed(0)}°C`} y={72} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
        <ScaledText text={`Gold: ${hud.gold}`} y={86} style={{ fill: 0xfdcb6e, fontSize: 13, fontFamily: "sans-serif" }} />
      </pixiContainer>

      {/* Top-right: time + weather + biome */}
      <pixiContainer x={width - 200} y={8}>
        <ScaledText text={`Time: ${(hud.timeOfDay * 24).toFixed(0)}:00`} style={{ fill: 0xffffff, fontSize: 13, fontFamily: "monospace" }} />
        <ScaledText text={`Weather: ${WEATHER_NAMES[hud.weatherType] ?? "Clear"}`} y={16} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
        <ScaledText text={`Biome: ${BIOME_NAMES[hud.biome] ?? "Ocean"}`} y={30} style={{ fill: 0x999999, fontSize: 12, fontFamily: "sans-serif" }} />
        {hud.isOnboard && <ScaledText text="[On Ship]" y={44} style={{ fill: 0x4fc3f7, fontSize: 12, fontFamily: "sans-serif" }} />}
        {hud.isPiloting && <ScaledText text="[Piloting]" y={58} style={{ fill: 0xfdcb6e, fontSize: 12, fontFamily: "sans-serif" }} />}
      </pixiContainer>

      {/* Waypoint indicator */}
      {waypoint && (
        <pixiContainer x={width / 2} y={height - 60}>
          <ScaledText text={`Waypoint: ${waypoint.x.toFixed(0)}, ${waypoint.z.toFixed(0)}`} anchor={0.5} style={{ fill: 0xfdcb6e, fontSize: 14, fontFamily: "sans-serif" }} />
        </pixiContainer>
      )}
    </>
  );
}
