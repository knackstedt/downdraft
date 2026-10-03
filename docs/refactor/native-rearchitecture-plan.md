# Native Re-architecture Plan — Removing the Electron Process Model

**Status:** ACTIVE — progress tracked inline (checkboxes + Progress Log).
**Created:** 2026-09-28
**Scope:** Replace every architecture decision that exists *because* of the
Electron main/renderer process split with a native-first design, then delete
the dormant Electron tree.

**Do not commit this file.** It is a working progress ledger.

---

## Design principles (agreed 2026-09-28)

1. **Correct/performant long-term design wins over matching current
   behavior.** Where the current shape exists only to satisfy Chromium's
   process model, replace it rather than shim it.
2. **The bridge contract is replaced in-place** — no parallel
   `DowndraftBridgeAPI` + `NativeHostAPI` overlap period. Games are updated
   in the same pass.
3. **A real `RenderSurface` abstraction replaces the DOM/canvas ABI.** The
   HTMLCanvasElement shape becomes a thin compat view for web-shaped
   consumers (PixiJS) only — not the engine contract.
4. **GPU is not treated as single-renderer-owned.** wgpu devices are
   Send+Sync FFI handles; nothing prevents sharing one device across worker
   threads or running multiple devices. The Electron-era constraint "all GPU
   work funnels through the renderer process's one device" does not apply on
   native, and the re-architecture must not bake it back in.
5. **The dormant Electron tree is deleted as the final phase**, not kept
   around indefinitely.

---

## Findings this plan addresses

Condensed from the 2026-09-28 architecture review:

- **Saves**: `IpcSaveStore` (marked `// DORMANT`) is actually the *default*
  save backend on native. It does a JSON round-trip that exists only for
  structured-clone, and fabricates results (`gen: 1`, `bytes: 0`, empty
  meta) to fit the `Promise<boolean>` IPC signature.
- **GPU**: two wgpu devices share one surface — `createNativeHost` creates
  device+configures, then `GameRenderer.init()` requests a second adapter +
  device and reconfigures. Readback hook has to guess which device last
  configured the surface. Limits are negotiated twice, inconsistently
  (host: 256MB storage buffers; GameRenderer: clamps to 64MB).
- **Bridge**: `DowndraftBridgeAPI` forces the native host to stub/fabricate
  ~15 Chromium-only members (tracing, heap snapshots, V8 GC stats, shared
  textures, `ElectronGPUInfo`, `openChromeUrl`, `"main"|"renderer"` process
  targets). Channel-string event emitter replicates `ipcRenderer.on` in-process.
- **DOM ABI**: `getCanvas()`/`getOverlay()`/`mountUI(HTMLElement)` speak DOM
  selectors; native answers with ~450 lines of `document`/`window`/
  `HTMLCanvasElement`/`FileReader`/`ResizeObserver` polyfills, plus a
  `VirtualCanvasContext` whose `getCurrentTexture()` returns a persistent
  texture to satisfy PixiJS's canvas-shaped API.
- **Policy**: `disableRendererIndexedDb()` throws on `indexedDB.open` by
  default — a renderer-sandbox policy in a single process. Device-loss
  recovery is built around `window.location.reload()`. Telemetry splits
  `main`/`renderer` process stats; feature log emits `dd-main`/`dd-render`
  scopes for one process.
- **Unmarked dormant**: `app/src/vite/` (electron-vite factory + 8 plugins,
  still exported as `@downdraft/engine/app/vite`), `core/src/main.ts`
  (`initEngine`), most of `core/src/platform/` (WindowManager, VirtualFS,
  Lifecycle, HiDPIManager).
- **Tooling**: `electron`/`electron-builder` are real deps in root + all 8
  game package.jsons; `bunfig.toml` test-preloads `tests/electron-mock.ts`;
  `draft release` desktop targets hard-error pointing at
  `scripts/package-native.mjs`; `--format` vocabulary is electron-builder's.
- **Docs**: `docs/site/.../process-model.md` describes the Electron
  main/renderer/SurrealDB-worker model; AGENTS.md says "no native HMR" while
  `dev-shell.mjs` implements 5-tier Vite ModuleRunner HMR.
- **Games**: ad-hoc `isNativeHost = !!globalThis.__nativeHost` gates
  scattered in game modules instead of a capability surface;
  `downdraft.config.json` `builder.mode` is dead; per-game
  `main.ts`/`preload.ts`/`electron.vite.config.ts` dormant.

---

## Phase 0 — Reconciliation & capability surface

Goal: stop the bleeding — fix labels that lie and give games a capability
query so `!!__nativeHost` branching stops spreading.

- [x] Un-mark `app/src/renderer/ipc-save-store.ts` — DORMANT header replaced
  with an accurate header noting it is the LIVE bridge-backed save store
  until Phase 1 replaces it.
- [x] `HostCapabilities` descriptor added in `core/src/platform/runtime.ts`
  (`runtime`, `hasDom`, `hasOpfs`, `hasSharedTexture`, `hasTracing`,
  `hasHeapSnapshot`, `supportsMultiWorkerGpu` — last one false until the
  Phase-5 spike proves it). Exported via `core/index.ts`; optional
  `capabilities` member on `DowndraftBridgeAPI`, populated by
  `createNativeBridge` with `NATIVE_HOST_CAPABILITIES`.
  `getHostCapabilities()` prefers the bridge field, falls back to the
  `__nativeHost` marker (module-eval-safe), then browser defaults.
  `getNativeHost()` returns the live host object for the few legit GPU-handle
  consumers.
- [x] Game `__nativeHost` gates routed through capabilities/host accessors:
  `andrews-sandbox/game-module.tsx`, `overburden/game-module.ts`,
  `downdraft-model-viewer/main.tsx` (4 sites), `downdraft-gpu-bench/main.tsx`
  (2 sites), `examples/pixi-ui-demo/game-module.ts`,
  `test-beds/ui-bakeoff/stacks/pixi.ts`, engine-internal
  `asset-browser/scene.ts` and `standard-automation-tools.ts`.
  Platform-native internals (host lifecycle, dev shell, dev runtime) keep
  reading `__nativeHost` directly — that marker is now platform-internal.
