import { FloatingPortal, autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { BOAT_HOLD_INV_HEIGHT, BOAT_HOLD_INV_WIDTH, DAY_DURATION_SECONDS, PLAYER_INV_HEIGHT, PLAYER_INV_WIDTH } from "@shared/constants";
import { getItem } from "@shared/data/items";
import React from "react";
import { simBridge } from "../simBridge";
import { useGameStore } from "../stores/gameStore";

interface GridItem {
  x: number;
  y: number;
  itemId: string;
  quantity: number;
  spoilProgress: number;
  width: number;
  height: number;
}

interface GridCell {
  item: GridItem;
  isRoot: boolean;
}

function buildGridArray(items: GridItem[], width: number, height: number): (GridCell | null)[][] {
  const grid: (GridCell | null)[][] = Array.from({ length: height }, () => new Array(width).fill(null));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (let dy = 0; dy < item.height; dy++) {
      for (let dx = 0; dx < item.width; dx++) {
        const gx = item.x + dx;
        const gy = item.y + dy;
        if (gx >= 0 && gx < width && gy >= 0 && gy < height) {
          grid[gy][gx] = { item, isRoot: dx === 0 && dy === 0 };
        }
      }
    }
  }
  return grid;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

interface SpoilInfo {
  spoilPct: number;
  realTime: string;
  gameDays: string;
  gameHours: string;
  spoiled: boolean;
}

function getSpoilInfo(item: GridItem): SpoilInfo | null {
  const def = getItem(item.itemId);
  if (!def?.spoilRate) return null;
  const remaining = 1 - item.spoilProgress;
  if (remaining <= 0) {
    return { spoilPct: 100, realTime: "—", gameDays: "—", gameHours: "—", spoiled: true };
  }
  const gameHoursPerSecond = 24 / DAY_DURATION_SECONDS;
  const realSeconds = remaining / (def.spoilRate * gameHoursPerSecond);
  const gameHours = remaining / def.spoilRate;
  const gameDays = gameHours / 24;
  return {
    spoilPct: Math.floor(item.spoilProgress * 100),
    realTime: formatDuration(realSeconds),
    gameDays: gameDays.toFixed(1),
    gameHours: gameHours.toFixed(0),
    spoiled: false,
  };
}

function InventoryGrid({ items, width, height }: { items: GridItem[]; width: number; height: number }) {
  const grid = buildGridArray(items, width, height);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  return (
    <div
      className="grid gap-px bg-ocean-700/30"
      style={{ gridTemplateColumns: `repeat(${width}, 1fr)` }}
    >
      {grid.map((row, y) =>
        row.map((cell, x) => {
          if (!cell) {
            return (
              <div
                key={`${x}-${y}`}
                className="w-7 h-7 bg-ocean-800/50 border border-ocean-700/30 hover:bg-ocean-700/50"
              />
            );
          }
          if (!cell.isRoot) {
            return null;
          }
          const { item } = cell;
          const def = getItem(item.itemId);
          const spoil = getSpoilInfo(item);
          const key = `${item.x}-${item.y}`;
          return (
            <ItemCell
              key={key}
              item={item}
              def={def}
              spoil={spoil}
              isOpen={activeKey === key}
              onOpen={() => setActiveKey(key)}
              onClose={() => setActiveKey(null)}
            />
          );
        })
      )}
    </div>
  );
}

function ItemCell({
  item,
  def,
  spoil,
  isOpen,
  onOpen,
  onClose,
}: {
  item: GridItem;
  def: ReturnType<typeof getItem>;
  spoil: SpoilInfo | null;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    onOpenChange: (open) => (open ? onOpen() : onClose()),
    placement: "right",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  return (
    <>
      <div
        ref={refs.setReference}
        className="bg-ocean-600/60 border border-ocean-400/40 hover:bg-ocean-500/60 flex flex-col items-center justify-center text-xs text-ocean-50 cursor-pointer overflow-hidden"
        style={{
          gridColumn: `span ${item.width}`,
          gridRow: `span ${item.height}`,
        }}
        onMouseEnter={onOpen}
        onMouseLeave={onClose}
      >
        <span className="font-bold leading-tight">{def?.name ?? item.itemId}</span>
        <span className="text-ocean-200">×{item.quantity}</span>
        {spoil && !spoil.spoiled && (
          <span className="text-red-300 text-[10px]">{spoil.spoilPct}%</span>
        )}
        {spoil?.spoiled && (
          <span className="text-red-400 text-[10px] font-bold">SPOILED</span>
        )}
      </div>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 pointer-events-none bg-ocean-900/95 border border-ocean-600/50 rounded-lg p-3 shadow-xl text-xs text-ocean-100 whitespace-nowrap"
          >
            <div className="font-bold text-sm text-ocean-50 mb-1">{def?.name ?? item.itemId}</div>
            <div className="text-ocean-300 mb-2">×{item.quantity}</div>
            {spoil && (
              <div className="space-y-1 border-t border-ocean-700/50 pt-2">
                {spoil.spoiled ? (
                  <div className="text-red-400 font-bold">SPOILED</div>
                ) : (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="text-ocean-400">Spoilage:</span>
                      <span className="text-red-300">{spoil.spoilPct}%</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-ocean-400">Spoils in (real):</span>
                      <span className="text-ocean-100">{spoil.realTime}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-ocean-400">Spoils in (game):</span>
                      <span className="text-ocean-100">{spoil.gameDays} days ({spoil.gameHours}h)</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

export default function Inventory() {
  const toggle = useGameStore((s) => s.toggleInventory);
  const shipHoldData = useGameStore((s) => s.shipHoldData);
  const [activeTab, setActiveTab] = React.useState<"player" | "ship">("player");

  const showShipTab = shipHoldData?.isOnboard ?? false;
  const shipName = shipHoldData?.shipName ?? "Ship";
  const shipEntityId = shipHoldData?.shipEntityId ?? 0;

  React.useEffect(() => {
    if (!showShipTab && activeTab === "ship") {
      setActiveTab("player");
    }
  }, [showShipTab, activeTab]);

  const playerItems: GridItem[] = shipHoldData?.playerItems ?? [];
  const holdItems: GridItem[] = shipHoldData?.holdItems ?? [];

  const transferAllToShip = () => {
    for (const item of playerItems) {
      simBridge.sendCommand({
        type: "transfer_to_ship",
        playerId: 0,
        payload: { shipId: shipEntityId, fromX: item.x, fromY: item.y, quantity: item.quantity },
      });
    }
  };

  const transferAllToPlayer = () => {
    for (const item of holdItems) {
      simBridge.sendCommand({
        type: "transfer_from_ship",
        playerId: 0,
        payload: { shipId: shipEntityId, fromX: item.x, fromY: item.y, quantity: item.quantity },
      });
    }
  };

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto" onClick={toggle}>
      <div
        className="hud-panel p-6 max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tab bar */}
        <div className="flex gap-2 mb-4 border-b border-ocean-700/50 pb-2">
          <button
            className={`px-4 py-2 text-sm font-bold rounded-t transition-colors ${
              activeTab === "player"
                ? "bg-ocean-700/60 text-ocean-100"
                : "text-ocean-400 hover:text-ocean-200"
            }`}
            onClick={() => setActiveTab("player")}
          >
            Player
          </button>
          {showShipTab && (
            <button
              className={`px-4 py-2 text-sm font-bold rounded-t transition-colors ${
                activeTab === "ship"
                  ? "bg-ocean-700/60 text-ocean-100"
                  : "text-ocean-400 hover:text-ocean-200"
              }`}
              onClick={() => setActiveTab("ship")}
            >
              {shipName} — Hold
            </button>
          )}
          <div className="flex-1" />
          <button className="btn-secondary text-sm" onClick={toggle}>Close [I]</button>
        </div>

        {/* Tab content */}
        {activeTab === "player" ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold text-ocean-200">Player Inventory</h3>
              {showShipTab && playerItems.length > 0 && (
                <button
                  className="btn-secondary text-sm px-3 py-1.5"
                  onClick={transferAllToShip}
                >
                  Transfer All → {shipName}
                </button>
              )}
            </div>
            <InventoryGrid
              items={playerItems}
              width={PLAYER_INV_WIDTH}
              height={PLAYER_INV_HEIGHT}
            />
            <div className="mt-2 text-xs text-ocean-400">
              {PLAYER_INV_WIDTH}×{PLAYER_INV_HEIGHT} grid
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold text-ocean-200">{shipName} — Cargo Hold</h3>
              {holdItems.length > 0 && (
                <button
                  className="btn-secondary text-sm px-3 py-1.5"
                  onClick={transferAllToPlayer}
                >
                  ← Transfer All to Player
                </button>
              )}
            </div>
            <InventoryGrid
              items={holdItems}
              width={BOAT_HOLD_INV_WIDTH}
              height={BOAT_HOLD_INV_HEIGHT}
            />
            <div className="mt-2 text-xs text-ocean-400">
              {BOAT_HOLD_INV_WIDTH}×{BOAT_HOLD_INV_HEIGHT} grid
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
