# sandjongg-speed-mode

Sample user-authored plugin for **Sandjongg** (Downdraft Engine).

- **Format:** `quickjs` (JavaScript, runs in a QuickJS WASM VM)
- **Tier:** `script` (limited API: events, state, tick, log — no ECS/DI access)
- **Thread:** `renderer` (runs in-process on the renderer thread)

## What it does

Adds a **Speed Mode** that doubles tile match scoring for 30 seconds when activated. It:

1. Subscribes to `sandjongg:activate_speed_mode` events to start the speed mode.
2. While active, subscribes to `sandjongg:tile_matched` events and publishes `sandjongg:score_boosted` with the doubled score.
3. Uses the tick API to count down the 30-second duration, then publishes `sandjongg:speed_mode_expired`.
4. Persists speed mode state (active flag + remaining time) in the per-plugin KV store.

## Demonstrates

- Script-tier `PluginContext` via the QuickJS bridge: `events.subscribe/publish`, `state.get/set`, `tick.onTick`, `log`, `onDispose`.
- QuickJS VM isolation: the plugin code runs in a sandboxed WASM VM with only the `ddPlugin` bridged global.
- Instruction budget limiting (`quickjs.instructionBudget: 500000` in the manifest).
- Pure JavaScript plugin entry (no TypeScript compilation needed — the QuickJS VM evals JS directly).

## Files

- `plugin.json` — manifest declaring format `quickjs`, tier `script`, permissions, and instruction budget.
- `src/index.js` — plugin entry (plain JavaScript, defines a `register` function).
