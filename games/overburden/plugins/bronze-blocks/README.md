# overburden-bronze-blocks

Sample user-authored plugin for **Overburden** (Downdraft Engine).

- **Format:** `worker-js` (TypeScript, runs in a sandboxed Web Worker)
- **Tier:** `native` (full ECS + typed-DI access)
- **Thread:** `sim` (runs inside Overburden's sim worker)

## What it does

Adds a **Bronze Block** block definition + a **furnace smelting recipe** (copper ore + tin ore → bronze block) to the game. It:

1. Provides a typed `BronzeBlockTok` resource token carrying the block def + recipe, which the game injects to register the block at runtime.
2. Registers a one-shot ECS system that publishes an `overburden:bronze_block_registered` event on first tick.
3. Records registration metadata in the per-plugin KV state store.

## Demonstrates

- Native-tier `PluginContext`: `provide()` / typed tokens, `registerSystem()`, event bus, KV state, `onDispose()`.
- Manifest with `provides` / `permissions` / `thread`.
- Plugin ↔ game integration via typed DI (the game injects `BronzeBlockTok`).

## Run

The plugin is discovered from `games/overburden/plugins/bronze-blocks/` when Overburden declares `plugins: { sources: [...] }` in its `GameModule`. See `plugin.json` for the manifest.
