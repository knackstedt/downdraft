// ============================================================================
// Hud — in-game HUD shell. Contains all sub-components.
// ============================================================================

import React from "react";
import { useWorkerState } from "../worker-store";
import { FpsBar } from "./FpsBar";
import { AttributeBars } from "./AttributeBars";
import { BlockheadSelector } from "./BlockheadSelector";
import { Hotbar } from "./Hotbar";
import { NotificationToast } from "./NotificationToast";
import { PickupNotifications } from "./PickupNotifications";
import { GenderIndicator } from "./GenderIndicator";
import { InventoryPanel } from "./InventoryPanel";
import { StationPanel } from "./StationPanel";
import { TaskQueueDisplay } from "./TaskQueueDisplay";
import { PauseMenu } from "./PauseMenu";

export function Hud({ width, height }: { width: number; height: number }) {
  const showInventoryPanel = useWorkerState((s) => s.showInventoryPanel);
  const hasSelectedStation = useWorkerState((s) => s.hasSelectedStation);
  const showTaskQueue = useWorkerState((s) => s.showTaskQueue);
  const paused = useWorkerState((s) => s.paused);
  const deterministic = useWorkerState((s) => s.deterministic);

  return (
    <pixiContainer>
      <FpsBar width={width} />
      <AttributeBars />
      <BlockheadSelector />
      <Hotbar width={width} height={height} />
      <NotificationToast width={width} />
      <PickupNotifications width={width} />
      <GenderIndicator width={width} height={height} />
      {showInventoryPanel && <InventoryPanel width={width} height={height} />}
      {hasSelectedStation && <StationPanel />}
      {showTaskQueue && <TaskQueueDisplay />}
      {paused && !deterministic && <PauseMenu width={width} height={height} />}
    </pixiContainer>
  );
}
