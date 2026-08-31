// ============================================================================
// Hud — in-game HUD shell. Contains all sub-components.
// ============================================================================

import { useWorkerState } from "../worker-store";
import { AttributeBars } from "./AttributeBars";
import { BlockheadSelector } from "./BlockheadSelector";
import { FpsBar } from "./FpsBar";
import { GenderIndicator } from "./GenderIndicator";
import { Hotbar } from "./Hotbar";
import { InventoryPanel } from "./InventoryPanel";
import { NotificationToast } from "./NotificationToast";
import { PauseMenu } from "./PauseMenu";
import { PickupNotifications } from "./PickupNotifications";
import { StationPanel } from "./StationPanel";
import { TaskQueueDisplay } from "./TaskQueueDisplay";

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
