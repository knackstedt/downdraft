import { ScaledText } from "../font-scale-context";
import { useWorkerState } from "../worker-store";

const HOTBAR_TOOLS = ["Builder", "Delete", "Rotate", "Gun", "Shovel"];
const SLOT_W = 44;
const SLOT_H = 36;
const GAP = 4;

export function Hotbar({ width, height }: { width: number; height: number }) {
  const activeSlot = useWorkerState((s) => s.hudState.activeSlot);
  const showBuilderWheel = useWorkerState((s) => s.showBuilderWheel);
  if (showBuilderWheel) return null;

  const totalW = HOTBAR_TOOLS.length * (SLOT_W + GAP) - GAP;
  const startX = (width - totalW) / 2;
  const y = height - SLOT_H - 12;

  return (
    <pixiContainer>
      {HOTBAR_TOOLS.map((name, i) => {
        const x = startX + i * (SLOT_W + GAP);
        const active = i === activeSlot;
        return (
          <pixiContainer key={i} x={x} y={y}>
            <pixiGraphics draw={(g: any) => {
              g.clear();
              g.roundRect(0, 0, SLOT_W, SLOT_H, 6)
                .fill({ color: active ? 0x2a2a4a : 0x111122, alpha: 0.9 })
                .stroke({ width: active ? 2 : 1, color: active ? 0xffcc44 : 0x333355, alpha: active ? 1.0 : 0.6 });
            }} />
            <ScaledText
              text={`${i + 1}`}
              x={4}
              y={2}
              style={{ fill: 0x666688, fontSize: 9, fontFamily: "monospace" }}
            />
            <ScaledText
              text={name}
              x={SLOT_W / 2}
              y={SLOT_H / 2}
              anchor={{ x: 0.5, y: 0.5 }}
              style={{ fill: active ? 0xffffff : 0x999999, fontSize: 11, fontFamily: "sans-serif" }}
            />
          </pixiContainer>
        );
      })}
    </pixiContainer>
  );
}
