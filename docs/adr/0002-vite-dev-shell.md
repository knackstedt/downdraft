# ADR 0002: Vite stays as the dev-shell transform/HMR engine

Status: Accepted (evaluated 2026-10 — do not re-litigate without new facts)

## Context

Native dev needs HMR for app code: module-level invalidation, accept-boundary
propagation, and escalation to worker/session/host restart tiers. The dev
shell (`dev-shell.mjs` + `native-dev-runtime.ts`) embeds Vite as a
`RunnableDevEnvironment` — not `vite dev`, and no browser-facing server.

## Decision

The dev shell keeps Vite for exactly four things:

1. The transform pipeline (TS/JSX, `?raw`, `import.meta.glob`)
2. The resolver (tsconfig aliases + runtime export conditions)
3. The `ModuleRunner` module graph with accept-boundary propagation
4. watcher→`hotUpdate` wiring (where the tier classifier lives)

Alternatives evaluated and rejected:

- **rolldown `DevEngine`** (`rolldown/experimental`) — real HMR is
  client-env-only; the node platform is restart-based ("patches carry no
  applier"). Revisit when in-process node HMR lands.
- **dynohot** — vite-style `import.meta.hot` via a Node `--import` loader,
  but Node-only; breaks tri-runtime.
- **immaculata** — Node module hooks with invalidation events, but no
  accept-boundary propagation engine.
- **unjs/env-runner** — integrates *with* Vite's Environment API; a
  complement, not a replacement.
- **`bun --hot`** — entrypoint-reload semantics, no per-file tier
  classification, Bun-only.
- **Roll our own** — months of work for the propagation engine alone.

If the Vite surface ever needs swapping, wrap it behind a
`createDevEngine()` seam rather than migrating cold.

## Gotcha — middlewareMode HMR port

The dev shell runs `createServer` with `middlewareMode`, so Vite would
otherwise bind its HMR WebSocket server on TCP 24678 (nothing ever connects —
the `native` env uses the in-process `createServerHotChannel`).
`vite-config.mjs` passes `server.hmr.server` a never-listened `http.Server` so
Vite attaches an upgrade listener instead of binding. Do **not** "fix" this
with `server.hmr: false` — that disables the `handleHMRUpdate` pipeline the
tier classifier depends on.