- [x] AGENTS.md corrected: native dev has tiered ModuleRunner HMR (not
  restart-only); dormant-surfaces list updated (added `app/src/vite`,
  `app/src/mobile`, `core/src/main.ts`, dead `core/src/platform/*`,
  devtools extension, per-game vite/html entries; removed the mislabeled
  `ipc-save-store.ts`).
- [x] Dormant markers added: `app/src/vite/DORMANT.md` + headers on
  `index.ts`/`mobile.ts`; `app/src/mobile/DORMANT.md` + index header;
  `core/src/main.ts`; `core/src/platform/{fs,lifecycle,window,time,hdr}.ts`;
  `tests/pixi-polyfill/browser/electron-main.mjs`;
  `examples/{pixi-ui-demo,plugin-tester}/electron.vite.config.ts`;
  all 8 game `index.html`s; `model-viewer/vite.config.ts`,
  `sandjongg/vite.polyfill-test.config.ts`, `mining-rpg`/`to-the-ocean`
  `vite-options.ts`. (`platform/css-stub.ts` initially listed but is LIVE —
  bun-preload resolves `.css` imports to it; `platform/hidpi.ts` is live via
  `getDpr`.)

**Exit criteria:** no file on the live path claims to be dormant; no dormant
file lacks a marker; games query capabilities, not `__nativeHost`.

---

## Phase 1 — Save path repair (native save store)

Goal: one save path, native-shaped, real metadata.

- [x] `HostServicesApi` gained typed `saveState`/`loadState` (structured-
  cloneable `SaveState`/`SaveResult`/`LoadResult` end-to-end, forwarded by
  `scopeServicesForPlugin`); `createInlineServices` calls `FileSaveStore`
  directly — real `bytes`/`gen`/`meta`, `engineVersion`/`timestamp` default
  from services init when unset.
- [x] `HostSaveStore` (`platform-native/src/services/host-save-store.ts`) —
  `ISaveStore` over `HostServicesApi` with real warning fan-out. Exposed on
  the bridge as `downdraft.saveStore` (`DowndraftBridgeAPI.saveStore`).
- [x] `SaveStoreMode` `"ipc"` → `"host"` renamed across
  `save-store-factory`, `GameSaveConfig.mode`, `GameContext.saveMode`,
  `createSimBridge` (engine + to-the-ocean copy), `createDefaultSaveStore`.
  `SaveBridge` moved into `save-store-factory` with the `saveStore` member.
- [x] `ctx.save`/`ctx.load` route through `ctx.saveStore` in host mode —
  real `SaveState` written (real `bytes`), `downdraft.saveGameState` kept
  only as a no-store fallback.
- [x] `"auto"` no longer flips on native: `downdraft.saveStore` present →
  `"host"` directly (no 5s worker-timeout IPC dance; OPFS can't exist on
  native). Browser OPFS path retained.
- [x] `ipc-save-store.ts` deleted — `IpcSaveStore`'s fabricated
  `gen: 1`/`bytes: 0`/empty meta is gone. `index.ts` exports `SaveBridge`
  from the factory now.
- [x] Verified: `bun test` core+app+platform-native 1667 pass; typed
  round-trip script exercises HostSaveStore→FileSaveStore — real bytes,
  timestamp, entityCount, engineVersion, slot listing, properties. Game
  save configs: andrews-sandbox pins `mode: "host"`; to-the-ocean `"auto"`
  now resolves to `"host"`.
- [x] Post-validation fixes: `"inline"` mode preserved (no longer collapses
  to `"host"` → `initSaveStore` runs); worker `save()` returns/emits real
  `SaveMeta` and `ctx.save`/`createSimBridge` persist it; multi-component
  saves restore the full components map (`serializeRestorePayload`);
  `saved` events are `origin`-tagged so to-the-ocean writes each save
  exactly once; `BridgeJsonSaveStore` keeps `auto` non-throwing on
  headless/stub hosts; `appId` added to the three games that had no bridge.
- [x] New specs: `host-save-store.spec.ts`, `game-module.spec.ts`
  (restore payload), meta/origin assertions in `sim-worker-base.spec.ts`.

**Exit criteria:** `save()` returns the real generation; no JSON
serialization happens twice on the native path; "ipc" appears nowhere in
live save code. ✔ met (the legacy `saveGameState`/`loadGameState` bridge
methods remain as fallback until Phase 3 drops the IPC-shaped contract).

---

## Phase 2 — Single GPU device

Goal: one device, one surface, one owner — prerequisite for Phase 5.

- [x] Decide ownership direction: **host creates, renderer borrows.**
  `createNativeHost` already owns adapter+device+surface; `GameRenderer`
  resolves `config.device/adapter` → `getNativeHost().device/adapter` →
  self-acquire, in that order.
- [x] `GameRenderer.init()`: when borrowing the host's device, skip
  `requestAdapterWithFallback`/`requestDeviceFromAdapter` and the second
  `context.configure()` (`hostConfiguredSurface`). The self-acquire path is
  kept for browser/standalone hosts.
- [x] Unify limits negotiation — `createNativeHost` requests the union of
  host + renderer required limits (256MB storage buffers, 32 samplers, …)
  and `timestamp-query` when the adapter supports it.
- [x] Kill the `ctx.getDevice() ?? device` readback ambiguity in
  `native-host.ts` — with one device the hook can capture it directly.
- [x] Update `to-the-ocean/src/native-entry.ts` and other bespoke entries
  that work around the split (`renderer.getDevice?.() ?? device` → the host
  device directly). `downdraft-model-viewer` already borrowed via
  `getNativeHost()`; now `GameRenderer` matches it.
- [x] `chromium-experimental-timestamp-query-inside-passes` feature probe:
  replaced — `GPUTimerPool` treats wgpu's plain `timestamp-query` as
  sufficient for inside-pass writes (Chromium still needs the experimental
  feature). Spec covers both runtimes.

**Exit criteria:** `native-host` and `GameRenderer` share one device;
`adapter.requestDevice` is called exactly once per process; readback never
guesses a device.

---

## Phase 3 — HostAPI contract replacement (in-place)

Goal: the host↔engine contract describes the *native* host. No Chromium
vocabulary survives on the live path.

