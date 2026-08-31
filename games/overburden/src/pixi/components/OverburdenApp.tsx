// ============================================================================
// OverburdenApp — root @pixi/react component for the overburden UI.
//
// Routes between the title screen and the in-game HUD based on showTitleScreen.
// ============================================================================

import React from "react";
import { useWorkerState } from "../worker-store";
import { TitleScreen } from "./TitleScreen";
import { Hud } from "./Hud";

export function OverburdenApp({ width, height }: { width: number; height: number }) {
  const showTitleScreen = useWorkerState((s) => s.showTitleScreen);

  return (
    <pixiContainer>
      {showTitleScreen ? (
        <TitleScreen width={width} height={height} />
      ) : (
        <Hud width={width} height={height} />
      )}
    </pixiContainer>
  );
}
