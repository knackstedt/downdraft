import React from "react";
import { useWorkerState } from "../worker-store";
import { TitleScreen } from "./TitleScreen";
import { Hud } from "./Hud";
import { Minimap } from "./Minimap";
import { InventoryPanel } from "./InventoryPanel";
import { SignpostOverlay } from "./SignpostOverlay";
import { SignpostPrompt } from "./SignpostPrompt";
import { VillageOverlay } from "./VillageOverlay";
import { ShopPanel } from "./ShopPanel";
import { BombOverlay } from "./BombOverlay";
import { ChunkDebugOverlay } from "./ChunkDebugOverlay";
import { DeathMenu } from "./DeathMenu";
import { EscapeMenu } from "./EscapeMenu";
import { StatsPanel } from "./StatsPanel";
import { AchievementsPanel } from "./AchievementsPanel";
import { AchievementNotification } from "./AchievementNotification";
import { KeyBindingsOverlay } from "./KeyBindingsOverlay";
import { OreTooltip } from "./OreTooltip";
import { DepthNotification } from "./DepthNotification";
import { DangerVignette } from "./DangerVignette";
import { ParticleEffects } from "./ParticleEffects";
import { ScreenShake } from "./ScreenShake";
import { WelcomeBack } from "./WelcomeBack";
import { CraftingPanel } from "./CraftingPanel";
import { UpgradeShop } from "./UpgradeShop";

export function MiningApp({ width, height }: { width: number; height: number }) {
  const showTitleScreen = useWorkerState((s) => s.showTitleScreen);
  if (showTitleScreen) return <TitleScreen width={width} height={height} />;
  return (
    <>
      {useWorkerState((s) => s.showHUD) && <Hud width={width} height={height} />}
      {useWorkerState((s) => s.showMinimap) && <Minimap width={width} height={height} />}
      <InventoryPanel width={width} height={height} />
      <SignpostOverlay width={width} height={height} />
      <SignpostPrompt width={width} height={height} />
      <VillageOverlay width={width} height={height} />
      {useWorkerState((s) => s.showShop) && <ShopPanel width={width} height={height} />}
      <BombOverlay width={width} height={height} />
      <ChunkDebugOverlay width={width} height={height} />
      {useWorkerState((s) => s.gameOver) && <DeathMenu width={width} height={height} />}
      {useWorkerState((s) => s.showEscapeMenu) && <EscapeMenu width={width} height={height} />}
      {useWorkerState((s) => s.showStats) && <StatsPanel width={width} height={height} />}
      {useWorkerState((s) => s.showAchievements) && <AchievementsPanel width={width} height={height} />}
      <AchievementNotification width={width} height={height} />
      {useWorkerState((s) => s.showHelp) && <KeyBindingsOverlay width={width} height={height} />}
      <OreTooltip width={width} height={height} />
      <DepthNotification width={width} height={height} />
      <DangerVignette width={width} height={height} />
      <ParticleEffects width={width} height={height} />
      <ScreenShake width={width} height={height} />
      <WelcomeBack width={width} height={height} />
      <CraftingPanel width={width} height={height} />
      <UpgradeShop width={width} height={height} />
    </>
  );
}
