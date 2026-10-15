---
title: Plugin Internals
description: PluginHost manifest model, formats, capability tiers, workshop stores, key files
---

## Modding / user-authored plugin system (`PluginHost` + `mod.json`)

The engine's **plugin system** — distinct from the compile-time **module** system — loads runtime extensions authored by end users / modders. `PluginHost` (`packages/engine/core/src/plugin/host.ts`) discovers, validates, normalizes, and loads manifests from local directories + remote workshop stores, then dispatches logic extensions (worker-js/wasm) and declarative extension buckets (assets/maps/physics/shaders) into a capability-restricted environment. Isolation is format-dependent: wasm/quickjs are hard-isolated, but `worker-js` plugins run as ordinary worker threads in the host runtime — globals are stripped best-effort, yet `import "node:fs"`/FFI/network still work unless the runtime itself is restricted. Remote workshop `BlobStore` packs are a supply-chain surface.

**Terminology:** **modules** = compile-time DI units (`Module`, `ModuleHost`, typed tokens) — engine/game internals. **Plugins/mods** = runtime-loadable user extensions (`PluginHost`, `mod.json`) — the modding surface.

### Manifest: `mod.json` (canonical — `plugin.json` is auto-normalized legacy)

A mod is "one manifest, many extensions": one id/version/game/permission set, optional logic, multiple declarative buckets.

```json
{
  "id": "my-mod",
  "name": "My Mod",
  "version": "1.0.0",
  "engineVersion": "^0.1.0",
  "game": "my-game",
  "format": "asset",
  "tier": "data",
  "thread": "renderer",
  "logic": {
    "format": "worker-js",
    "thread": "own-worker",
    "entry": "./src/index.ts",
    "permissions": ["ecs", "events", "physics"]
  },
  "extensions": {
    "assets": [{ "kind": "mesh", "id": "my-mod:crate", "path": "./assets/crate.glb" }],
    "maps": [{ "kind": "map", "id": "my-mod:arena", "path": "./maps/arena.json" }],
    "physics": [{ "kind": "physics", "id": "my-mod:bouncy", "path": "./physics/bouncy.json" }],
    "shaders": {
      "postfx": [{ "id": "my-mod:acid", "name": "Acid", "wgsl": "./shaders/acid.wgsl", "layout": "cc", "order": "stylized", "uniforms": 16 }],
      "materials": [{ "id": "my-mod:iridescent", "wgsl": "./shaders/iridescent.wgsl", "uniforms": 32 }]
    }
  }
}
```

### Plugin formats & capability tiers

| Format | Tier | Thread | Description |
|--------|------|--------|-------------|
| `worker-js` | `native` | `sim` or `own-worker` | TypeScript/JavaScript in a Web Worker. Full ECS + typed-DI (native tier) or limited API (script tier). |
| `quickjs` | `script` | `renderer` | JavaScript in a QuickJS WASM VM. Hard isolation — only the `ddPlugin` bridged global exists. Instruction-budget limited. |
| `wasm` | `native` | `own-worker` (always) | WebAssembly module with ABI v3. Host provides `env` + host-call imports; plugin exports `register`/`tick`/`dispose`/`on_event`/`on_host_call_result`. |
| `asset` | `data` | `renderer` | Data-only: textures, audio, meshes, JSON. No code entry. Registered into the `AssetManager`. |

- **`data`** — no permissions, no runtime API. **`script`** — limited API: events, state (KV), tick, log. **`native`** — full ECS + typed-DI via `NativePluginContext`.
- Permissions resolve as `requested ∩ tier-allowed ∩ game-allowlist` (`plugin/permissions.ts`). Logic plugins must NOT receive raw GPU APIs; the native tier grants nothing implicitly.
- Logic plugins mutate game state through mediated **host calls** (`spawn_prop`, `set_physics`, `apply_torque`, `get_asset_ref`, `publish_event`): WASM ABI v3 host-call imports + `on_host_call_result`; worker-js gets `ctx.hostCalls`.
- **Extension loaders** (`plugin/extension-loaders.ts`) are registered per bucket — `createAssetLoader`/`createMapLoader`/`createPhysicsLoader`/`createPostfxShaderLoader`/`createMaterialShaderLoader` (`registerAllExtensionLoaders` wires all five). `MaterialRegistry` tracks mod material shaders; `PostProcessStack.registerCustomEffect`/`setCustomEffectEnabled` slots mod postfx in at order-group boundaries (hdr/color-grading/camera/stylized).

### Game integration (`GameModule.plugins`)

```ts
startGame({
  plugins: {
    workerJs: "own-worker",  // or "sim"
    sources: [...],          // discovery sources
    permissions: new Set(["ecs", "events"]),  // game allowlist
    manifests: [...],        // pre-resolved manifests (tests / first-party)
  },
  // ...
});
```

`startGame()` builds a renderer-side `PluginHost`, registers the `WorkerPluginLoader`, discovers plugins, and loads them after renderer init. The host is exposed on `GameContext.pluginHost` for diagnostics + reloads (`PluginInfo` snapshot from `plugin/diagnostics.ts`; the devtools Doctor panel shows the cross-thread module report, not plugins).

### Discovery, scaffolding, MCP tools

- **Local**: `games/<game>/plugins/<id>/` (`mod.json` or `plugin.json`) — discovered by `draft plugin list` and the game's vite config. **Remote workshop**: `WorkshopFetcher` pulls packs from a `BlobStore` into `<cacheDir>/<id>@<version>/`.
- **CLI**: `draft mod new <name> --game <g> --with shader-postfx --with assets` (mod.json + buckets); `draft plugin new <name> --format worker-js --game <g>` (legacy plugin.json); `draft plugin list`. (`draft mod` = `draft plugin --mod`; both live in `packages/cli/src/plugin-command.ts` + `scaffold-plugin.ts`.)
- **MCP**: `createPluginMcpTools(pluginHost)` → `plugin_list`, `plugin_get_info`, `plugin_reload`, `plugin_unload`, `plugin_get_state`.
- **Game-side example**: `games/my-game` wires `PluginHost` via `src/plugin-host-bridge.ts` (adapts `ContentRegistry`→`AssetRegistry`, `PostProcessStack`+`MaterialRegistry`→`ShaderRegistry`, noop maps/physics). Sample mods live under `games/*/plugins/` (e.g. another-game's `bronze-blocks` worker-js / `crop-sprites-pack` asset; my-game's `speed-mode` quickjs / `custom-scorer` wasm).

### Key files & tests

All under `packages/engine/core/src/plugin/`: `host.ts` (PluginHost), `manifest.ts` (mod.json types/validation/normalization), `permissions.ts`, `context.ts` (tiered facades + host calls), `registry.ts` (dep sort), `loader-{worker,asset,quickjs,wasm}.ts` (+ inline variants), `wasm-abi.ts` (ABI v3), `sandbox-*.ts`, `extension-loaders.ts`, `material-registry.ts`, `workshop.ts`, `diagnostics.ts`, `mcp-tools.ts`. Game wiring: `app/src/main/game-module.ts` (`PluginRuntimeConfig`/`GameModule.plugins`). Tests: `bun test packages/engine/core/src/plugin` and `bun test packages/engine/libraries/postfx`.

