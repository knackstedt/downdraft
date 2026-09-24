# DORMANT — Electron-only code

This directory is part of the retired Electron runtime path. It stays
in-tree during the native migration bake period but is unreachable from
default flows — `draft dev`/`draft test`/`draft release` run the native
runtime (Bun + SDL + wgpu-native) only.

Do not build on this code. It will be deleted in the post-bake cleanup
(Track E2). For the live equivalents see:

- `packages/platform-native/` — native host (window, GPU, bridge, MCP)
- `app/src/renderer/` — renderer bootstrap (runtime-agnostic)
- `app/src/shared/types.ts` — the bridge API contract implemented by the
  native bridge in `platform-native/src/bridge/native-bridge.ts`
