# ADR 0003: Interchangeable JS host runtime (Bun / Node+tsx / Deno)

Status: Accepted

## Context

Bun is the repo's package manager, test runner, and packaging compiler — but
tying the *game runtime* to Bun would couple games to one vendor's runtime and
exclude teams standardized on Node or Deno.

## Decision

The JS runtime is a host, not the engine. `draft dev --runtime bun|node|deno`
(default auto-detect) and `draft release --runtime=...` select it. FFI adapts
via `bun:ffi` / `koffi` / `Deno.dlopen` behind `ffi-adapter.ts`; runtime
capabilities are probed through `platform/runtime.ts`.

## Consequences

- Engine and game runtime code must never assume Bun-only APIs (`Bun.*`,
  `bun:ffi`, `bun:test`). Use the runtime abstractions.
- `bun.lock` is the repo's lockfile; Deno uses the generated `deno.json`
  import map (`scripts/gen-deno-import-map.mjs`, checked in CI).
- Packaging footprints differ by host — Bun-compiled binaries are smallest;
  Node-embedded builds are roughly double. Public claims about package size
  should name the runtime they assume.
