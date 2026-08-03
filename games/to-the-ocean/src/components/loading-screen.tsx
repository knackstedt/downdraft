import { useGameStore } from "../stores/game-store";

export default function LoadingScreen() {
  const { ready, simReady, lutReady } = useGameStore();

  const stage = !ready ? "Initializing WebGPU..." :
    !lutReady ? "Preparing lighting..." :
    !simReady ? "Starting simulation..." :
    "Loading world...";

  const progress = simReady ? 100 : lutReady ? 75 : ready ? 50 : 25;

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-ocean-950">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-ocean-200 mb-4 text-shadow">
          To The Ocean
        </h1>
        <div className="text-ocean-400 text-lg mb-8 animate-pulse">
          {stage}
        </div>
        <div className="w-64 h-2 bg-ocean-900 rounded-full overflow-hidden mx-auto">
          <div
            className="h-full bg-ocean-400 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