- [ ] Rename/redesign `DowndraftBridgeAPI` → `HostAPI`:
  - saves: typed `SaveState` in/out (no JSON-string boundary)
  - lifecycle: `quit`, `requestRestart`, fullscreen, window controls
  - display: `getDisplayInfo`, `onDisplayChanged`
  - events: typed emitter keyed by event *name union*, not free-form
    channel strings (`removeAllListeners(channel)` goes away)
  - diagnostics: `getGpuInfo` (wgpu-native shape), `getFeatureLog`,
    `getProcessStats` (single-process — drop `main`/`renderer` targets)
  - screenshots: `captureFrame` (rename from `capturePage`)
  - osr: native OSR surface only (`pullFrame`/`frameRect`/`hitTest`/
    `getDimensions` are the API; drop `registerSharedTextureReceiver`,
    `onPaint*`, `createPaintPort`, `SharedTextureSubtle`, `PaintRegionData`,
    `useSharedTexture`/`sharedTexturePixelFormat` in `native-osr` types)
  - **delete outright**: `getElectronGPUInfo`, `openChromeUrl`, tracing +
    heap-snapshot members, `onGCStats`/`GCStatsData`, `log()` (use the
    logger directly)
- [ ] Update `app/src/shared/types.ts` (split or rewrite — it currently
  documents "IPC payload interfaces"), `native-bridge.ts`,
  `renderer/index.ts` (`downdraft` accessor + `stubBridge`), `sim-bridge.ts`,
  `mcp-harness.ts`, devtools `data-bridge.ts`/`profiling-bridge.ts`,
  `import-cache.ts` (`createElectronImportCache` → rename), and every game's
  `downdraft.*`/`ctx.bridge` usage — same-pass replacement.
- [ ] `getCombinedFeatureLog` → single `dd-host|...` scope (one process);
  drop `crossOriginIsolated`/`deviceMemory` fields or mark them host-type
  conditional.
- [ ] `capture_screenshot` MCP tool: on a `HostAPI` host, `captureFrame()`
  already returns the composited frame — drop the canvas+overlay
  double-composite under native.

**Exit criteria:** `DowndraftBridgeAPI` is gone from live exports; no
`Electron*`/`chrome`/`sharedTexture` identifiers in live host-facing types;
events are typed.

---

## Phase 4 — RenderSurface abstraction

Goal: the engine contract is a surface + UI compositor, not a canvas + DOM
overlay.

- [ ] Define `RenderSurface` (width/height, resize event,
  `getContext("webgpu") → GPUCanvasContext-like`, input event target) as the
  renderer-facing type. `NativeSurface` already is one; make it formal.
- [ ] `GameModule`/`startGame`/`bootstrapGame`: `renderer: (surface) => ...`,
  `ctx.surface`; `mountUI` takes a UI compositor/imui surface handle, not
  `HTMLElement`. `getCanvas`/`getOverlay`/`getAllCanvases` move to a
  `compat/` namespace (or are deleted once games migrate).
- [ ] Shrink `dom-polyfills.ts` to what PixiJS genuinely needs
  (canvas-factory + FontFace/DOMParser stubs); the `document.querySelector`
  → surface mapping, overlay stub elements, `elementFromPoint` → surface,
  etc. become unnecessary once nothing queries the DOM.
- [ ] `VirtualCanvasContext` stays as the PixiJS compat shim but moves under
  a `compat/` dir and is documented as *the* PixiJS adapter, not a general
  canvas.
- [ ] `captureCanvasThumbnail` and `compositeScreenshot` rework to surface
  readback (no `canvas.toBlob`, no `document.createElement`).
- [ ] Migrate each game's `mountUI`/`getCanvas` usage; DOM-mounting games
  get an explicit "DOM UI unavailable on native" error instead of silently
  stub elements.

**Exit criteria:** `startGame` compiles/runs with `document` absent; DOM
polyfills only exist inside the PixiJS compat layer.

---

## Phase 5 — Multi-worker GPU (the real re-architecture)

Goal: stop funneling all GPU work through one thread's command stream.

The Electron model forced single-device-single-thread; wgpu-native does
not. Two architectures to evaluate, in order of preference:

### Option A — shared device across workers (preferred)

wgpu devices/queues are internally synchronized (wgpu-core is designed for
multi-threaded use in Firefox). In-process via FFI, a device *handle* can
be reconstructed in another Bun worker from the same native pointer
(passed via SAB/postMessage as a BigInt). If handle-sharing works:

- workers can create encoders, record passes, and submit — queue submission
  serializes internally, encoding parallelizes
- sim-adjacent render work (terrain meshing, particle updates, UI raster)
  can encode on the worker that owns the data
- zero-copy: buffers/textures created on the shared device are visible to
  all threads — no readback compositing

### Option B — device-per-worker + compositing

If A fails (koffi/thread-safety limits, wgpu handle not sendable): each
render worker owns a device; composite via host-visible staging buffers or
the existing VirtualCanvas texture-pull model. Costs a copy per worker
frame — still parallelizes encoding and isolates device-loss.

### Spike tasks

- [ ] Prove FFI handle reconstruction in a second Bun `Worker`: export the
  wgpu device pointer from `WgpuDevice`, rebuild a minimal wrapper in a
  worker, create a buffer + submit a no-op encoder. Kill criteria: crash,
  UB, or koffi forbidding cross-worker calls.
- [ ] Benchmark parallel encoding vs single-threaded at N workers on a
  gpu-bench scene (synthetic: K independent passes).
- [ ] Check `session-tracker`/`destroyHostLayer` assumptions — the dev
  shell's device accounting assumes one device on one thread.
- [ ] Decide: write the verdict here + in AGENTS.md.

### Implementation (post-spike, winner dependent)

- [ ] `GpuDeviceHandle` transfer protocol (pointer + validation nonce over
  `postMessage`/SAB).
- [ ] Renderer API for worker-encoded passes plugged into the frame graph.
- [ ] Device-lost semantics across workers (who observes `lost`, who
  restarts).
- [ ] gpu-bench test: multi-worker rendering visual verification.

**Exit criteria:** either a working shared-device multi-worker render path
with measured benefit, or a documented rejection with the fallback design.

---

## Phase 6 — Process-model policy cleanup

- [x] `disableRendererIndexedDb`: call site gated on `hasDom` — the policy
  protected a renderer sandbox that no longer exists on native. The patch
  itself stays for DOM hosts.
