// Ocean Survival — DownDraft Engine
// Entry point; re-exports the public API from the refactored src/ modules.

export {
  consumeMeshesDirty, craftByRecipeId, dispose, getGameState, getInventoryState, getMeshData,
  getRenderData, getWaterData, getWeatherVisual, init, respawn, tick, toggleInventory
} from "./src/lifecycle.ts";

// Self-executing entry point (for `bun run examples/ocean-game/main.ts`)
if (import.meta.main) {
  const { init, tick, dispose } = await import("./src/lifecycle.ts");
  const { SIM_TICK_DT } = await import("./src/constants.ts");

  await init({});

  let lastTime = performance.now();
  let running = true;

  const onSignal = () => { running = false; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  (async () => {
    while (running) {
      const now = performance.now();
      let dt = (now - lastTime) / 1000;
      if (dt < SIM_TICK_DT) {
        await Bun.sleep(SIM_TICK_DT * 1000 - dt * 1000);
        dt = SIM_TICK_DT;
      }
      dt = Math.min(SIM_TICK_DT, dt);
      lastTime = performance.now();

      tick({}, dt);
    }
    dispose({});
  })();
}
