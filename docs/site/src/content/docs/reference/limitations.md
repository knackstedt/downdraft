---
title: Known Limitations
description: Documented gaps and footguns — accessibility, plugin isolation, platform coverage, footgun-prone APIs
---

This page lists gaps and sharp edges that are architectural or not yet
implemented — things to know before committing to the engine.

## Accessibility

Game UI (html-ui, world-space OSR panels) renders to GPU textures — there is
**no DOM and therefore no accessibility tree**. Screen readers, focus
traversal for assistive tech, and OS-level text-input services (IME on some
paths) are not wired. Keyboard/controller navigation inside documents exists
(`html-ui-kit` nav router, virtual cursor, OSK), but AT-SPI/UIA/NSAccessibility
integration is a known gap with no current implementation.

## Plugin isolation

Only `wasm` and `quickjs` plugin formats are hard-isolated. `worker-js`
plugins run as ordinary worker threads in the host JS runtime — globals are
stripped on a best-effort basis, but plugin code can still reach `node:fs`,
FFI, and the network unless the runtime itself is launched restricted. See
[Plugins](/guides/plugins/) for the full model.

## Platform coverage

- CI typechecks/lints/tests on Linux; native cdylibs are built for
  linux/win/mac (+android) by `native.yml` on release tags, and PR CI runs a
  cross-platform smoke suite (cli args, MCP transport, persistence) on
  Windows and macOS runners.
- The full packaging matrix (`dir`/`deb`/`appimage`/`flatpak` ×
  bun/node/deno) is exercised on Linux; `node`/`deno` embedded-runtime
  packaging is Linux-only today — win/mac compile to Bun binaries.
- Web UI backends: `cef` is the desktop default; `wpe` targets Linux/Android.

## Package size

Claims of "tens of megabytes" refer to **Bun-compiled** builds. A
Node-embedded package carries a ~100MB-class libnode/binary pair, roughly
double the Bun footprint. Android APKs embed libnode similarly.

## Footguns worth knowing

- **Swapchain frame retention**: on the native host, `getCurrentTexture()` is
  *not* idempotent — acquiring fabricates a frame and defeats dirty-tracking
  (blank-swapchain flashes). Renderers should use the renderer's
  `getFrameSurfaceTexture()`/`peekCurrentTexture()` path to *join* an
  in-flight frame rather than start one.
- **Rapier `.free()` ordering**: `world.free()`, collider/body `.free()`, and
  query-result `.free()` must happen in dependency order and never while a
  `world.step()` is pending on the same objects — the WASM instance traps
  ("Unreachable code") otherwise. `rapier-backend.ts` owns the correct
  ordering; prefer engine APIs over calling Rapier directly.
- **Shared WASM state in tests**: `bun test` must run with `--isolate` —
  without it, module/GC state shared across spec files corrupts the rapier
  WASM instance mid-step (this is why `bun run test` sets it).
- **Deprecated command removals**: `draft build|dist|export|mobile|
  build-games` are removed — use `draft release` stages (see
  [CLI reference](/reference/cli/)).