- [x] Device-loss recovery: `HostAPI.requestRestart(reason): boolean` is
  now a first-class optional member (native bridge → `requestGameRestart`
  → `__ddRequestRestart`). All engine reload sites route through it:
  `game-renderer` device-loss, `sim-bridge.resetGame()`, `hot-reload`
  fallbacks, `wgsl-hmr` no-subscriber path; game-side
  `location.reload()`/`__ddRequestRestart` probes in andrews-sandbox +
  model-viewer migrated too. The dom-polyfill reload shim stays as the
  net for stray callers.
- [x] `PerfStatsData.process` removed (single-process shape); the dormant
  `ProcessSnapshotResult.main|renderer`/`GCStatsData` already live in
  `electron-bridge-types.ts`.
- [x] `createElectronImportCache` → renamed in Phase 3; semantics
  revisited — `HostImportCache.get` now lazily hydrates the sync mirror
  from the host store on a miss (eventual consistency instead of
  permanent miss after restart).
- [x] `startGCProfiler` gated on `PerformanceObserver.supportedEntryTypes`
  — Bun/JSC accepts `entryTypes:["gc"]` silently and emits nothing (would
  have run an empty 2s interval forever); now returns null early. All
  callers are null-safe (`gc_stats` events simply never fire on native —
  same as the API being unsupported).
- [x] `downdraft.config.json` `builder.mode` — dead field removed from the
  scaffold template partial + 4 game/example configs; spec updated
  (`hmr` block is live and untouched). `Builder`/`getBuilderConfig` stay —
  used by the deprecated `legacyFileCopyBuild` manifest path, unrelated
  to the config field.
- [x] OSR: `useSharedTexture`/`sharedTexturePixelFormat`/`OSRIPC` — done
  in Phase 3 (kept `pixelFormat`; `OSRHostBridge`; games gate on
  `pullFrame`).

---

## Phase 7 — Dormant tree deletion

Remove, once Phases 0–6 leave nothing live depending on it:

- [x] `app/src/main/`, `app/src/preload/`, `app/src/shared/messages.ts`,
  `core/src/ipc.ts` + `@downdraft/engine/ipc` wildcard resolution,
  `app/src/renderer-shims/`
- [x] `app/src/vite/` (whole electron-vite factory + plugins),
  `app/src/mobile/`, `packages/mobile-shell/`
- [x] `modules/electron-osr/`, `modules/raw-input/` (incl. the 159MB local
  `native/target/` build dir)
- [x] `modules/devtools/extension/` (Chrome extension panel)
- [x] Per-game `src/main.ts`, `src/preload.ts`, `electron.vite.config.ts`,
  dead `vite.config.ts`/`vite.polyfill-test.config.ts`, `index.html`
- [x] `examples/plugin-tester`/`pixi-ui-demo` electron configs (+ their
  `index.html`/`main.tsx`/`mcp-setup.ts` browser entries)
- [x] `tests/electron-mock.ts` + bunfig test preload, `tests/pixi-polyfill/
  browser/electron-main.mjs`, dormant main-process specs
- [x] `electron`, `electron-builder`, `electron-vite`, related deps from
  root + game package.jsons; `bun install` verified (9 packages removed)
- [x] `cli`: `--electron`/`--runtime=electron`/`--build` kept as hard-error
  stubs for UX; `draft release` desktop targets wired to
  `scripts/package-native.mjs`; `--format` deprecated to a no-op; `mobile`
  command deleted
- [x] `engine` package exports map: `app/main`, `app/preload`, `app/vite`,
  `app/mobile`, `app/build`, `modules/electron-osr`, `modules/raw-input`
  dropped; regenerated via `gen-engine-exports.mjs` + `gen-deno-import-map.mjs`
- [x] Docs: `docs/site` fully rewritten for the native runtime (index.astro
  "Why Electron" → "Native all the way down", process-model.md →
  single-process, cli.md → native flags, mobile.md deleted, Astro build
  verified); README `BrowserWindow` reference; AGENTS.md rewritten —
  Electron/Capacitor described as deleted, not dormant
- [x] Final verification: focused `bun test` suites, engine tsc (node + web +
  e2e), `draft test` e2e smoke, `astro build`

---

## Progress log

