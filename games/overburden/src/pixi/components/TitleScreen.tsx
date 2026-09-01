// ============================================================================
// TitleScreen — full-screen start menu with "Start Game" button.
// ============================================================================

import { ScaledText } from "../font-scale-context";
import React from "react";
import { postAction } from "../worker-store";

export function TitleScreen({ width, height }: { width: number; height: number }) {
  return (
    <pixiContainer>
      <pixiGraphics
        draw={(g) => {
          g.clear();
          g.rect(0, 0, width, height).fill({ color: 0x1a1a2e, alpha: 0.95 });
        }}
      />
      <ScaledText
        text="Overburden"
        x={width / 2}
        y={height / 2 - 80}
        anchor={0.5}
        style={{ fill: 0xfdcb6e, fontSize: 50, fontFamily: "sans-serif", fontWeight: "bold" }}
      />
      <ScaledText
        text="A mining game built on the Downdraft Engine"
        x={width / 2}
        y={height / 2 - 30}
        anchor={0.5}
        style={{ fill: 0x999999, fontSize: 18, fontFamily: "sans-serif" }}
      />
      {/* Start Game button */}
      <pixiContainer
        x={width / 2 - 80}
        y={height / 2 + 20}
       
        onPointerDown={() => postAction({ kind: "startGame" })}
        eventMode="static"
        cursor="pointer"
      >
        <pixiGraphics
          draw={(g) => {
            g.clear();
            g.roundRect(0, 0, 160, 44, 8).fill({ color: 0x6c5ce7, alpha: 0.9 }).stroke({ width: 2, color: 0xa29bfe, alpha: 1 });
          }}
        />
        <ScaledText
          text="Start Game"
          x={80}
          y={22}
          anchor={0.5}
          style={{ fill: 0xffffff, fontSize: 20, fontFamily: "sans-serif", fontWeight: "bold" }}
        />
      </pixiContainer>
    </pixiContainer>
  );
}
