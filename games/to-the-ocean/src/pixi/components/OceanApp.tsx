import React from "react";
import { useWorkerState } from "../worker-store";
import { LoadingScreen } from "./LoadingScreen";
import { Hud } from "./Hud";
import { NotificationStack } from "./NotificationStack";
import { Reticule } from "./Reticule";
import { ClickToResume } from "./ClickToResume";
import { Inventory } from "./Inventory";
import { MapView } from "./MapView";
import { BuildMenu } from "./BuildMenu";
import { CraftMenu } from "./CraftMenu";
import { FishingMinigame } from "./FishingMinigame";
import { TradeMenu } from "./TradeMenu";
import { SettingsPanel } from "./SettingsPanel";
import { PauseMenu } from "./PauseMenu";
import { CharacterCustomization } from "./CharacterCustomization";
import { CreditsScreen } from "./CreditsScreen";
import { BuilderWheel } from "./BuilderWheel";
import { DeathScreen } from "./DeathScreen";

export function OceanApp({ width, height }: { width: number; height: number }) {
  const ready = useWorkerState((s) => s.ready);
  const simReady = useWorkerState((s) => s.simReady);
  const lutReady = useWorkerState((s) => s.lutReady);
  const hudHidden = useWorkerState((s) => s.hudHidden);
  const pointerLocked = useWorkerState((s) => s.pointerLocked);
  const showInventory = useWorkerState((s) => s.showInventory);
  const showMap = useWorkerState((s) => s.showMap);
  const showBuildMenu = useWorkerState((s) => s.showBuildMenu);
  const showCraftMenu = useWorkerState((s) => s.showCraftMenu);
  const showFishingMinigame = useWorkerState((s) => s.showFishingMinigame);
  const showTradeMenu = useWorkerState((s) => s.showTradeMenu);
  const showSettings = useWorkerState((s) => s.showSettings);
  const showPauseMenu = useWorkerState((s) => s.showPauseMenu);
  const showCharacterCustomization = useWorkerState((s) => s.showCharacterCustomization);
  const showCredits = useWorkerState((s) => s.showCredits);
  const showBuilderWheel = useWorkerState((s) => s.showBuilderWheel);
  const playerDied = useWorkerState((s) => s.playerDied);

  const allReady = ready && simReady && lutReady;
  const anyMenuOpen = showInventory || showMap || showBuildMenu || showCraftMenu ||
    showFishingMinigame || showTradeMenu || showSettings || showPauseMenu ||
    showCharacterCustomization || showCredits || showBuilderWheel;
  const showClickToResume = !pointerLocked && !anyMenuOpen && !playerDied && allReady;

  return (
    <>
      {!allReady && <LoadingScreen width={width} height={height} />}
      {allReady && !hudHidden && <Hud width={width} height={height} />}
      {allReady && !hudHidden && <NotificationStack width={width} />}
      {allReady && !hudHidden && <Reticule width={width} height={height} />}
      {showClickToResume && <ClickToResume width={width} height={height} />}
      {showInventory && <Inventory width={width} height={height} />}
      {showMap && <MapView width={width} height={height} />}
      {showBuildMenu && <BuildMenu width={width} height={height} />}
      {showCraftMenu && <CraftMenu width={width} height={height} />}
      {showFishingMinigame && <FishingMinigame width={width} height={height} />}
      {showTradeMenu && <TradeMenu width={width} height={height} />}
      {showSettings && <SettingsPanel width={width} height={height} />}
      {showPauseMenu && <PauseMenu width={width} height={height} />}
      {showCharacterCustomization && <CharacterCustomization width={width} height={height} />}
      {showCredits && <CreditsScreen width={width} height={height} />}
      {showBuilderWheel && <BuilderWheel width={width} height={height} />}
      {playerDied && <DeathScreen width={width} height={height} />}
    </>
  );
}