| Date | Entry |
|---|---|
| 2026-09-28 | Plan created from architecture review. Direction confirmed: replace bridge in-place, native RenderSurface ABI, cleanup + re-architecture scope, dormant tree deleted in Phase 7. |
| 2026-09-28 | Phase 0 implemented: `HostCapabilities`/`getHostCapabilities()`/`getNativeHost()` in `core/platform/runtime.ts`; bridge `capabilities` populated on native; all game `__nativeHost` gates converted; `ipc-save-store.ts` un-marked; `app/src/vite` + `app/src/mobile` + `core/src/main.ts` + 5 dead platform files + game vite/html entries + test harnesses marked dormant; AGENTS.md HMR + dormant-list corrections. Subagent validation: PASS; gaps closed (per-game `src/main.ts`/`src/preload.ts` + example entries marked; `e2e-vite-plugin.spec.ts` annotated). 1550 core specs pass; `bunx tsc` clean in touched files (remaining errors are pre-existing game-submodule spec rot). Follow-up noted: sibling host-globals (`__nativeGlob`, `__nativeIsBlitz`, `__nativeWindow`, `__nativeExit`, `__nativeScreenshot`) still bypass the capability surface — fold into Phase 3/4. |
| 2026-09-28 | Phase 1 implemented: typed `saveState`/`loadState` on `HostServicesApi`; `HostSaveStore` exposed as `downdraft.saveStore`; `"ipc"` mode renamed to `"host"` engine- and game-wide; `IpcSaveStore` deleted; `"auto"` resolves host-first on native; `ctx.save` writes real `SaveState` metadata via the store. Verified with a typed round-trip script (real bytes/timestamp/entityCount/engineVersion) and 1667 passing specs. |
| 2026-09-28 | Phase 1 subagent validation: NOT clean — found (a) explicit `mode:"inline"` collapsed to `"host"`, skipping `initSaveStore`; (b) `SaveMeta` (entityCount/playerCount/engineVersion) computed by the worker's `meta()` hook was dropped at the worker→renderer boundary; (c) `pickGameComponent`'s first-component heuristic could wipe multi-component saves (to-the-ocean autosave); (d) to-the-ocean double-wrote every save (`saved` handler + `ctx.save`); (e) stale `ipc-save-store.ts` entry in `.oxlintrc.json`. |
| 2026-09-28 | Phase 1 fixes landed: `resolvedMode === "inline"` now stays `"inline"`; worker `save()` RPC returns/emits real `meta` (merged into `ctx.save` + `createSimBridge` writes); `pickGameComponent` → `serializeRestorePayload` — explicit componentName, single-component unwrap, or full-map forward for multi-component saves; `saved` events carry `origin: "renderer" | "sim"` so the to-the-ocean handler persists only sim-initiated saves (exactly-once); `BridgeJsonSaveStore` restored as the "auto" last-resort over JSON bridge methods (headless/stub hosts — sandjongg-class games without `appId` would otherwise throw); `appId` added to sandjongg/falling-sand/mining-rpg native entries (installs the bridge: real host saves + MCP endpoint — they previously had no bridge at all). New specs: `host-save-store.spec.ts` (typed round-trip + meta + warnings), `game-module.spec.ts` (restore-payload selection), `sim-worker-base.spec.ts` meta/origin assertions. Note: sandjongg e2e now boots + connects MCP but its game-side tool harness was never wired — pre-existing gap, fails on `match_tiles`-tool absence, not save code. |
| 2026-09-28 | Phase 1 RE-VALIDATION: PASS — all five bugs verified fixed end-to-end. Follow-up commit `88e5a329` closed two residual issues the validator found: `ctx.save` dropped writes in `"worker"` mode (gated on `!== "inline"` now), and `simFromRenderer` games had no save wiring (`ctx.sim ?? simWorker` everywhere; `meta` typed on `SimWorkerSaveApi`). Remaining known gaps (deferred): to-the-ocean's bespoke worker returns no `meta` (entityCount lands as 0 in slot listings); its `onReady` does a manual autosave load AND the bootstrap wiring re-loads via `ctx.load` (idempotent, restores twice); overburden chunk persistence is OPFS-only (silently no-ops on native — no OPFS polyfill); sandjongg/falling-sand/mining-rpg e2e need game-side `createMcpHarness` wiring (pre-existing, unrelated to saves). **Phase 1 complete.** |
| 2026-09-28 | Phase 2 implemented: `GameRendererConfig` gains `device`/`adapter`/`configureSurface`; `init()` resolves config → `getNativeHost()` → self-acquire; borrowed host device sets `hostConfiguredSurface` and skips `context.configure()`. `createNativeHost` requests `timestamp-query` + the union of host/renderer limits (`requestLimit` clamps to advertised adapter limits, drops unadvertised keys). `GPUTimerPool` treats wgpu `timestamp-query` as inside-pass-capable (native capability check); `chromium-experimental` probe kept for Dawn. to-the-ocean `renderer.getDevice?.() ?? device` workarounds → host device directly. Verified: engine tsconfigs clean, 399 render/telemetry specs + 19/19 overburden e2e (incl. screenshot readback) pass. |
| 2026-09-28 | Phase 2 subagent validation: FAIL first pass — `recoverDevice()` re-created the second device + reconfigured the host surface on device loss (would panic wgpu via the readback hook's dead-device capture); `configureSurface:true` could override the borrow skip; `GPUTimerPool` encoder-only fallback was dead code (resolve/read gated on `isSupported()`); `CharacterPreview`/`pixi-ui-native` self-acquired; `clampLimit` could request unadvertised limits; borrowed `config.device` still demanded an adapter. All fixed: borrowed-device loss routes to `reloadForDeviceLoss`; borrow skip is unconditional; encoder timestamps actually resolve; library borrowers added; `ownsDevice` flag so `CharacterPreview.dispose` doesn't kill the host device. Re-validation: **PASS — Phase 2 complete.** |
| 2026-09-28 | Phase 3 implemented: `DowndraftBridgeAPI` → `HostAPI` in `app/src/shared/types.ts` (Electron-only types moved to dormant `electron-bridge-types.ts`); typed `saveStore`; `capturePage` → `captureFrame`; `log`/`getElectronGPUInfo`/`openChromeUrl`/`onGCStats`/tracing + heap-snapshot members deleted from the live contract; `removeAllListeners(channel)` → typed event-key removal; single-scope `dd-host|rt` feature log (`rt` = renderer/sim thread tag); `createElectronImportCache` → `createHostImportCache`; `OSRIPC` → `OSRHostBridge`; devtools gpu-panel Electron section replaced with adapter info, `contentTracing` branches dropped, auto-trace defaults flipped to in-engine `TraceEventWriter`; engine/mcp probes repointed from `import("electron")` to `downdraft.getGpuInfo`; native OSR types lost `useSharedTexture`/`sharedTexturePixelFormat` (kept `pixelFormat` — real Blitz frame format), `__nativeIsBlitz` marker deleted (games gate on `pullFrame`); `capture_screenshot` treats `captureFrame` as composited (no canvas+overlay double-composite on native). Dormant preload/mobile/main repointed at `electron-bridge-types.ts`. |
| 2026-09-28 | Phase 3 runtime wedge diagnosed (user report: window frozen, SIGTERM unresponsive): main thread at ~100% CPU in `pump_until` — the Rust shim's `map_async`/`on_submitted_work_done`/`pop_error_scope` FFI calls block the JS thread in an unbounded `yield_now` spin until a wgpu callback delivers. Chromium-style `encoder.writeTimestamp`/`resolveQuerySet` commands lose the wgpu/SwiftShader device (`reason=Unknown`, "driver implementation is at fault"); dropped `map_async` callbacks then wedged the process. **Not a Phase-3 regression** — reproduced at Phase-2 commit `318d1f77` (at HEAD the `writeTimestamp` *throw* masked it by aborting frame encode before submit). Fix layers: (1) `pump_until`/`block_on_gpu` gained a timeout + device-lost bail — dropped GPU callbacks are now recoverable errors, not wedges; release `.so` rebuilt + staged. (2) native inside-pass timestamp path gated off pending a real `timestamp_writes`-in-descriptor implementation (wgpu API shape, opt-in via `DOWNDRAFT_GPU_TIMESTAMPS=1`); encoder-level timestamps still cover blits. Verified: 61/61 telemetry specs (incl. updated native-gate cases), to-the-ocean e2e 6/6 with clean frames + screenshot, no device-loss errors in a direct run. |
| 2026-09-28 | Phase 3 subagent validation: PASS-with-gaps — live code had zero stale call sites, contract/dormant-split/screenshot-path all verified. Three defects found + fixed: (1) `profiling-bridge.ts` still probed `require("electron").contentTracing` — probe + start/stop branches removed, `traceSource` normalizes to the in-engine writer with a warning (`TraceSource` union kept for compat); (2) `block_on_gpu` warned at 2s but spun forever — now returns `Option<F::Output>` with the same 15s bail + paced poll as `pump_until`, all 3 call sites (request_adapter/request_device/pop_error_scope) map the timeout to real failure values (null handle / synthetic Internal error); (3) `HostEventMap` advertised `debug-mode`/`devtools-toggle` with no subscribe path + `__nativeDebugMode`/`__nativeDevtoolsToggle` globals were write-only/read-only dead ends — `HostAPI` gained `onDebugMode`/`onDevtoolsToggle` typed subscriptions, globals deleted. Post-fix: tsc clean (engine), 93 focused specs pass, bridge smoke PASS, to-the-ocean e2e 6/6. Nits deferred: `display-metrics-changed` has no native emitter (honest never-fires subscription — no SDL scale event exists yet); `collectRendererFeatureLog` still emits a raw `dd-render` line (merged view is `dd-host`, cosmetic); `VulkanValidationStatus` remains exported for `shared/gpu-info.ts`/dormant consumers. |
| 2026-09-28 | Phase 4 implemented: `RenderSurface` contract added (`core/src/platform/render-surface.ts` — width/height, client dims, `getContext("webgpu")` → nullable-texture `RenderSurfaceContext`, event target, `getBoundingClientRect`, optional pointer-lock). `NativeSurface`/`HTMLCanvasElement` satisfy it structurally. Core widened: `GameRenderer`/`InputManager`/`CanvasResizeWatcher` (native `resize` events + guarded `ResizeObserver`)/`RendererModuleHost`/`RendererModuleContext`/XR frame loop — all expose canonical `getSurface()` with deprecated `getCanvas()` aliases. Renderer layer: `getSurface(layer)` resolves `getNativeHost().surface` on native, DOM canvas on browser; `getCanvas`/`getOverlay`/`getAllCanvases`/`captureCanvasThumbnail`/`compositeScreenshot` moved to `renderer/compat/dom.ts` (deprecated re-exports). `GameModule.renderer` is `(surface: RenderSurface)`; `GameContext.surface` replaces `ctx.canvas`/`ctx.overlay`; `mountUI` is skipped with an explicit error on `!hasDom` hosts. MCP click targets the surface directly on native (DOM `elementFromPoint` retained on browser); `toBlob` is a compat probe. Native `dom-polyfills.ts` shrunk — `querySelector`/`getElementById` no longer map to the surface or overlay stubs, `elementFromPoint` removed; `VirtualCanvas` moved to `platform-native/src/compat/` as the PixiJS adapter. All 7 games + gpu-bench + pixi-ui-demo migrated (`ctx.surface`, `RenderSurface` renderer/input signatures, `mountUI` no-ops deleted, `surface:` automation field, DOM-only touches guarded or compat-cast). |
| 2026-09-28 | Phase 4 verification: engine tsc clean in both configs (remaining errors are pre-existing game spec rot — collision-system/plant-system/pathfinding/chunk-world/volumetric-light-pass specs + untouched sandjongg-worker-host `getStats`, all confirmed untouched in submodule diffs); 1556 core + 52 platform-native + 43 module/render specs pass; e2e: to-the-ocean 6/6, overburden 19/19, pixi-ui-demo 5/5. **Pre-existing e2e failures confirmed via stash-bisect:** sandjongg/mining-rpg/falling-sand smoke tests fail on "No MCP harness registered yet" (game-side `createMcpHarness` never reaches the native MCP server) — identical pass/fail at pre-change HEAD, unrelated to RenderSurface. Known game-side gap to fix later. |
| 2026-09-28 | Phase 4 subagent validation: FAIL first pass — five defects, all fixed: (1) **critical** — sandjongg tile input dead on native (VirtualCanvas never receives input dispatch; `createInputHandler` now binds to `getSurface()` on `!hasDom`, tileCanvas appended to `document.body` in `native-entry.ts` so `#sandjongg-tile-canvas` MCP discovery resolves); (2) duplicate `click` per physical click — `native-host.ts`'s mousedown/mouseup click synthesis was redundant with `native-window.ts`'s SDL-side click/dblclick synthesis, deleted; (3) double `onResize` per native resize — removed the `native-game-module.ts` surface-resize forwarder and the `native-game.ts` per-frame poll call (the `CanvasResizeWatcher` resize-event subscription is now the single delivery path; `NativeSurface.resize` no longer dispatches on unchanged dims); (4) `InputManager` wheel state dead on native — `MiniEventTarget.dispatchEvent` now sets `target`/`currentTarget` on plain-object events (DOM parity); (5) overburden's bespoke `dispatch_click` missed window-level input routers on native — now mirrors to `window` under `!hasDom` and drops the `document.body` fallback that lacked `getBoundingClientRect`. Also removed the dead `SurfaceManager` field in `GameRenderer`. Post-fix: tsc clean, 369 render/native/app specs pass, to-the-ocean 6/6 + overburden 19/19 e2e. |
| 2026-09-28 | Phase 5 spike: **Option A CONFIRMED** — shared wgpu device across Bun workers works. The shim's handles are process-global boxed pointers and wgpu-core synchronizes internally, so a Bun worker (same address space) dlopens the same cdylib and drives the device directly. Verified end-to-end: worker reconstructed the handle, created buffers/encoder, `queue_write_buffer` + `copy_buffer_to_buffer` + `queue_submit`, and `map_async`+`read_mapped` returned byte-exact data — all on the worker thread (`pump_until` is self-contained). Stronger proof in `shared-device.spec.ts`: worker renders a clear pass into a texture it created on the shared device; owner reads the pixels back. Parallel-encode bench (SwiftShader): 16k-dispatch tasks → 1.39× at W=4, **2.00× at W=8** wall-clock including worker spawn; encode-only scaling ~3×. Light workloads are dominated by spawn/submit serialization — multi-worker pays off for coarse subsystems (terrain bake, UI raster), not per-pass splits. Session-tracker is safe: worker `liveDevices` sets are per-thread module state. Latent bug fixed: `var<storage, read_write>` WGSL was misclassified `read-only-storage` by auto-layout reflection (`includes("read")` matched `read_write`). |
| 2026-09-28 | Phase 5 implementation: `gpu/shared-device.ts` — `GpuDeviceHandle` transfer protocol (devicePtr/instancePtr/queuePtr + generation), `DeviceStateCells` SAB (i64[2]: generation, alive), `shareDevice()`/`attachSharedDevice()` (non-owning `WgpuDevice` via `ownsHandle:false` — `destroy()` is a local unwire, never a native release), `markDeviceLost`/`sharedDeviceAlive`/`isValid()` (owner's `pollLost` writes alive=0 so workers observe loss lock-free), `submitCommandPtrs`/`importCommandBuffer` (worker-finished command buffers submit inside the owner's batch for frame-graph ordering). gpu-bench `multi-worker-render` test added (worker renders animated clears into a shared texture; main blits to swapchain). `supportsMultiWorkerGpu` flipped true in `NATIVE_HOST_CAPABILITIES`. |
| 2026-09-28 | Phase 5 subagent validation: FAIL first pass — three defects, all fixed: (1) **UAF** — owner `WgpuDevice.destroy()` never wrote the shared alive-cell, so attached workers kept calling FFI on freed handles (real path: host teardown/session-tracker HMR destroy while a worker lives); `destroy()` now writes `writeDead()` before releasing, generation-gated so a replaced device can't clobber a newer generation's cells (covers the stale-`pollLost`-write hazard too); (2) each `attachSharedDevice` leaked a boxed `Queue` clone — `release_queue` now runs for worker views too (the ctor's `device_get_queue` box is the wrapper's own), only `release_device` is gated on `ownsHandle`; (3) spec fixture handed the texture ptr to the owner then dropped the wrapper — GC could `release_texture` before owner readback (UAF); `keepAlive` array added (mirrors the game-side worker fixture). Also: `WorkerCommandRef` `{ptr, invalid}` handoff so a worker-side `finish()` validation error survives the ptr transfer (invalid buffers are released, never submitted — submitting one aborts wgpu). Post-fix: 56/56 platform-native specs (incl. new owner-destroy-propagation case), tsc clean, overburden e2e 19/19. Known design limitations documented in-file: ptr handoff transfers sole ownership (worker must not dispose/GC after posting); attach TOCTOU is inherent; worker-terminate orphans worker-created handles until process exit (bounded). **Phase 5 complete — architecture verdict: shared device is sound; integrate only for coarse work units (terrain bake, UI raster, bulk encode), not per-pass splits.** |
| 2026-09-28 | Phase 6 implemented: `HostAPI.requestRestart(reason)` added as the first-class restart contract (native bridge → `requestGameRestart`); all engine `location.reload()`/`__ddRequestRestart` sites routed through it with a reload fallback (game-renderer device-loss, sim-bridge `resetGame`, hot-reload fallbacks, wgsl-hmr); game-side callers migrated (andrews-sandbox, model-viewer). `PerfStatsData.process` removed; `disableRendererIndexedDb` call site gated on `hasDom`; `startGCProfiler` gated on `PerformanceObserver.supportedEntryTypes` (Bun silently accepts `entryTypes:["gc"]` but never emits — prevented a permanently-empty 2s interval); `HostImportCache.get` lazy-hydrates on miss; `builder.mode` removed from scaffold template + 4 configs. |
| 2026-09-28 | Phase 6 subagent validation: PASS-with-gaps — two defects fixed: (1) to-the-ocean keyed `__perfMetrics[data.process]` — removed field keyed `"undefined"`, starving the inspector's `main` row; now keys `"main"` directly; (2) `HostImportCache.get` lazy fill could resurrect an invalidated entry or clobber a fresher `set()` — pending-marker discipline added, plus negative caching for confirmed misses. Nit: andrews-sandbox bare `location.reload()` → `window.location.reload()`. Verified live: no remaining `__ddRequestRestart` probes outside the dom-polyfill shim, dev-shell override honored through `requestGameRestart`, no `config.builder` readers, all `startGCProfiler` callers null-safe. **Phase 6 complete.** |
| 2026-10-01 | Phase 7 implemented: dormant-tree deletion executed — `app/src/{main,preload,vite,mobile,build,renderer-shims}`, `app/src/shared/messages.ts`, `core/src/ipc.ts`, `modules/{electron-osr,raw-input}`, `devtools/extension/`, `packages/mobile-shell`, `tests/electron-mock.ts`, `tests/pixi-polyfill/`, `scripts/bench-runtime.mjs`, all per-game + example Electron entries (`electron.vite.config.ts`, `index.html`, `src/main.ts(x)`, `src/preload.ts`), generated `android/`/`ios/` dirs, `capacitor`/`mobile-overrides` assets, and the root electron-builder `build` config. Deps stripped: `electron`, `electron-builder`, `electron-vite`, `@capacitor/*` from root + all 8 game package.jsons (`bun install` removed 9 packages; vite + `@vitejs/plugin-react` retained — the native dev shell embeds Vite and game vite configs still transform). CLI: `mobile` command deleted; `build`/`dist`/`export`/`build-games` rewritten as thin stubs/delegators; `release.ts` drives `scripts/package-native.mjs` for `win`/`linux`/`mac`; `--format` is a deprecated no-op; `android`/`ios` targets hard-error. Engine exports regenerated (14 entries removed). `electron-bridge-types.ts` deleted — `app/src/shared/types.ts` carries the live `HostAPI` contract. AGENTS.md rewritten to describe Electron/Capacitor as deleted; docs/site fully rewritten for the native runtime (index.astro native section, single-process model, native CLI reference, mobile guide deleted — `astro build` verified 19 pages). Orphaned `styles/globals.css` files removed from 4 games. |
| 2026-10-01 | Phase 7 subagent validation: FAIL first pass — seven defects, all fixed: (1) `listGames()` keyed on deleted `electron.vite.config.ts` — game discovery was dead; now keys on `downdraft.config.json`/`src/native-entry.ts`. (2)+(3) `package-native.mjs` moved to `packages/cli/scripts/` (shipped with the CLI; root `scripts/package-native.mjs` kept as a forwarder for monorepo callers), gained `--target` cross-compile (win→`bun-windows-x64`, linux→`bun-linux-x64`, mac→`bun-darwin-arm64`), `--mode`, standalone crate-metadata fallback for published installs, and target-keyed native-lib staging that fails honestly when the target's libs are missing (cross-target `win` produces a real `.exe` then errors on absent `libdowndraft_platform.dll` instead of silently shipping host binaries). (4) Scaffolded `draft new` projects gained `vite` as a devDep (the dev shell needs it). (5)–(7) Dead `--no-bake` flag removed; README rewritten for the native runtime; stale doc/config fixes across AGENTS.md (COEP/file:// section, mining-rpg Solid-worker section, `@main/*` refs, HTML-layer section → RenderSurface), tsconfigs (dead `@main/*` alias + `app/src/{main,preload,vite,build,mobile}` globs), `.oxlintrc.json` (deleted-tree ignore globs), `.gitignore` (mobile dirs), `Cargo.toml` exclude, root+game `package.json` `main`/`description` fields, docs-site CLI/troubleshooting/installation claims (`--game` on dev, `--project-dir`, port defaults, `DOWNDRAFT_TEST_BUILT`, `--no-bake`, `--sourcemap`, audio-native path). Also fixed a mangled `usage.ts` summary string (unterminated) and removed 3 orphaned `styles/globals.css` files. Post-fix: CLI 80/80, engine+platform-native+app 1586/1586, to-the-ocean e2e 6/6, docs build 19 pages, both tsconfigs clean (remaining errors = pre-existing game spec rot, stash-verified). |
| 2026-10-01 | **Phase 7 complete** — committed `6c0da03f` (303 files, +1102/−35115) with 8 game-submodule commits beneath it. The Electron/Capacitor architecture is fully removed from live code, config, tooling, and docs; the native Bun + winit + wgpu runtime is the only runtime. Migration plan finished end-to-end (Phases 0–7). |
| 2026-10-02 | Post-migration residual-gap sweep (all committed): `95f4c87b` — game spec-rot typecheck fixes (collision SoA mock, wildlife/plant/chunk-world/volumetric/custom-scorer specs; both tsconfigs fully clean), MCP harness wiring for sandjongg/mining-rpg/falling-sand (`createMcpHarness` + `createStandardAutomationTools` in `onReady`; sandjongg native-entry gained deterministic-mode menu skip matching `game-module.tsx`), to-the-ocean native devtools/sim-bridge restored (save/craft/trade actions + `process_snapshot` envelope). `addcf789` — GPU timestamp infra: `wgpu_adapter_get_info` FFI (backend/deviceType/vendor/device; RTX 3090 → `discrete-gpu`, SwiftShader → `cpu`), pass-level `timestamp_writes` via render/compute pass descriptors, shared `gpu-timestamp-gate`; enabled path stays opt-in (`DOWNDRAFT_GPU_TIMESTAMPS`) — sustained live rendering loses the device on NVIDIA/Vulkan (standalone probes pass; documented in the gate). `64e107ba` — Windows PE branding in `package-native.mjs` (`resedit` v3.1.0; version strings + icon replacement, `.bun` trailer preserved via `noGrow` in-place `.rsrc` regen, Bun's 270KB default icon dropped when no game icon). `1cf3e259` — native chunk persistence: `NodeFsDirectoryHandle` adapter + `BinaryRecordStore.getRoot()` fallback (env `DOWNDRAFT_USER_DATA`/`XDG_CONFIG_HOME`; verified `overburden-chunks.bin` written during e2e). `5bae2581`+`17084dd5` — audio-kira revived: ported to kira 0.9 (`from_cursor` decode path replaces bespoke symphonia), workspace member + `native-crates.mjs` entry, real FFI loader via `resolveNativeLibrary` (dlopen-verified: init/loadBuffer/isPlaying/destroy), JS fallback retained. `display-metrics-changed` emitter: winit `ScaleFactorChanged` → shim event `SCALE_CHANGED` (14) → window `scale-changed` → bridge emits `display-metrics-changed` on real change only (first observation = boot baseline); `moved` handler re-queries as backend fallback; window polyfill `devicePixelRatio` now a live getter (was hardcoded `1`). Verification: 61/61 e2e, 117 platform-native + 105 persistence + 80 CLI + 47 audio-kira specs, both tsconfigs clean. |
| 2026-10-02 | **Electron vocabulary purge** (user-directed — "a dead experiment I don't want to circle back to"): CLI compat stubs deleted entirely (`--electron`, `--runtime=electron`, the hard-error paths in `dev.ts`/`test.ts`, usage-schema entries + spec assertions). Feature-log schema slimmed — `el`/`chr` version fields, Electron runtime branch, and `scope:"main"` removed; golden strings + fixtures updated (`host` is the canonical scope). Dead APIs deleted: `core/src/builder/builder.ts` (`Builder`/`getBuilderConfig`/`webview` — zero callers; `debug.ts` inlined to literals), `ui/src/global.d.ts` (stale `downdraft.rpc` bridge shape), `TraceSource`/`AutoTraceConfig`/`profiler` `contentTracing` variants, `ELECTRON_RUN_AS_NODE` env hygiene in `mcp/client.ts`, three dead `HostCapabilities` fields. DPR 1.5 cap removed from `game-renderer.ts` (Android-WebView compositor rationale; `resolutionScale` is the opt-in knob — real HiDPI now renders at native scale). ~50 comment/docstring rewrites across engine/platform/games replacing Electron/Chromium/Android-WebView/IPC vocabulary with native terms (worker RPC, direct bridge calls, SAB sync). `.oxlintrc.json` dead globs (`electron.vite.config.ts`, `src/main.ts`/`preload.ts`) removed in 8 game submodules; `.devin/config.local.json` stale exec-allow rules trimmed; `engine-prompt.eta` scaffold template rewritten for the single-process native model; AGENTS.md/README/cli.md stale flag references corrected. Retained intentionally: `devtools/src/web/browser.ts` chromium binary detection (live feature), `--native` back-compat flag, removal-notice text in AGENTS.md/README, historical entries in `batteries-included.md`. |
