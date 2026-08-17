import { useGameStore } from "../stores/game-store";

export default function PauseMenu() {
  const toggle = useGameStore((s) => s.togglePauseMenu);
  const isDev = useGameStore((s) => s.isDev);
  const simBridge = useGameStore((s) => s.simBridge);

  const handleSave = () => {
    simBridge?.saveGame("quicksave");
  };

  const handleLoad = () => {
    simBridge?.loadGame("quicksave");
  };

  const handleReset = () => {
    simBridge?.resetGame();
  };

  const handleQuit = () => {
    simBridge?.quit();
  };

  const handleResume = () => {
    toggle();
  };

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-auto bg-ocean-950/80" onClick={handleResume}>
      <div className="hud-panel p-8 w-64" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-2xl font-bold text-ocean-100 mb-6 text-center">Paused</h2>
        <div className="space-y-3">
          <button className="btn-primary w-full" data-resume="true" onClick={handleResume}>Resume</button>
          <button className="btn-secondary w-full" onClick={handleSave}>Save Game</button>
          <button className="btn-secondary w-full" onClick={handleLoad}>Load Game</button>
          <button
            className="btn-secondary w-full"
            onClick={() => useGameStore.getState().toggleSettings()}
          >
            Settings
          </button>
          <button
            className="btn-secondary w-full"
            onClick={() => useGameStore.getState().toggleCredits()}
          >
            Credits
          </button>
          {isDev && (
            <button className="btn-danger w-full" onClick={handleReset}>Reset Game</button>
          )}
          <button className="btn-danger w-full" onClick={handleQuit}>Quit</button>
        </div>
      </div>
    </div>
  );
}
