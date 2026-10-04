---
title: Plugins
description: User-authored runtime plugins and mods — formats, capability tiers, permissions
---

DownDraft has a runtime plugin system for user-authored extensions and mods, distinct from the compile-time [module system](/guides/modules/). Plugins are discovered under `<game>/plugins/*/`, described by a `plugin.json` or `mod.json` manifest, and loaded by a per-thread `PluginHost` (`core/src/plugin`).

## Formats

|| Format | Description |
|---|---|
|| `worker-js` | JavaScript plugin running in a dedicated Web Worker |
|| `wasm` | WASM module — always runs in its own worker for crash isolation |
|| `quickjs` | Script evaluated in a sandboxed QuickJS VM (legacy `plugin.json` compat, instruction-budgeted) |
|| `asset` | Declarative content pack — no code; assets/maps/physics/shader extensions only |

## Capability tiers and threads

Each manifest declares a capability **tier** (`data` / `script` / `native`) and a target **thread** (`sim` / `renderer` / `own-worker`). The tier bounds which permissions a plugin may request — `ecs`, `gpu`, `physics`, `assets`, and similar — and the host intersects the request against the tier's allowlist and the game's allowlist before loading. WASM plugins are always forced to `own-worker`.

- **sim** — inside the game's sim worker (ECS system/component registration)
- **renderer** — in-process on the main thread (render passes, UI)
- **own-worker** — a dedicated Web Worker spawned per plugin

`mod.json` (scaffolded via `draft mod`) is the pack-style manifest: a `logic` extension plus declarative `extensions` (assets, maps, physics, shaders). `plugin.json` is the legacy single-format shape; both are normalized to the same internal model.

## Manifest

```jsonc
// <game>/plugins/my-plugin/plugin.json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "format": "worker-js",
  "tier": "script",
  "thread": "sim",
  "entry": "index.js",
  "permissions": ["ecs"],
  "requires": ["game:weather/state"],
  "dependencies": ["other-plugin@^1.0"]
}
```

The `PluginHost` validates the manifest, resolves permissions, computes a topological load order from `dependencies`, then invokes the format-specific loader with a tiered `PluginContext` facade.

## CLI

```bash
draft plugin list                                    # discovered plugins/mods in games/*/plugins/
draft plugin new my-plugin --game=my-game            # scaffold plugin.json (default: worker-js)
draft plugin new my-plugin --game=my-game --format=wasm
draft mod new my-mod --game=my-game                  # scaffold mod.json (default: asset)
```

See the [CLI reference](/reference/cli/) for the full flag list.
