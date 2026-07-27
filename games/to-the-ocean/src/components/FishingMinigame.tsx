import React from "react";
import { useGameStore } from "../stores/gameStore";
import { SimBufferReader, PLR } from "@shared/sim-buffer";

export default function FishingMinigame() {
  const renderer = useGameStore((s) => s.renderer);
  const [tension, setTension] = React.useState(50);
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    if (!renderer) return;
    const interval = setInterval(() => {
      const simReader = (renderer as any).simReader as SimBufferReader | null;
      if (!simReader || !simReader.isValid()) return;
      const playerSlot = simReader.getPlayerSlot(0);
      if (!playerSlot) return;
      setTension(playerSlot.f32[PLR.FISHING_TENSION] ?? 50);
      setProgress(playerSlot.f32[PLR.FISHING_PROGRESS] ?? 0);
    }, 50);
    return () => clearInterval(interval);
  }, [renderer]);

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto">
      <div className="hud-panel p-6 w-80">
        <h2 className="text-xl font-bold text-ocean-100 mb-4 text-center">Fishing</h2>

        {/* Tension bar */}
        <div className="mb-4">
          <div className="text-sm text-ocean-300 mb-1">Tension</div>
          <div className="relative h-8 bg-ocean-950 rounded-full overflow-hidden">
            {/* Danger zones */}
            <div className="absolute inset-y-0 left-0 w-[20%] bg-coral-600/30" />
            <div className="absolute inset-y-0 right-0 w-[20%] bg-coral-600/30" />
            {/* Good zone */}
            <div className="absolute inset-y-0 left-[30%] w-[40%] bg-biome-safe/20" />
            {/* Tension indicator */}
            <div
              className="absolute top-0 bottom-0 w-2 bg-ocean-300 rounded-full transition-all"
              style={{ left: `${tension}%`, transform: "translateX(-50%)" }}
            />
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-4">
          <div className="text-sm text-ocean-300 mb-1">Progress</div>
          <div className="h-4 bg-ocean-950 rounded-full overflow-hidden">
            <div
              className="h-full bg-ocean-400 rounded-full transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>

        <div className="text-center text-sm text-ocean-400">
          Hold to reel • Release to ease tension
        </div>

        {progress >= 1 && (
          <div className="mt-4 text-center text-biome-safe font-bold animate-fade-in">
            Caught! 🐟
          </div>
        )}
      </div>
    </div>
  );
}
