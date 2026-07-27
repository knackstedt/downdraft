import React from "react";
import { useGameStore } from "../stores/gameStore";
import { SimBufferReader } from "@shared/sim-buffer";
import { GameMode } from "@shared/types";
import { simBridge } from "../simBridge";

export default function DeathScreen() {
  const playerDied = useGameStore((s) => s.playerDied);
  const renderer = useGameStore((s) => s.renderer);

  const [isHardcore, setIsHardcore] = React.useState(false);

  React.useEffect(() => {
    if (!playerDied || !renderer) return;
    const simReader = (renderer as any).simReader as SimBufferReader | null;
    if (!simReader || !simReader.isValid()) return;
    const gmIdx = simReader.getGamemode();
    const gm = Object.values(GameMode)[gmIdx];
    setIsHardcore(gm === GameMode.Hardcore);
  }, [playerDied, renderer]);

  const handleRespawn = () => {
    if (playerDied) {
      simBridge.respawnPlayer(playerDied.playerId);
      useGameStore.getState().setPlayerDied(null);
    }
  };

  const handleQuit = () => {
    simBridge.quit();
  };

  if (!playerDied) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-auto bg-red-950/80 z-50">
      <div className="hud-panel p-8 w-80 text-center">
        <h1 className="text-4xl font-bold text-red-400 mb-2">You Died</h1>
        <p className="text-ocean-300 text-sm mb-6 capitalize">
          Cause: {playerDied.cause}
        </p>
        <div className="space-y-3">
          {!isHardcore && (
            <button className="btn-primary w-full" onClick={handleRespawn}>
              Respawn
            </button>
          )}
          {isHardcore && (
            <p className="text-red-300 text-sm mb-4">
              Hardcore mode — death is permanent.
            </p>
          )}
          <button className="btn-danger w-full" onClick={handleQuit}>
            Quit to Desktop
          </button>
        </div>
      </div>
    </div>
  );
}
