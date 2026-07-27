# DownDraft Engine — AI-Driven Game Engine on Electrobun

A standalone, cross-platform game engine built on Electrobun + Bun + WGPU (TypeScript-first, Rust FFI for hotspots), with a built-in MCP server enabling AI agents to design, build, debug, and manage assets for games via natural language prompts. The engine follows an Angular-like philosophy: abstract the internals, expose clean declarative APIs, and support a rich plugin ecosystem via TypeScript and WASM.

**Project path**: `~/Pivot/source/apophis/downdraft-engine` (sibling to `to-the-ocean`).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  BrowserWindow (System WebView — transparent overlay)       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  UI Layer (React + Tailwind)                          │  │
│  │  - In-game HUD, menus, inventory, settings            │  │
│  │  - Editor panels (scene tree, inspector, asset browser)│ │
│  │  - Input capture (keyboard, mouse, gamepad, touch)    │  │
│  │  - DevTools panel (replaces Electron DevTools ext)    │  │
│  └───────────────────────────────────────────────────────┘  │
│           ↕ Electrobun RPC (typed, bidirectional)            │
├─────────────────────────────────────────────────────────────┤
│  Bun Main Process                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Engine Core  │  │ Render Loop   │  │ MCP Server         │ │
│  │ (orchestrator)│  │ (GpuWindow)   │  │ (AI agent surface) │ │
│  │              │  │               │  │                    │ │
│  │ - Scheduler  │  │ - WGPU ctx    │  │ - Scene tools      │ │
│  │ - Asset Mgr  │  │ - Render graph│  │ - Entity tools     │ │
│  │ - World mgr  │  │ - All passes  │  │ - Debug + inspect   │ │
│  │ - Hierarchy  │  │ - Reads SAB   │  │ - Undo/redo         │ │
│  │ - Crash sup. │  │               │  │ - Checkpoints       │ │
│  └──────┬───────┘  └──────┬────────┘  └─────────┬──────────┘ │
│         │  SABs (shared)  │                     │            │
│  ┌──────┴──────────────────┴─────┐  ┌───────────┴──────────┐ │
│  │  Sim Worker (worker_threads)   │  │  DB Worker            │ │
│  │  - ECS World (archetype-based) │  │  - SQLite             │ │
│  │  - Hierarchy (DOM-shaped tree) │  │  - Save/load + migrate│ │
│  │  - Change detection (tick)     │  │  - Asset metadata     │ │
│  │  - Systems (game logic)        │  │  - Scene persistence  │ │
│  │  - Physics (Rust FFI, multi)   │  │  - Schema versioning  │ │
│  │  - AI/Behavior trees           │  │                       │ │
│  │  - Plugins (water, terrain..)  │  │                       │ │
│  │  - Writes SABs → render reads  │  │                       │ │
│  └────────────────────────────────┘  └──────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  First-Party Plugins (loadable, not core)               │ │
│  │  - water (gerstner waves, refraction, reflection)       │ │
│  │  - marching-cubes terrain (volumetric, deformable)      │ │
│  │  - physics-rapier (Rust FFI, default)                   │ │
│  │  - audio-kira (Rust FFI, default)                       │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Four isolated execution contexts:**
1. **BrowserWindow** — React UI + input capture. Transparent overlay on GpuWindow. Never blocks.
2. **Bun main process** — Engine orchestrator, render loop (GpuWindow + WGPU), MCP server, asset manager, sim-worker crash supervisor, telemetry/profiling.
3. **Sim worker** — `worker_threads`. ECS world, hierarchy tree, change detection, game systems, physics, AI, TS plugins. WASM plugins run in isolated runtime within sim worker. Communicates via multiple SABs + postMessage.
4. **DB worker** — `worker_threads`. Persistence layer with schema versioning + migration registry.

**Builder modes** (Angular-like build profiles):
| Mode | WebView | Use case |
|---|---|---|
| **dev** | Chromium (Blink) | Development with full DevTools, custom devtools panel (asset loader, hitbox/velocity/raycast toggles, inspector). Fastest iteration. |
| **debug** | WebKit | Local verification on the production WebView engine. Catches WebKit-specific rendering/compat issues before shipping. |
| **prod** | System WebView | Optimized production build. No devtools, no debug overhead. |

If we find problems with any mode's WebView, we can be flexible — the abstraction layer means the engine never depends on a specific WebView's internals.

**Fallback architecture** (if Electrobun GpuWindow + WGPU proves unstable):
- Electrobun is solid enough for now, and we can fork it if needed.
- **Plan B**: Headless Bun (no browser window) + Dawn WGPU rendering directly to a native window handle (created via platform-specific code or a minimal windowing crate). UI would render to a texture and composite via WGPU instead of a transparent overlay.
- **FFI fallback**: If `bun:ffi` proves insufficient for WGPU bindings, switch to Node-API (N-API) which has stable ABI guarantees. The FFI boundary is a thin wrapper — swapping the loading mechanism is a localized change.

**Telemetry & profiling** (dev mode or `--debug` flag):
- All threads and processes (main, sim worker, DB worker, WASM plugin runtimes) report:
  - **Garbage collection**: GC pause duration + frequency per thread
  - **Memory**: RSS, heap usage, SAB buffer sizes per thread
  - **CPU**: Per-thread CPU time, per-system execution time
- Surfaced in devtools panel as real-time graphs + exported as JSON via MCP `profile_frame()` / `get_telemetry(duration)`.
- Zero overhead in prod mode (instrumentation compiled out).

**Communication tiers:**
| Boundary | Mechanism | Use case |
|---|---|---|
| Sim → Render | Multiple SharedArrayBuffers + Atomics | Transforms, water, terrain, physics, audio positions (60fps, zero-copy). Each channel uses SeqlockBuffer primitive. |
| UI ↔ Bun | Electrobun RPC | Commands, queries, UI state updates |
| Bun ↔ Sim | postMessage + multiple SABs | Commands/events (postMessage), state (multiple SABs via SeqlockBuffer) |
| Bun ↔ DB | postMessage | Save/load, asset queries, schema migrations |
| Bun ↔ Render | Direct function calls (same process) | Camera, viewport, debug overlays, HiDPI scale, HDR mode |
| Cross-thread sync | Atomics on SAB headers | Frame synchronization, seqlock read/write coordination |

---

## Package Structure (Standalone Framework)

```
downdraft-engine/
├── packages/
│   ├── core/                    # Engine core (Bun-side)
│   │   ├── src/
│   │   │   ├── ecs/             # Archetype-based ECS
│   │   │   │   ├── world.ts         # World container, entity management
│   │   │   │   ├── entity.ts        # Entity ID (generational index)
│   │   │   │   ├── component.ts     # Component registry, SoA storage
│   │   │   │   ├── archetype.ts     # Archetype table, column storage
│   │   │   │   ├── query.ts         # Typed queries with access tracking
│   │   │   │   ├── system.ts        # System interface, scheduler
│   │   │   │   ├── schedule.ts      # Dependency graph, single-threaded (multi-thread via plugin/SAB)
│   │   │   │   ├── events.ts        # Double-buffered event channels
│   │   │   │   └── hierarchy.ts     # Parent/child tree, DOM-shaped, dirty-flag propagation
│   │   │   │
│   │   │   ├── render/          # WGPU rendering pipeline
│   │   │   │   ├── device.ts         # WGPU device/adapter management
│   │   │   │   ├── surface.ts        # GpuWindow surface + swap chain
│   │   │   │   ├── render-graph.ts  # DAG of render passes (Bevy-style). Auto resource aliasing + usage flag sync.
│   │   │   │   ├── render-pass.ts    # Base pass interface
│   │   │   │   ├── passes/
│   │   │   │   │   ├── opaque.ts        # Opaque geometry pass (G-Buffer: albedo, normal, roughness, metallic, depth, velocity)
│   │   │   │   │   ├── transparent.ts   # Transparent pass (back-to-front)
│   │   │   │   │   ├── depth-prepass.ts # Early-Z prepass
│   │   │   │   │   ├── shadow.ts        # Shadow map pass
│   │   │   │   │   ├── post-process.ts  # Post-processing chain (tonemap, bloom, FXAA/TAA, color grade)
│   │   │   │   │   ├── ui-composite.ts  # Composite UI overlay
│   │   │   │   │   └── debug.ts         # Debug visualization (wireframe, AABBs)
│   │   │   │   ├── pipeline.ts       # Pipeline cache + specialization
│   │   │   │   ├── bind-group.ts     # Bind group layout + caching
│   │   │   │   └── buffer.ts         # GPU buffer management (ring/arena)
│   │   │   │
│   │   │   ├── scene/           # Scene & world management
│   │   │   │   ├── scene.ts         # Scene = hierarchy root + systems + resources
│   │   │   │   ├── world.ts         # World = scene + systems + resources + plugins
│   │   │   │   ├── layer.ts         # Render layers (opaque, transparent, UI)
│   │   │   │   ├── camera.ts        # Camera component + view management
│   │   │   │   └── checkpoint.ts    # Scene state checkpoints for undo/redo + crash recovery
│   │   │   │
│   │   │   ├── assets/          # Asset pipeline
│   │   │   │   ├── manager.ts       # Asset registry + ref counting
│   │   │   │   ├── loader-mesh.ts   # GLTF/GLB loader
│   │   │   │   ├── loader-texture.ts # PNG/WebP/KTX2 loader
│   │   │   │   ├── loader-shader.ts # WGSL shader loader + hot-reload
│   │   │   │   ├── loader-audio.ts  # OGG/MP3/WAV loader
│   │   │   │   ├── importer.ts      # Format conversion (FBX→GLTF, etc.)
│   │   │   │   ├── lod.ts           # LOD generation + mesh simplification
│   │   │   │   └── cache.ts         # GPU resource cache (textures, buffers)
│   │   │   │
│   │   │   ├── material/        # Material system
│   │   │   │   ├── material.ts      # Material definition (shader + uniforms + textures)
│   │   │   │   ├── graph.ts         # Material graph (node-based, Unreal-style)
│   │   │   │   ├── compiler.ts      # Material graph → WGSL shader
│   │   │   │   └── library.ts       # Built-in material library (PBR, unlit, skybox, particle, postprocess)
│   │   │   │
│   │   │   ├── mesh/            # Mesh system
│   │   │   │   ├── mesh.ts          # Mesh data (vertex/index buffers, attributes)
│   │   │   │   ├── vertex-layout.ts # Vertex attribute layout declarations
│   │   │   │   ├── builder.ts       # Procedural mesh builder API
│   │   │   │   └── skinning.ts      # Skinned mesh + bone hierarchy
│   │   │   │
│   │   │   ├── animation/       # Animation system
│   │   │   │   ├── clip.ts          # Animation clip (keyframe tracks)
│   │   │   │   ├── player.ts        # Animation player (play, blend, mix)
│   │   │   │   ├── state-machine.ts # Animation state machine (blend trees)
│   │   │   │   ├── skeleton.ts      # Skeleton + bone hierarchy
│   │   │   │   ├── retarget.ts      # Generic animation retargeting
│   │   │   │   └── mixamo.ts        # Mixamo-specific retargeting (strip mixamorig: prefix, T→A pose calibration, cached bone-mapping table)
│   │   │   │
│   │   │   ├── physics/         # Physics abstraction layer (pluggable)
│   │   │   │   ├── interface.ts     # PhysicsBackend interface (step, raycast, collide, etc.)
│   │   │   │   ├── registry.ts      # Physics backend registry, multi-realm support
│   │   │   │   ├── realm.ts         # Physics realm (isolated world, multiple concurrent)
│   │   │   │   ├── body.ts          # Rigid body (static, dynamic, kinematic)
│   │   │   │   ├── collider.ts      # Collider shapes (box, sphere, mesh, convex)
│   │   │   │   ├── character.ts     # Character controller
│   │   │   │   ├── raycast.ts       # Ray/shape queries
│   │   │   │   └── lifecycle.ts     # Bootstrap sequences: app-start, scene-start, on-demand
│   │   │   │
│   │   │   ├── audio/           # Audio system (Rust FFI, pluggable backend)
│   │   │   │   ├── interface.ts     # AudioBackend interface (standard, swappable)
│   │   │   │   ├── engine.ts        # Audio engine (default: kira via Rust FFI)
│   │   │   │   ├── source.ts        # Spatial audio source component
│   │   │   │   ├── listener.ts      # Audio listener (follows camera)
│   │   │   │   └── mixer.ts         # Audio mixer + effects
│   │   │   │
│   │   │   ├── input/           # Input system
│   │   │   │   ├── state.ts         # Input state (keyboard, mouse, gamepad, touch)
│   │   │   │   ├── mapping.ts       # Input → action mapping (bindings)
│   │   │   │   ├── context.ts       # Input context/mode router (editor vs game vs UI-focused)
│   │   │   │   └── sab-bridge.ts    # Reads input from SAB (written by webview)
│   │   │   │
│   │   │   ├── sab/             # SharedArrayBuffer protocols
│   │   │   │   ├── seqlock.ts      # SeqlockBuffer primitive — one reusable seqlock (odd/even counter, writer increment-write-increment, reader retries on odd/changed). Used by ALL SAB channels.
│   │   │   │   ├── protocol.ts     # SAB layout definitions (multiple channels: transform, input, physics, audio-position, water, terrain)
│   │   │   │   ├── writer.ts       # Sim-side SAB writer (uses SeqlockBuffer)
│   │   │   │   ├── reader.ts       # Render-side SAB reader (uses SeqlockBuffer)
│   │   │   │   └── input.ts        # Input SAB channel (webview → sim)
│   │   │   │
│   │   │   ├── worker/          # Worker management + crash recovery
│   │   │   │   ├── sim-worker.ts   # Sim worker bootstrap + message protocol
│   │   │   │   ├── supervisor.ts   # Crash recovery: restart once from DB checkpoint, surface non-blocking error banner. Second crash in short window → halt render loop, show fatal error. Fail loud, don't retry forever.
│   │   │   │   ├── db-worker.ts    # DB worker bootstrap
│   │   │   │   └── protocol.ts     # Typed message channels
│   │   │   │
│   │   │   ├── platform/        # Platform abstraction
│   │   │   │   ├── window.ts       # GpuWindow + BrowserWindow management, resize/DPI sync
│   │   │   │   ├── electrobun.ts   # Electrobun app lifecycle
│   │   │   │   ├── hidpi.ts        # HiDPI scale factor detection, surface reconfiguration on DPI change
│   │   │   │   ├── hdr.ts          # HDR surface config (RGBA16F swap chain, scRGB color space via Dawn)
│   │   │   │   ├── fs.ts           # Virtual filesystem (asset packing)
│   │   │   │   └── time.ts         # High-resolution timer + frame pacing
│   │   │   │
│   │   │   ├── change-detection/ # Tick-based change detection (Bevy/DOTS-style)
│   │   │   │   ├── tracker.ts      # Per-component last-changed tick slot. Writers update slot on write. Consumers poll slot for quick skip.
│   │   │   │   └── atomics.ts      # Cross-thread frame sync via Atomics on SAB headers
│   │   │   │
│   │   │   ├── plugin/          # Plugin system (tiered: TS + WASM)
│   │   │   │   ├── plugin.ts       # Plugin interface (register systems, components, resources, assets)
│   │   │   │   ├── registry.ts     # Plugin registry + dependency resolution
│   │   │   │   ├── ts-loader.ts    # TS plugin loader (runs in-process in sim worker, no sandbox)
│   │   │   │   ├── wasm-loader.ts  # WASM plugin loader (any language, isolated runtime, SAB access)
│   │   │   │   └── abi.ts          # Stable WASM ABI (component access, SAB channel allocation, system registration)
│   │   │   │
│   │   │   ├── save/            # Save system with schema versioning
│   │   │   │   ├── serializer.ts   # Scene/entity serialization (JSON + binary)
│   │   │   │   ├── schema.ts       # Schema versioning, migration registry keyed by version → transformer function
│   │   │   │   └── migrate.ts      # Migration runner, fault-tolerant, plugin-extensible
│   │   │   │
│   │   │   ├── builder/         # Build mode system (Angular-like build profiles)
│   │   │   │   ├── builder.ts       # Build orchestrator (dev/debug/prod mode selection)
│   │   │   │   ├── dev-mode.ts      # Chromium + devtools injection, hot-reload, telemetry enabled
│   │   │   │   ├── debug-mode.ts    # WebKit mode for local verification
│   │   │   │   └── prod-mode.ts     # Optimized build, instrumentation compiled out
│   │   │   │
│   │   │   ├── telemetry/       # Per-thread profiling (GC, memory, CPU)
│   │   │   │   ├── collector.ts     # Gathers metrics from all threads via postMessage + SAB counters
│   │   │   │   ├── gc-tracker.ts    # GC pause timing per thread (Bun.performance hooks)
│   │   │   │   └── reporter.ts      # Aggregates + exposes to devtools panel + MCP tools
│   │   │   │
│   │   │   ├── debug-draw/      # Immediate-mode debug rendering API
│   │   │   │   ├── lines.ts        # Line rendering (3D world + 2D screen space)
│   │   │   │   ├── points.ts       # Point rendering
│   │   │   │   ├── text.ts         # Text labels in world/screen space
│   │   │   │   └── queue.ts        # Per-frame debug draw queue (cleared after render)
│   │   │   │
│   │   │   ├── scripting/       # Game logic scripting model
│   │   │   │   ├── script.ts       # Script lifecycle (load, init, tick, dispose)
│   │   │   │   ├── binding.ts      # Script → ECS bridge (register systems, event handlers, queries)
│   │   │   │   └── hot-reload.ts   # Script hot-reload: dispose old (cleanup side effects), load new
│   │   │   │
│   │   │   └── index.ts         # Public API surface
│   │   │
│   │   └── package.json
│   │
│   ├── ui/                      # React UI components (webview-side)
│   │   ├── src/
│   │   │   ├── components/      # Reusable UI components
│   │   │   ├── editor/          # Editor panels (scene tree, inspector, etc.)
│   │   │   ├── hud/             # In-game HUD widgets
│   │   │   ├── input/           # Input capture layer + context routing
│   │   │   ├── devtools/        # Custom devtools panel (dev mode only)
│   │   │   │   ├── panel.ts        # Devtools panel entry (injected via Electrobun devtools extension)
│   │   │   │   ├── asset-loader.ts # Asset browser + hot-reload trigger
│   │   │   │   ├── toggles.ts      # Debug toggles (hitboxes, velocity, raycasts, wireframe, normals)
│   │   │   │   ├── telemetry.ts    # GC/memory/CPU graphs (reads from telemetry reporter)
│   │   │   │   └── inspector.ts    # Entity inspector (component dump, hierarchy tree)
│   │   │   └── rpc.ts           # Electrobun RPC client
│   │   └── package.json
│   │
│   ├── mcp/                     # MCP server for AI agents
│   │   ├── src/
│   │   │   ├── server.ts        # MCP server bootstrap
│   │   │   ├── tools/
│   │   │   │   ├── scene.ts        # Create/modify/remove scenes
│   │   │   │   ├── entity.ts       # Spawn/modify/remove entities
│   │   │   │   ├── component.ts    # Add/remove components on entities
│   │   │   │   ├── material.ts     # Create/modify materials + shaders
│   │   │   │   ├── mesh.ts         # Import/generate/modify meshes
│   │   │   │   ├── animation.ts    # Create/modify animation clips
│   │   │   │   ├── lighting.ts     # Set up lights, shadows, GI
│   │   │   │   ├── camera.ts       # Camera placement + framing
│   │   │   │   ├── physics.ts      # Configure physics, colliders, forces
│   │   │   │   ├── audio.ts        # Audio sources, listeners, mixing
│   │   │   │   ├── script.ts       # Game logic scripting (TypeScript)
│   │   │   │   ├── asset.ts        # Import/convert/manage assets
│   │   │   │   ├── debug.ts        # Inspect state, profile, visualize
│   │   │   │   ├── checkpoint.ts   # Create/restore checkpoints, undo/redo
│   │   │   │   ├── inspect.ts      # Rich object inspection (deep component dump, hierarchy traversal, query by path)
│   │   │   │   └── build.ts        # Build/package/export game
│   │   │   ├── resources/       # MCP resources (read-only data)
│   │   │   │   ├── scene-tree.ts   # Live scene hierarchy (parent/child tree)
│   │   │   │   ├── entity-state.ts # Entity component dump (rich, recursive)
│   │   │   │   ├── performance.ts  # Frame timings, system timings
│   │   │   │   ├── gpu-info.ts     # Adapter info, buffer sizes, draw calls
│   │   │   │   ├── asset-list.ts   # Asset inventory
│   │   │   │   └── checkpoint-list.ts # Available checkpoints + undo/redo history
│   │   │   └── prompts/        # MCP prompt templates
│   │   │       ├── create-scene.ts
│   │   │       ├── add-entity.ts
│   │   │       └── debug-frame.ts
│   │   └── package.json
│   │
│   ├── physics-native/          # Rust native physics library (rapier3d backend)
│   │   ├── src/
│   │   │   ├── lib.rs           # FFI entry points
│   │   │   ├── world.rs         # Physics world (wraps rapier3d)
│   │   │   ├── realm.rs         # Isolated physics realm (multiple concurrent worlds)
│   │   │   ├── body.rs          # Rigid body management
│   │   │   ├── collider.rs      # Collider shapes
│   │   │   ├── step.rs          # Batched physics step (operates on SAB)
│   │   │   └── raycast.rs       # Ray/shape queries
│   │   ├── Cargo.toml
│   │   └── build.sh             # Cross-compile for win/mac/linux
│   │
│   ├── audio-native/           # Rust native audio library (kira backend)
│   │   ├── src/
│   │   │   ├── lib.rs           # FFI entry points
│   │   │   ├── engine.rs        # Audio engine (wraps kira)
│   │   │   ├── source.rs        # Spatial source management
│   │   │   └── mixer.rs         # Mixer + effects
│   │   ├── Cargo.toml
│   │   └── build.sh             # Cross-compile for win/mac/linux
│   │
│   ├── shader-graph/            # Material/shader graph compiler
│   │   ├── src/
│   │   │   ├── graph.ts         # Node graph data model
│   │   │   ├── nodes/           # Built-in nodes (math, texture, blend, etc.)
│   │   │   ├── compiler.ts      # Graph → WGSL
│   │   │   └── validator.ts     # Type checking, loop detection
│   │   └── package.json
│   │
│   ├── plugins/                   # First-party plugins (loadable, not core)
│   │   ├── water/                 # Water rendering + simulation plugin
│   │   │   ├── src/
│   │   │   │   ├── index.ts       # Plugin registration
│   │   │   │   ├── gerstner.ts    # Gerstner wave simulation
│   │   │   │   ├── render.ts      # Water render pass (refraction, reflection)
│   │   │   │   └── sab.ts         # Water SAB channel (uses SeqlockBuffer)
│   │   │   └── package.json
│   │   │
│   │   ├── marching-cubes/       # Marching cubes terrain generation plugin
│   │   │   ├── src/
│   │   │   │   ├── index.ts       # Plugin registration
│   │   │   │   ├── generator.ts   # Marching cubes algorithm
│   │   │   │   ├── deformation.ts # Volumetric terrain deformation
│   │   │   │   ├── lod.ts         # Chunked LOD for terrain
│   │   │   │   └── sab.ts         # Terrain SAB channel (uses SeqlockBuffer)
│   │   │   └── package.json
│   │   │
│   │   ├── physics-rapier/       # Rapier physics backend plugin (wraps physics-native)
│   │   │   ├── src/
│   │   │   │   ├── index.ts       # Plugin registration, implements PhysicsBackend interface
│   │   │   │   ├── backend.ts     # Rapier backend impl
│   │   │   │   └── ffi.ts        # FFI bindings to physics-native lib (bun:ffi or napi, cross-platform path)
│   │   │   └── package.json
│   │   │
│   │   ├── audio-kira/           # Kira audio backend plugin (wraps audio-native)
│   │   │   ├── src/
│   │   │   │   ├── index.ts       # Plugin registration, implements AudioBackend interface
│   │   │   │   ├── backend.ts     # Kira backend impl
│   │   │   │   └── ffi.ts        # FFI bindings to audio-native lib
│   │   │   └── package.json
│   │   │
│   │   └── networking/           # Networking plugin (on-demand, not loaded by default)
│   │       ├── src/
│   │       │   ├── index.ts       # Plugin registration
│   │       │   ├── transport.ts   # Transport layer (WebSocket, WebRTC, raw TCP)
│   │       │   ├── replication.ts # Entity state replication (delta-compressed, priority-based)
│   │       │   └── rpc.ts         # Remote procedure calls between client/server
│   │       └── package.json
│   │
│   └── cli/                     # CLI tool for scaffolding/building
│       ├── src/
│       │   ├── init.ts          # `draft init` — scaffold new game
│       │   ├── build.ts         # `draft build` — build for target
│       │   ├── dev.ts           # `draft dev` — dev server with HMR
│       │   └── export.ts        # `draft export` — package for distribution
│       └── package.json
│
├── examples/
│   ├── minimal/                 # Minimal spinning cube
│   ├── physics-demo/            # Physics playground
│   └── ocean-game/              # Reference game (informed by to-the-ocean)
│
├── tests/                       # Colocated test infrastructure
│   ├── vision/                  # Vision test framework
│   │   ├── screenshot.ts        # Capture GpuWindow screenshot
│   │   ├── pixel-scan.ts        # Pixel-by-pixel correctness scanner
│   │   └── llm-vision.ts        # LLM-based visual verification
│   └── fixtures/                # Shared test fixtures
│
├── electrobun.config.ts         # Engine's own electrobun config
├── package.json                 # Monorepo root (bun workspaces)
└── README.md
```

---

## Core Subsystems — Design Decisions

### 1. ECS (Entity Component System)

**Inspiration**: Bevy (archetype-based), Unity DOTS (chunked storage + change detection), to-the-ocean (generational indices).

**Design**:
- **Entity**: `{ index: u32, generation: u32 }` — 8 bytes. Generational indices prevent stale-handle corruption (proven in to-the-ocean).
- **Component**: Plain data class implementing `Component` interface. Registered at startup with a `ComponentId`. Each component slot includes a `lastChanged: u32` tick counter for change detection.
- **Archetype**: Set of component types. All entities with the same archetype share a table with SoA column storage. Iterating "all entities with Transform + Velocity" walks two contiguous arrays — cache-friendly.
- **Query**: Declares read/write access to component types. Returns matching archetypes. Access tracking enables future parallel scheduling. Queries can filter by change detection: `query(Transform, Changed(Velocity))` only iterates entities where Velocity was written this tick.
- **System**: Function `(query, resources, commands) => void`. Systems declare their access via query types.
- **Schedule**: **Single-threaded by default.** Systems run in dependency order on one thread. Expansion path: a plugin can offload systems to additional worker threads via SAB work distribution. The schedule API is designed so multi-threading is a plugin, not a core concern.
- **Events**: Double-buffered channels. Events written this tick are readable next tick. Prevents mutation-during-iteration bugs.
- **Commands**: Deferred operations (spawn/despawn entity, add/remove component) queued during system execution, applied at stage boundaries.

### 1a. Hierarchy (Parent/Child Tree)

**Inspiration**: DOM (dirty-flag propagation), Unity (Transform hierarchy), Bevy (Parent/Child components).

**Design**:
- **Implicit root**: Every entity is parented at minimum to the World root. No orphan entities. `parent` defaults to `ROOT_ENTITY` (entity 0).
- **DOM-shaped tree**: Parent/child stored as **structural components** in a side table, not in archetype columns. This avoids archetype moves on reparenting — adding/removing Parent/Children doesn't change the entity's archetype table. Bevy struggled with hierarchy-in-archetype for years; we avoid this by storing hierarchy separately.
- **Dirty-flag propagation** (separate from change detection): When a parent's Transform changes, a `dirty` boolean on each child is set. This is a **derived-data invalidation flag**, distinct from `lastChanged` (which tracks when source data was written). `dirty` means "world matrix needs recomputation." `lastChanged` means "a system wrote to this component." They serve different purposes and must not be conflated.
- **Lazy world matrix**: `worldTransform = parent.worldTransform * localTransform`. Computed on read when `dirty` is set, then `dirty` is cleared. A 1000-entity tree where only the root moved: only root's `dirty` flag propagates to children (O(depth) propagation, not O(N)), children recompute on next read (one matrix multiply each).
- **Reparenting**: `setParent(entity, newParent)` updates the side table, adjusts Children arrays on old + new parent, marks the entity + all descendants dirty. No recursion for transform — propagation is lazy. Side table update is O(1) for the entity, O(children) for the parent arrays.

### 1b. Change Detection (Tick-Based)

**Inspiration**: Bevy's `Changed<T>` / `Ref<T>`, Unity DOTS's change filtering.

**Design**:
- **Per-component tick slot**: Every component instance has a `lastChanged: u32` tick counter alongside its data. When a system writes to a component, the write wrapper increments `lastChanged` to the current tick.
- **Consumer poll**: A system querying `Changed(Transform)` checks `lastChanged >= lastReadTick`. If false, skip. This is a single integer comparison — O(1) per entity, no hashing, no diffing.
- **Relationship to hierarchy dirty flags**: `lastChanged` tracks **source data writes** (a system modified Transform). Hierarchy `dirty` tracks **derived data invalidation** (world matrix is stale because a parent moved). A parent's `lastChanged` update triggers `dirty` propagation to children, but does NOT update children's `lastChanged` — children's source data didn't change, only their derived world matrix is stale. This keeps propagation O(depth) not O(N).
- **Cross-thread frame sync**: For SAB-backed data, `Atomics.store` / `Atomics.load` on the SAB header's sequence counter serves as the cross-thread change signal. The render thread polls the counter; if unchanged, it skips reading that channel entirely. Planned: `Atomics.wait` / `Atomics.notify` for blocking sync when low-latency is needed.
- **Multiple SABs**: Each SAB channel (transform, input, physics, audio-position, water, terrain) has its own independent sequence counter. The render thread can selectively skip unchanged channels. This enables fine-grained frame synchronization — if only transforms changed, water and terrain reads are skipped.

**API example**:
```typescript
// Define components
@component
class Transform { pos: Vec3; rot: Quat; scale: f32 = 1; }

@component
class Velocity { x: f32; y: f32; z: f32; }

@component
class Health { current: f32; max: f32; }

// Define a system
const movementSystem = system(
  query(Transform, Write(Velocity)),  // read Transform, write Velocity
  ({ transform, velocity }) => {
    velocity.x += transform.pos.x * dt;
    // ...
  }
);

// Register in schedule
schedule.add(movementSystem, Stage.Update)
  .after(inputSystem)
  .before(physicsSystem);
```

### 2. Render Graph

**Inspiration**: Bevy's render graph (now schedule-based), Unreal's RHI, to-the-ocean's WebGPURenderer.

**Design**:
- **RenderGraph**: DAG of render passes. Each pass declares input/output resources (textures, buffers). The graph handles **resource aliasing** (reusing GPU memory for non-overlapping textures — e.g. shadow map and bloom buffer share the same allocation since they're never needed simultaneously) and **synchronization** (the graph tracks resource lifetimes and sets correct WGPU texture usage flags at pass boundaries; WGPU handles internal synchronization automatically — there are no explicit barriers to insert, just correct usage flags).
- **RenderPass**: Interface with `prepare()`, `execute()`. Passes are hardware-agnostic — they record WGPU commands, not direct GPU calls.
- **TrackedRenderPass**: Wraps WGPU `RenderPass` to skip redundant state changes (pipeline, bind group, vertex buffer). Same optimization as Bevy.
- **PipelineCache**: Lazy-compiles render pipelines on first use. Specializes based on material + vertex layout + render pass format.
- **Phases**: Opaque (front-to-back, batched by material), Transparent (back-to-front, sorted by distance), Shadow (per-light), PostProcess (chain of fullscreen passes).
- **GPU-driven rendering**: Long-term goal. Single `drawIndirect` for all opaque geometry. Culling on GPU via compute shader. (Phase 6 stretch — not MVP.)

**Built-in passes (MVP)**:
1. Depth Prepass — early-Z, writes depth only
2. Shadow Pass — directional + point light shadow maps
3. Opaque Pass — G-Buffer (albedo, normal, roughness, metallic, depth, **velocity** for TAA)
4. Deferred Lighting — fullscreen compute, reads G-Buffer
5. Transparent Pass — forward-rendered, back-to-front
6. Post-Process Chain — tonemapping (ACES), bloom, **TAA** (uses velocity buffer), FXAA fallback, color grading
7. UI Composite — blend webview UI texture over rendered scene

**G-Buffer layout** (note velocity for TAA):
| Texture | Format | Contents |
|---|---|---|
| GBuffer0 | RGBA8 | Albedo (RGB) + AO (A) |
| GBuffer1 | RGBA8 | Normal (RGB) + Roughness (A) |
| GBuffer2 | RGBA8 | Metallic (R) + Emissive (GBA) |
| Depth | Depth32 | Scene depth |
| Velocity | RG16F | Screen-space motion vectors (curr→prev frame) for TAA |

### 3. Material System

**Inspiration**: Unreal's material editor (node graph), Bevy's material API.

**Design**:
- **Material**: Definition of shader + uniforms + texture bindings. Compiled to a WGSL shader + bind group layout.
- **MaterialGraph**: Node-based visual programming. Nodes for math, texture sampling, blend modes, UV transforms, etc. Compiled to WGSL by the shader-graph package.
- **MaterialLibrary**: Built-in materials: PBR (standard), Unlit, Skybox, Particle, PostProcess. Water and Terrain materials are provided by their respective first-party plugins, not the core library.
- **Hot-reload**: Shaders loaded from `.wgsl` files. File watcher triggers recompilation + pipeline cache invalidation. Changes appear instantly without restart. **Mesh and texture hot-reload** also supported — replacing a GLB or KTX2 file triggers asset reload + GPU resource update. The AI agent can import a new model and see it immediately.
- **Code-defined materials**: For programmers, materials can be defined in TypeScript with WGSL strings (like to-the-ocean's current approach). The graph is optional.

**API example**:
```typescript
// Code-defined material
const waterMaterial = new Material({
  shader: "shaders/water.wgsl",
  uniforms: {
    time: { type: "f32", binding: 0 },
    waveHeight: { type: "f32", binding: 1 },
    deepColor: { type: "vec4", binding: 2 },
    shallowColor: { type: "vec4", binding: 3 },
  },
  textures: {
    normalMap: { binding: 4, sampler: "linear-repeat" },
  },
  blendMode: BlendMode.Opaque,
  cullMode: CullMode.None,
});

// Graph-defined material (for AI / non-programmers)
const graph = new MaterialGraph();
const texCoord = graph.input("uv0", "vec2");
const time = graph.input("time", "f32");
const waveOffset = graph.mul(graph.sin(graph.add(texCoord.y, time)), 0.1);
const displacedUV = graph.add(texCoord, waveOffset);
const color = graph.sampleTexture("mainTexture", displacedUV);
graph.output("albedo", color);
graph.output("roughness", graph.constant(0.3));
// → compiles to WGSL
```

### 4. Physics (Pluggable, Multi-Realm)

**Inspiration**: to-the-ocean's Rapier integration, Bevy's Rapier integration, Unreal's Chaos.

**Design**:
- **PhysicsBackend interface**: Standard interface (`step`, `raycast`, `createBody`, `removeBody`, `applyForce`, etc.). Any backend implements this. Default: Rapier via Rust FFI. WASM Rapier as fallback.
- **Multiple concurrent realms**: Multiple isolated physics worlds can exist simultaneously. E.g. a "main" realm for gameplay, a "cloth" realm for soft-body sim, a "particles" realm for debris. Each realm is an independent `PhysicsWorld` with its own bodies, colliders, and step rate.
- **Bootstrap sequences**: Physics realms can be created at different lifecycle points:
  - **App-start**: Global physics (e.g. world collision) created during engine init.
  - **Scene-start**: Scene-specific physics created when a scene loads.
  - **On-demand**: Runtime-spawned realms (e.g. a mini-game arena, a destructible building's debris sim).
- **Rust native library** (`physics-native/`): Wraps `rapier3d` crate. Exposes C ABI functions via `#[no_mangle] extern "C"`. Supports multiple world instances via opaque handles.
- **Batched step**: Single FFI call per frame per realm. Rust reads entity transforms from SAB pointer, steps physics, writes results back to SAB. No per-entity FFI overhead.
- **Body types**: Static (ships, terrain), Dynamic (barrels, debris), Kinematic (players), Character controller.
- **Raycast**: Returns entity ID + hit point + normal. Used for interaction, camera collision, AI vision.
- **Collision events**: Published via ECS event channels. Systems subscribe to `CollisionStarted` / `CollisionStopped`.
- **Plugin architecture**: `physics-rapier` plugin wraps `physics-native` and implements `PhysicsBackend`. Third-party plugins can implement alternative backends (Jolt, PhysX, custom).

**FFI boundary**:
```rust
// physics-native/src/lib.rs
#[no_mangle]
pub extern "C" fn create_realm(config: *const RealmConfig) -> *mut PhysicsWorld

#[no_mangle]
pub extern "C" fn physics_step(
    world: *mut PhysicsWorld,
    transform_buffer: *const f32,  // SAB pointer: [x,y,z, qx,qy,qz,qw] per entity
    velocity_buffer: *mut f32,     // SAB pointer: output velocities
    entity_count: usize,
    dt: f32,
) -> i32  // 0 = success, non-zero = error code
```

```typescript
// packages/plugins/physics-rapier/src/ffi.ts
import { dlopen, FFIType, ptr } from "bun:ffi";
// Cross-platform library path resolution
const libExt = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const libPath = `./libdowndraft_physics${libExt}`;

const lib = dlopen(libPath, {
  physics_step: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.f32],
    returns: FFIType.i32,
  },
});
// If bun:ffi fails, swap to napi (Node-API) — the FFI boundary is a thin wrapper
// import { loadPhysicsLib } from "./napi-loader";  // fallback path

// One call per frame — entire physics step in native code
const status = lib.symbols.physics_step(
  worldPtr,
  ptr(transformSABView),
  ptr(velocitySABView),
  entityCount,
  dt,
);
```

### 5. Asset Pipeline

**Inspiration**: Unreal's asset importer, Bevy's asset system, Godot's resource system.

**Design**:
- **AssetManager**: Central registry. Assets referenced by URI (`"models/ship.glb"`, `"textures/water.ktx2"`). Ref-counted for GPU resource lifecycle.
- **Loaders**: Per-format loaders. GLB/GLTF for meshes, KTX2/WebP/PNG for textures, OGG for audio, WGSL for shaders.
- **Importer**: Converts external formats (FBX, OBJ, PSD) to engine formats (GLB, KTX2). Runs as build step or on-demand.
- **LOD generation**: Mesh decimation (quadric error metric) to generate LOD levels. Automatic LOD selection based on screen-space error.
- **GPU cache**: Textures uploaded once, shared across materials. Buffer pools for vertex/index data. Ring buffer for per-frame uniform updates.
- **Streaming**: Assets loaded asynchronously. Priority queue based on distance to camera. Background loading doesn't block sim or render.
- **Packing**: Assets packed into a single bundle file for distribution (not ASAR — custom format with random access + compression per-asset).

### 6. Animation System

**Inspiration**: Unreal's animation blueprint, to-the-ocean's SkeletonAnimator.

**Design**:
- **Skeleton**: Bone hierarchy with bind poses. Loaded from GLB.
- **AnimationClip**: Keyframe tracks per bone. Supports position, rotation (quaternion), scale.
- **AnimationPlayer**: Plays clips with time scaling, looping, blend weights.
- **Blend trees**: 1D/2D blend spaces for locomotion (idle ↔ walk ↔ run based on speed).
- **State machine**: States + transitions with conditions. Transition duration + blend curves.
- **Generic retargeting**: Map animations between skeletons with different proportions. Bone name matching + rest-pose alignment.
- **Mixamo retargeting** (scoped as its own task, not folded into generic): Strip `mixamorig:` bone-name prefix. Calibrate rest-pose orientation once per rig (Mixamo rigs are commonly T-pose; target skeletons may be A-pose). Cache the resulting bone-mapping table per rig so it's computed once, not on every animation import.
- **GPU skinning**: Skin matrices computed in compute shader, written to a buffer. Vertex shader reads skin matrices + bone indices/weights.

### 7. Audio System (Rust FFI, Pluggable Backend)

**Inspiration**: Unreal's audio engine, Bevy's audio.

**Design**:
- **AudioBackend interface**: Standard interface (`play`, `stop`, `setVolume`, `setPan`, `set3DPosition`, `createChannel`, etc.). Any backend implements this.
- **Default backend: kira** (Rust audio library via FFI). Kira provides low-latency audio playback, mixing, and effects. Chosen for its clean API and active development.
- **Alternative backends**: `oddio` or `rodio` can be swapped in by implementing the `AudioBackend` interface. The engine never depends on kira-specific APIs directly.
- **Spatial audio**: Sources have position + attenuation radius. Listener follows camera.
- **HRTF**: Optional binaural rendering for headphones.
- **Mixer**: Channels with volume, pan, effects (reverb, lowpass).
- **Streaming**: Large audio files streamed from disk, not loaded entirely.
- **Rust native library** (`audio-native/`): Wraps kira crate. Exposes C ABI functions via `#[no_mangle] extern "C"`.
- **Audio position SAB**: Audio source positions written to a dedicated SAB channel (using SeqlockBuffer) so the audio engine can read positions zero-copy from the sim thread.

### 8. Input System

**Inspiration**: Unreal's enhanced input, to-the-ocean's InputBufferReader.

**Design**:
- **Input SAB**: Webview captures raw input (keyboard, mouse, gamepad, touch), writes to input SAB. Sim worker reads from SAB. Zero-latency input (no RPC round-trip).
- **Action mapping**: Raw inputs mapped to named actions (`"move_forward"`, `"interact"`, `"fire"`). Bindings configurable per-game.
- **Input state**: Polled by systems each tick. Current state + just-pressed/just-released edge detection.
- **Mouse look**: Pointer lock in webview. Mouse delta written to SAB. Camera system reads delta.
- **Gamepad**: Standard Gamepad API in webview. Button states + analog axes written to SAB.

### 9. MCP Server

**Inspiration**: to-the-ocean's existing MCP server (`src/mcp/server.ts`), Claude's MCP protocol.

**Design**:
- **Transport**: stdio MCP server (standard protocol). AI agent connects via MCP client.
- **Tools**: ~50+ tools covering scene design, entity management, materials, meshes, animation, lighting, physics, audio, scripting, assets, debugging, and building.
- **Resources**: Read-only data endpoints. Agent can query scene tree, entity state, performance metrics, GPU info, asset inventory without modifying anything.
- **Prompts**: Pre-built prompt templates for common tasks ("create a scene with...", "debug why frame is slow", "add a water material to...").

**Key MCP tools (categorized)**:

**Scene & Entity**:
- `create_scene(name, config)` — Create a new scene
- `load_scene(path)` — Load scene from file
- `spawn_entity(type, transform, components)` — Create entity with components
- `modify_entity(id, changes)` — Update entity components/transform
- `remove_entity(id)` — Destroy entity
- `get_scene_tree()` — Return full scene hierarchy as JSON
- `get_entity_state(id)` — Dump all components + values for entity
- `find_entities(filter)` — Query entities by type/component/region

**Materials & Shaders**:
- `create_material(name, graph_or_code)` — Create material from graph or WGSL
- `assign_material(entity_id, material_name)` — Assign to entity's mesh
- `modify_material(name, changes)` — Update uniforms/textures
- `list_materials()` — All materials + their properties
- `hot_reload_shader(path)` — Reload WGSL file

**Meshes & Assets**:
- `import_mesh(path)` — Import GLB/FBX, return mesh ID
- `generate_procedural_mesh(type, params)` — Create plane, sphere, terrain, etc.
- `set_lod(entity_id, levels)` — Configure LOD distances
- `import_texture(path, format)` — Import + convert to KTX2
- `list_assets(filter)` — Asset inventory

**Lighting & Camera**:
- `add_light(type, transform, params)` — Directional, point, spot
- `set_sun_angle(elevation, azimuth)` — Quick sun positioning
- `set_camera(position, look_at)` — Position + frame camera
- `set_camera_mode(mode)` — Orbit, FPS, cinematic, follow

**Physics**:
- `add_collider(entity_id, shape, params)` — Box, sphere, mesh, convex
- `set_body_type(entity_id, type)` — Static, dynamic, kinematic
- `apply_force(entity_id, force)` — Impulse/force
- `raycast(origin, direction, max_dist)` — Return hits

**Debug & Inspection**:
- `profile_frame()` — Per-system timings, GPU timings, draw call count
- `visualize_debug(mode)` — Wireframe, AABBs, normals, overdraw, LOD
- `screenshot()` — Capture current frame
- `inspect_gpu()` — Adapter info, buffer sizes, texture memory
- `get_performance_history(seconds)` — Frame time graph data
- `get_telemetry(duration)` — Per-thread GC, memory, CPU metrics over a time window
- `inspect_object(path_or_id)` — Rich recursive inspection: traverse hierarchy, dump all components + nested values, query by path (e.g. `"world/ship_cabin/chest/lid"`)
- `inspect_component(entity_id, component_type)` — Deep dump of single component with all fields + types
- `query_entities(filter)` — Find entities by component type, spatial region, hierarchy path, or property values

**Checkpoints & Undo/Redo**:
- `create_checkpoint(name)` — Snapshot current scene state (entities, components, hierarchy, resources)
- `restore_checkpoint(name)` — Roll back to a named checkpoint
- `undo()` — Reverse the last MCP operation (spawn, modify, remove, material change, etc.)
- `redo()` — Re-apply the last undone operation
- `list_checkpoints()` — All available checkpoints + timestamps
- `diff_checkpoints(a, b)` — Structured diff between two checkpoints (added/removed/changed entities + components)

**Scripting**:
- `create_script(name, code)` — TypeScript game logic
- `attach_script(entity_id, script_name)` — Attach to entity
- `hot_reload_script(name)` — Reload script at runtime

**Build**:
- `build_game(target)` — Package for win/mac/linux
- `export_scene(path)` — Save scene to file
- `validate_project()` — Check for missing assets, broken refs

**Why this is better than stdout debugging**:
The agent gets structured JSON responses, not text logs. `get_entity_state(42)` returns:
```json
{
  "id": 42,
  "type": "ship",
  "transform": { "pos": [10.5, 0, -30.2], "rot": [0, 0.707, 0, 0.707], "scale": 1 },
  "velocity": [0.5, 0, 0],
  "components": {
    "Health": { "current": 80, "max": 100 },
    "Collider": { "shape": "box", "size": [4, 2, 8] },
    "Mesh": { "asset": "models/ship.glb", "lod": 1 }
  }
}
```
No more asking the user to paste coordinates from stdout. The agent queries directly.

### 10. SAB SeqlockBuffer Primitive

**Problem**: to-the-ocean has four SAB channels (sim, input, water, boat), each with its own hand-rolled sequence counter synchronization. Four similar-but-subtly-different implementations = four places for bugs.

**Solution**: One `SeqlockBuffer` primitive in `sab/seqlock.ts`. Every SAB channel uses it.

**Seqlock protocol** (lock-free single-writer / multi-reader):
```
Writer (sim thread):                   Reader (render thread):
1. Atomics.store(seq, seq+1)           1. s1 = Atomics.load(seq)
   (seq is now ODD = writing)             2. if s1 is ODD → writer mid-write, retry
2. ... write data to buffer ...        3. ... read data from buffer ...
3. Atomics.store(seq, seq+1)           4. s2 = Atomics.load(seq)
   (seq is now EVEN = done)               5. if s1 !== s2 → changed during read, retry
                                          6. data is valid
```

**API**:
```typescript
class SeqlockBuffer<T> {
  constructor(sab: SharedArrayBuffer, layout: BufferLayout);
  
  // Writer side (sim thread)
  beginWrite(): void;    // increments seq to odd
  endWrite(): void;      // increments seq to even
  writeField(offset, value): void;  // write within begin/end
  
  // Reader side (render thread)
  read(): T | null;      // returns null if changed during read (retry)
  // or: readInto(target: T): boolean;  // fills target, returns false if stale
  
  // Query
  getSequence(): number;  // current seq value (even = stable, odd = writing)
  hasChanged(lastSeen: number): boolean;  // quick poll: seq !== lastSeen
}
```

**Channels using SeqlockBuffer**: transform, input, physics, audio-position, water, terrain. Each channel has its own `SharedArrayBuffer` + `SeqlockBuffer` instance. The render loop polls `hasChanged()` per channel and only reads channels that changed.

**Retry safety**: `read()` accepts a `maxRetries` parameter (default: 8). After exhausting retries, the reader returns the last successfully read data (stale but better than spinning). This handles the edge case where GC pauses or heavy writes cause repeated seqlock conflicts on large buffers. The stale-read is logged as a warning in dev mode.

### 11. Sim-Worker Crash Recovery

**Inspiration**: to-the-ocean's error handling in `sim-worker.ts`, Erlang's supervisor pattern.

**Design**:
- **Supervisor** (`worker/supervisor.ts`): Main process listens to sim worker's `error` and `exit` events.
- **Crash sequence**:
  1. Sim worker crashes (uncaught exception or OOM).
  2. Supervisor receives `exit` event.
  3. Supervisor restarts the sim worker **once** from the last DB checkpoint.
  4. A **non-blocking error banner** appears in the UI (React overlay): "Simulation crashed and was restored. Some recent changes may be lost."
  5. If the sim worker crashes again **within a short window** (e.g. 30 seconds), the supervisor **halts the render loop** and shows a **fatal error** screen instead of looping silently.
- **Fail loud, don't retry forever**: No silent infinite restart loops. The user (and AI agent) always knows something went wrong.
- **Checkpoint cadence**: The DB worker saves scene state checkpoints periodically (every N seconds or on significant changes). The supervisor restores from the most recent checkpoint.
- **MCP integration**: `crash_event` is surfaced as an MCP resource so the AI agent can inspect the crash, read the error message, and attempt a fix.

### 12. Save System with Schema Versioning

**Inspiration**: Unreal's save system, database migration patterns.

**Design**:
- **Schema versioning**: Every save file includes a `schemaVersion: number`. The engine has a `currentSchemaVersion`.
- **Migration registry**: `Map<number, (data) => data>` keyed by source version → transformer function. Each migration upgrades data from version N to N+1.
- **Migration runner**: `migrate(data, targetVersion)` walks the chain: `v1→v2→v3→...→current`. Each transformer is pure and fault-tolerant (try/catch per field, missing fields get defaults).
- **Plugin-extensible**: Plugins can register their own migration functions for plugin-specific data. The migration runner calls plugin migrations after core migrations.
- **Fault tolerance**: If a migration fails for a specific field, that field gets its default value and a warning is logged. The save still loads — partial data is better than no data.
- **Backward compatibility**: Old saves always load. The migration chain handles any version gap.
- **Format**: JSON for scene/entity data (human-readable, MCP-friendly). Binary for large buffers (terrain heightmaps, water fields) with a separate binary blob referenced by the JSON.

**API**:
```typescript
// Register a migration
SaveSystem.registerMigration(3, (data) => {
  // v3 → v4: add "weather" field to scene data
  data.scene.weather = data.scene.weather ?? { type: 'clear', intensity: 0 };
  return data;
});

// Load with auto-migration
const save = await SaveSystem.load('saves/slot1.json');
// → automatically migrates from save.schemaVersion to currentSchemaVersion
```

### 13. Testing Strategy

**Colocated tests**: Every unit has its test file colocated (`foo.ts` → `foo.spec.ts`). Test fixtures live alongside tests. No separate test directory for unit tests — only shared fixtures in `tests/fixtures/`.

**Vision test framework** (`tests/vision/`):
- **Screenshot capture**: Captures the GpuWindow's current frame as a PNG.
- **Pixel-by-pixel scanner**: Compares screenshot against a reference image. Configurable tolerance per pixel (exact match, color delta threshold, region-based).
- **LLM vision verification**: Sends screenshot to an LLM with a prompt ("Does this show a red cube on a blue background?"). LLM returns structured pass/fail. Used for complex visual assertions that pixel scanning can't handle.
- **Usage**: `await visionTest('red-cube-on-blue', { llmPrompt: 'A red cube centered on a blue background' })` — runs both pixel scan + LLM verification.
- **CI integration**: Vision tests run in headless mode. Screenshots saved as artifacts on failure for debugging.

**Test types**:
| Type | Location | Runner |
|---|---|---|
| Unit tests | Colocated `*.spec.ts` | `bun test` |
| Integration tests | Colocated `*.integration.spec.ts` | `bun test` |
| E2E tests | `tests/e2e/` | Playwright (Electrobun webview) |
| Vision tests | `tests/vision/` | Custom runner + Playwright |
| Fixtures | `tests/fixtures/` | Shared across all test types |

### 14. Scripting Model

**Problem**: The MCP `create_script` tool needs a clear definition of what a "script" is, how it interacts with the ECS, and how hot-reload cleans up side effects.

**Design**:
- **Script lifecycle**: `load → init → tick (per frame) → dispose`. A script is a TypeScript module exporting `init(world)`, `tick(world, dt)`, and `dispose(world)` functions.
- **ECS bridge**: Scripts register systems, event handlers, and queries via a `ScriptContext` object passed to `init()`. The context provides typed access to the world without exposing internals.
- **Hot-reload**: On file change, the scripting system calls `dispose()` on the old script (cleans up: despawned entities, removed event handlers, unregistered systems), then loads + `init()`s the new version. Side effects are tracked via a `ScriptHandle` that owns all registrations — disposing the handle removes everything.
- **No direct world mutation**: Scripts interact via the `ScriptContext` API, not by directly poking ECS internals. This maintains the Angular-like abstraction — scripts are declarative, not imperative.
- **MCP integration**: `create_script` writes a `.ts` file, `attach_script` loads it, `hot_reload_script` triggers the dispose/reload cycle. Scripts are stored in the project's `scripts/` directory.

**API example**:
```typescript
// scripts/player_controller.ts
export function init(ctx: ScriptContext) {
  const query = ctx.query(Transform, Velocity, Player);
  ctx.registerSystem(Stage.Update, (world) => {
    const input = ctx.getInput();
    for (const [transform, velocity, player] of query) {
      if (input.action("move_forward")) velocity.z += 0.5;
    }
  });
}

export function tick(ctx: ScriptContext, dt: number) {
  // Per-frame logic outside ECS system schedule
}

export function dispose(ctx: ScriptContext) {
  // Cleanup is automatic via ScriptHandle, but custom cleanup can go here
}
```

### 15. Debug Draw API

**Inspiration**: Bevy's `gizmos`, Unity's `Debug.DrawRay`, Unreal's `DrawDebugLine`.

**Design**:
- **Immediate-mode**: Systems call `debugDraw.line(from, to, color)` during their tick. Draws are queued per-frame and rendered after the main scene, cleared at frame end.
- **3D + 2D**: Lines, points, and text in both world space (3D, depth-tested) and screen space (2D overlay).
- **Persistent draws**: Optional `duration` parameter for draws that persist across N frames (useful for slow-moving debug visualizations).
- **Integration with devtools toggles**: The devtools panel toggles (hitboxes, velocity vectors, raycasts) are implemented as systems that call debug draw APIs. Toggling them on/off enables/disables those systems.
- **Rendering**: Debug draws use a dedicated render pass after transparent, before UI composite. Simple line/point topology, no material system overhead.

### 16. Input Context System

**Problem**: In editor mode, WASD orbits the camera. In game mode, WASD moves the player. When UI has focus, WASD types into a text field. Who decides?

**Design**:
- **Input contexts**: `enum InputContext { Editor, Game, UI }`. The active context is set by the builder mode + UI focus state.
- **Context priority**: `UI > Game > Editor`. If a text input has focus, UI context captures keyboard. Otherwise, game context gets it. Editor context is active only in dev/debug mode when no game is running.
- **Action routing**: Input mappings are registered per-context. `mapping.ts` resolves raw input → actions based on the active context. A system querying `input.action("move_forward")` only receives the action if the Game context is active.
- **Context switching**: The UI layer requests context changes via RPC (`setInputContext("game")`). The main process arbitrates — e.g. clicking the game canvas switches to Game, clicking an editor panel switches to Editor.

### 17. HiDPI + HDR Support

**HiDPI**:
- **Scale factor detection**: `hidpi.ts` queries the platform's scale factor (macOS: `NSWindow.backingScaleFactor`, Windows: DPI awareness, Linux: `GDK_SCALE`).
- **Surface reconfiguration**: On DPI change (monitor swap, user scale change), the WGPU surface is reconfigured with new swap chain dimensions. The BrowserWindow overlay is resized to match.
- **Render scale**: The render resolution = window size × scale factor. UI (React) handles its own DPI scaling via CSS. The GpuWindow and BrowserWindow must stay pixel-aligned.
- **Resize handling**: Window resize triggers: (1) WGPU surface reconfigure, (2) BrowserWindow resize, (3) camera aspect ratio update, (4) render target resize. All synchronous, no frame drop.

**HDR**:
- **Dawn backend**: WGPU swap chain configured with `RGBA16F` format + `scRGB` color space when HDR is available. This allows the renderer to output values beyond [0, 1] for true HDR displays.
- **Detection**: Query adapter for HDR support. If unavailable, fall back to SDR (`RGBA8` + sRGB).
- **Tone mapping**: In HDR mode, tonemapping is applied as a post-process step but the final output preserves extended luminance. In SDR mode, tonemapping maps to [0, 1].
- **UI compositing**: The webview (SDR) is composited after tonemapping. UI is always SDR — HDR is only for the 3D scene rendered by Dawn.
- **Per-pixel brightness**: HDR enables brighter highlights, better bloom, and more realistic light intensity. The lighting system uses physical light units (lumens, lux) in HDR mode.

### 18. Plugin Architecture (Tiered: TS + WASM)

**Philosophy**: Angular-like abstraction. Plugins extend the engine without touching internals. Two tiers for different needs:

**Tier 1: TypeScript plugins** (fastest, no sandbox):
- Run directly in the sim worker's JS context.
- Full access to ECS API, SAB channels, system registration.
- No isolation — a buggy plugin can crash the sim worker (caught by crash supervisor).
- Best for: first-party plugins, trusted developers, rapid iteration.
- Loaded via `ts-loader.ts` — dynamically imports the plugin module, calls `register()`.

**Tier 2: WASM plugins** (any language, isolated):
- Authored in any WASM-targeting language: Rust, AssemblyScript, Zig, C/C++.
- Run in an isolated WASM runtime within the sim worker (separate memory space).
- Access engine via a **stable ABI** (`abi.ts`): component read/write, SAB channel allocation, system registration, event subscription. ABI is versioned and backwards-compatible.
- SAB access: WASM plugins receive a SAB pointer for their allocated channel. They read/write via WASM memory + atomic ops.
- Safer: WASM fault doesn't crash the sim worker — the plugin is marked failed, its systems are unregistered, and an error is surfaced.
- Best for: third-party plugins, untrusted code, distribution, cross-language support.
- Loaded via `wasm-loader.ts` — instantiates the WASM module, provides ABI imports, calls `register()`.

**Plugin interface** (both tiers):
```typescript
interface Plugin {
  name: string;
  version: string;
  dependencies?: string[];  // other plugin names
  register(ctx: PluginContext): void;
}

interface PluginContext {
  registerComponent<T>(name: string, schema: T): ComponentId;
  registerSystem(stage: Stage, system: System): void;
  allocateSABChannel(name: string, size: number): SABChannel;
  registerResource<T>(name: string, value: T): void;
  registerMigration(fromVersion: number, fn: MigrationFn): void;  // save schema
  onDispose(fn: () => void): void;
}
```

### 19. Builder Modes (Angular-like Build Profiles)

**Design**:
- **`draft dev`**: Chromium (Blink) WebView + full devtools panel. Telemetry enabled. Hot-reload for shaders, scripts, meshes, textures. Debug draw + toggles active. Input context includes Editor mode. Fastest iteration loop.
- **`draft debug`**: WebKit WebView (production engine). Telemetry enabled. No devtools panel (but MCP still available). Used to catch WebKit-specific rendering issues before shipping. Input context is Game-only.
- **`draft build` / `draft export`**: System WebView, optimized bundle. All instrumentation compiled out. No devtools, no debug draw, no telemetry. Input context is Game-only. Ready for distribution.

**Devtools panel** (dev mode only, modeled on to-the-ocean's devtools extension):
- **Asset loader**: Browse loaded assets, trigger hot-reload, import new assets.
- **Debug toggles**: Hitboxes (collider wireframes), velocity vectors, raycast visualization, wireframe mode, normal visualization, LOD boundaries.
- **Telemetry graphs**: Real-time GC pause, memory usage, CPU time per thread. Per-system timing breakdown.
- **Entity inspector**: Scene tree with parent/child hierarchy, component dump, live edit of component values.

**WGPU device loss handling**: All modes handle `device.lost` by attempting device reinitialization. In dev mode, a warning banner appears. In prod mode, the render loop pauses and a "GPU device lost" screen is shown. This mirrors to-the-ocean's `WebGPURenderer` device loss handling.

### 20. DB Worker + Save System Integration

**Clarification**: The DB worker handles persistence; the save system handles serialization + schema migration. They interact as follows:
- **Saving**: Main process triggers save → DB worker receives save command → DB worker calls `SaveSystem.serialize(scene)` → writes JSON + binary blobs to disk → records save metadata in SQLite.
- **Loading**: DB worker reads save file → calls `SaveSystem.load(path)` → `SaveSystem` runs migration chain → returns migrated data → DB worker sends to main process via postMessage.
- **Migrations**: Run by the `SaveSystem` (in the DB worker), not the main process. This keeps migration CPU off the main thread. Plugin-registered migrations are queried from the main process at startup and sent to the DB worker.
- **Checkpoints**: Lightweight saves (entity state only, no assets) written periodically by the DB worker. Used by crash supervisor for recovery.

**Asset packing**: Not ASAR (Electron concept). Custom format with random access + per-asset compression. Supports incremental updates (diff-patch new assets without repacking everything). In dev mode, assets are loaded directly from filesystem (no packing) for hot-reload compatibility.

---

## Implementation Phases

> **Timeline note**: Estimates are optimistic for a single developer. Items marked **(stretch)** can slip without blocking the next phase. Each phase's required items are the minimum for the deliverable.

### Phase 1: Foundation (Weeks 1-4)
**Goal**: Minimal working engine — spinning cube on GpuWindow + React UI overlay.

- [ ] Monorepo scaffold (bun workspaces, packages structure)
- [ ] **Spike**: Verify WGPU surface creation from Bun FFI using Electrobun's GpuWindow native handle. If this fails, pivot to fallback architecture (headless Bun + Dawn).
- [ ] Electrobun config + GpuWindow + BrowserWindow overlay
- [ ] WGPU device/surface initialization (Dawn via `bundleWGPU`)
- [ ] Basic render loop (clear color → present)
- [ ] HiDPI: scale factor detection + surface reconfigure on resize/DPI change
- [ ] WGPU device loss handling (reinit + warning banner)
- [ ] ECS core: Entity, Component, Archetype, Query, System, Schedule (single-threaded)
- [ ] Hierarchy: Parent/Child side table, implicit root, dirty-flag propagation, lazy world matrix
- [ ] Change detection: per-component tick slot, `Changed<T>` query filter
- [ ] SeqlockBuffer primitive in `sab/seqlock.ts` (one implementation, reused by all channels)
- [ ] SAB channels: transform buffer (sim → render), input buffer (webview → sim) — both using SeqlockBuffer
- [ ] Sim worker bootstrap (worker_threads + SAB)
- [ ] Basic input: keyboard/mouse in webview → SAB → sim + input context router (Editor vs Game)
- [ ] Electrobun RPC: UI ↔ Bun communication
- [ ] Single render pass: opaque mesh with vertex color shader
- [ ] Procedural mesh builder (cube, plane, sphere)
- [ ] Camera component + orbit camera
- [ ] Builder mode system: `draft dev` mode with Chromium + devtools panel scaffold
- [ ] Telemetry: basic GC + memory + CPU tracking per thread
- [ ] Colocated test setup (bun test, first unit tests for ECS + SeqlockBuffer)
- [ ] Debug draw API: lines + points (basic)

**Deliverable**: Cube on screen, orbit camera with mouse, React UI overlay with FPS counter + devtools panel. Hierarchy + change detection + HiDPI working.

### Phase 2: Rendering Core (Weeks 5-8)
**Goal**: PBR rendering with textures, lighting, post-processing, and TAA.

- [ ] GLB/GLTF mesh loader
- [ ] Texture loader (PNG, WebP, KTX2)
- [ ] Material system: code-defined materials with WGSL
- [ ] PBR material (albedo, normal, roughness, metallic, AO)
- [ ] Vertex layout system (position, normal, uv, tangent, bone indices/weights)
- [ ] Render graph: depth prepass → opaque → transparent → post-process. Auto resource aliasing + usage flag sync.
- [ ] TrackedRenderPass (state deduplication)
- [ ] Pipeline cache + specialization
- [ ] Directional light + shadow map pass
- [ ] Point lights (up to 8, forward-rendered for transparent, deferred for opaque)
- [ ] G-Buffer layout (albedo, normal, roughness, metallic, depth, **velocity** for TAA)
- [ ] Velocity buffer generation (curr vs prev frame screen-space motion)
- [ ] Deferred lighting pass (fullscreen compute)
- [ ] Post-process: tonemapping (ACES), bloom, **TAA** (uses velocity), FXAA fallback, color grading
- [ ] Skybox render pass
- [ ] GPU buffer management (ring buffer for uniforms, arena for per-frame)
- [ ] Bind group caching
- [ ] Frustum culling (CPU-side, per-entity AABB)
- [ ] Material hot-reload (file watcher → pipeline invalidation) + mesh/texture hot-reload
- [ ] HDR support: RGBA16F swap chain, scRGB color space, physical light units
- [ ] Debug draw: text labels + persistent draws
- [ ] Vision test: screenshot + pixel scan for "cube renders correctly"

**Deliverable**: Textured PBR model with directional light + shadows + TAA + post-processing. HDR working on capable displays.

### Phase 3: Physics & Animation (Weeks 9-12)
**Goal**: Interactive physics (pluggable, multi-realm) + animated characters.

- [ ] PhysicsBackend interface + registry
- [ ] Rust physics library (`physics-native/`): rapier3d wrapper, multi-realm support
- [ ] FFI bindings: `physics_step` operating on SAB, `create_realm` for multiple worlds (cross-platform path)
- [ ] Physics lifecycle: app-start, scene-start, on-demand bootstrap sequences
- [ ] physics-rapier plugin (implements PhysicsBackend, wraps physics-native)
- [ ] Body types: static, dynamic, kinematic
- [ ] Character controller (kinematic + manual collision resolution)
- [ ] Raycast API + debug draw visualization for raycasts
- [ ] Collision events → ECS event channels
- [ ] WASM fallback (Rapier compat)
- [ ] Skeleton + bone hierarchy loading from GLB
- [ ] Animation clip loading + playback
- [ ] Animation blending (crossfade, additive)
- [ ] Animation state machine
- [ ] GPU skinning (compute shader → skin matrix buffer)
- [ ] Generic animation retargeting
- [ ] Mixamo retargeting (strip `mixamorig:` prefix, T→A pose calibration, cached bone-mapping table)
- [ ] LOD generation (mesh decimation) **(stretch)**
- [ ] LOD selection (screen-space error metric) **(stretch)**

**Deliverable**: Physics playground with dynamic objects + animated character (Mixamo retargeted). Debug toggles for hitboxes + raycasts.

### Phase 4: World, Scene, Plugins & Audio (Weeks 13-16)
**Goal**: Large worlds with streaming + scene persistence + first-party plugins + audio.

- [ ] Plugin system: TS plugin loader + registry + dependency resolution
- [ ] WASM plugin loader + stable ABI **(stretch)**
- [ ] Scene serialization/deserialization (JSON + binary)
- [ ] Save system with schema versioning + migration registry (fault-tolerant, plugin-extensible)
- [ ] DB worker + save system integration (migrations in DB worker, checkpoints)
- [ ] World = scene + systems + resources + plugins
- [ ] Entity prefabs (reusable entity templates)
- [ ] Chunked world streaming (load/unload based on camera distance)
- [ ] Spatial partitioning (grid-based for broadphase culling)
- [ ] **Water plugin** (first-party): Gerstner waves, refraction, reflection, SAB channel via SeqlockBuffer
- [ ] **Marching cubes terrain plugin** (first-party): volumetric generation, deformation, chunked LOD, SAB channel via SeqlockBuffer
- [ ] Vegetation system (instanced rendering, wind animation)
- [ ] Day/night cycle (sun angle, sky color, fog)
- [ ] Fog + atmospheric scattering
- [ ] Scene tree UI panel (React, shows parent/child hierarchy)
- [ ] Inspector panel (component editing)
- [ ] Sim-worker crash recovery (supervisor, restart once, fatal on second crash)
- [ ] Audio system: Rust FFI with kira backend, AudioBackend interface
- [ ] audio-kira plugin (implements AudioBackend, wraps audio-native)
- [ ] Audio position SAB channel (SeqlockBuffer)
- [ ] Scripting model: script lifecycle, ScriptContext, hot-reload with side-effect cleanup

**Deliverable**: Island scene with terrain (marching cubes), water (plugin), vegetation, day/night cycle, audio. Crash recovery active. Scripts working.

### Phase 5: MCP Server (Weeks 17-20)
**Goal**: AI agent can design, build, debug, and manage assets for a game via prompts.

- [ ] MCP server bootstrap (stdio transport)
- [ ] Scene tools: create/load/save/modify scenes
- [ ] Entity tools: spawn/modify/remove/query
- [ ] Component tools: add/remove/inspect
- [ ] Material tools: create/modify/assign/hot-reload
- [ ] Mesh tools: import/generate/LOD
- [ ] Lighting tools: add lights, set sun, configure shadows
- [ ] Camera tools: position, mode, follow
- [ ] Physics tools: colliders, body types, forces, raycast, realm management
- [ ] Debug tools: profile, visualize, screenshot, inspect GPU, telemetry
- [ ] Rich object inspection: `inspect_object` (hierarchy traversal, path query), `inspect_component` (deep dump), `query_entities` (filter by type/region/path/property)
- [ ] Checkpoint tools: create/restore/list/diff checkpoints
- [ ] Undo/redo: reverse/re-apply MCP operations
- [ ] Script tools: create/attach/hot-reload TypeScript game logic
- [ ] Asset tools: import/convert/list/validate
- [ ] Build tools: build/export/validate
- [ ] Resources: scene tree, entity state, performance, GPU info, asset list, checkpoint list, crash events, telemetry
- [ ] Prompt templates: common task scaffolds
- [ ] End-to-end test: AI agent builds a simple scene from scratch

**Deliverable**: AI agent can create a scene, spawn entities, assign materials, add lighting, debug issues, undo mistakes, and manage checkpoints — all via MCP tools.

### Phase 6: Polish & Distribution (Weeks 21-24)
**Goal**: Production-ready engine + reference game.

- [ ] Particle system (GPU compute + instanced rendering)
- [ ] Material graph editor UI (React, node-based)
- [ ] Animation state machine editor UI
- [ ] Asset browser UI
- [ ] Performance profiler UI (frame time graph, system timings, telemetry)
- [ ] Debug visualization modes (wireframe, AABBs, normals, overdraw, LOD) — wired to devtools toggles
- [ ] Builder modes: `draft debug` (WebKit) + `draft build` (prod, instrumentation compiled out)
- [ ] CLI: `draft init`, `draft dev`, `draft debug`, `draft build`, `draft export`
- [ ] Cross-platform testing (Windows, macOS, Linux)
- [ ] Vision test suite: LLM-based + pixel-scan for all example scenes
- [ ] Documentation: API reference, tutorials, getting started
- [ ] Reference game: simplified ocean survival game (uses water + marching-cubes + audio plugins)
- [ ] Networking plugin (on-demand) **(stretch)**
- [ ] GPU-driven rendering (indirect draws, GPU culling) — **stretch goal**
- [ ] Visibility buffer rendering (Nanite-style) — **research goal**

**Deliverable**: Production-ready engine with particles, editor UIs, all builder modes, cross-platform builds, and reference game.

---

## Key Design Principles

1. **Data-oriented, not object-oriented**: Components are plain data. Systems are functions over data. No deep class hierarchies. Cache-friendly memory layout.

2. **Elegant APIs over legacy conventions**: No Three.js `Object3D` inheritance chains. No Babylon scene graph complexity. Components are composable, not inherited. Materials are declarative. Shaders are hot-reloadable. Angular-like abstraction: users never touch engine internals — they interact via declarative APIs, plugins, and scripts.

3. **Performance is a feature**: SAB for zero-copy state transfer. Batched FFI for physics. TrackedRenderPass for GPU state deduplication. Ring buffers for per-frame uniforms. Indexed `for` loops in hot paths (not `for..of`).

4. **AI-first tooling**: Every engine operation is exposed via MCP tools. The agent doesn't need the user to paste stdout — it queries structured data directly. Hot-reload everything (shaders, scripts, materials) so changes are instant.

5. **Platform abstraction, not platform limitation**: WGPU (Dawn) provides cross-platform GPU access. Rust FFI provides native physics + audio. Electrobun provides window management. The engine never touches platform-specific APIs directly. Builder modes (dev/debug/prod) abstract WebView differences.

6. **Lessons from to-the-ocean**:
   - Generational indices for entity handles (prevents stale-handle corruption)
   - SAB + sequence counters for buffer synchronization (proven at 60fps) → now unified into SeqlockBuffer
   - Worker thread isolation for sim (clean GC heap, no main-thread blocking)
   - Rapier physics with NaN/Infinity guards on all inputs
   - System-level performance timing (per-system ms tracking)
   - Buffer snapshot protocol (sim writes SAB, render reads SAB, zero copy)
   - Single source of truth for geometry data (CELL_GEOMETRY pattern — never duplicate definitions)
   - Sim worker crash recovery (panicRecover pattern → now formalized as supervisor)

7. **Lessons from Bevy**:
   - Archetype-based ECS with SoA storage
   - Render graph as schedule (not separate graph API)
   - TrackedRenderPass for state deduplication
   - Pipeline cache with lazy specialization
   - Double-buffered events for inter-system communication

8. **Lessons from Unreal**:
   - Material graph → compiled shader (node-based, artist-friendly)
   - Deferred rendering with G-Buffer
   - Visibility buffer as future rendering path
   - GPU-driven pipeline (indirect draws, GPU culling)
   - Animation state machines with blend trees
   - Asset streaming based on distance

---

## Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Bun | Fast JS/TS runtime, native FFI, worker_threads, WASM support |
| Desktop framework | Electrobun | Tiny bundles, GpuWindow, BrowserWindow overlay, typed RPC |
| GPU | WGPU (Dawn) | Cross-platform, WebGPU standard, compute shaders, FFI from Bun |
| Physics | Rapier3d (Rust native, pluggable) | Proven in to-the-ocean, batched FFI, multi-realm, PhysicsBackend interface |
| Audio | kira (Rust native, pluggable) | Low-latency, AudioBackend interface (oddio/rodio swappable) |
| ECS | Custom (TypeScript) | Archetype-based, SoA storage, Bevy-inspired, tick-based change detection |
| UI | React + Tailwind | Mature ecosystem, component model fits editor panels |
| Build | Bun bundler + Electrobun | Native TS bundling, differential updates, builder modes (dev/debug/prod) |
| MCP | Custom server (TypeScript) | stdio transport, ~50 tools, structured JSON responses |
| Database | SQLite (via Bun) | Embedded, fast, no server process needed |
| Plugins (TS) | TypeScript (in-process) | Fastest path, full ECS access, no sandbox |
| Plugins (WASM) | Any WASM language | Isolated, stable ABI, SAB access, safe for third-party |
| Shaders | WGSL | WebGPU standard, hot-reloadable, cross-platform |

---

## Risk Register

| Risk | Severity | Mitigation |
|---|---|---|
| `bun:ffi` instability | High | Design FFI boundary as thin wrapper. Fallback to Node-API (N-API) which has stable ABI. WASM Rapier as secondary fallback. |
| WGPU surface from Bun FFI | High | Phase 1 spike verifies this early. Fallback: headless Bun + Dawn rendering to native window handle. |
| Electrobun GpuWindow + WGPU | Medium | Electrobun is solid enough; we can fork if needed. Fallback: headless Bun + Dawn. |
| HiDPI + HDR support | Medium | HiDPI: platform-specific scale detection + surface reconfigure. HDR: RGBA16F + scRGB via Dawn, SDR fallback. |
| WebKitGTK rendering differences | Medium | Use `bundleWGPU` for GPU (not webview). UI is simple React — minimal rendering differences. |
| Electrobun maturity on Windows | Medium | Test early on Windows. Fallback to `bundleCEF` if system webview issues. |
| MCP tool complexity | Medium | Start with 10 core tools. Expand based on real agent usage. |
| GPU-driven rendering | High (stretch) | Not MVP. Phase 6 stretch goal. Traditional rendering first. |
| Audio spatial quality | Low | kira via Rust FFI (Phase 4). AudioBackend interface allows swapping. |
| WASM plugin ABI stability | Medium | Versioned ABI, backwards-compatible. Breaking changes require major version bump. |
| Builder mode WebView differences | Medium | dev (Chromium) vs debug (WebKit) vs prod (system). Engine never depends on WebView internals. |
| Telemetry overhead in dev | Low | Instrumentation compiled out in prod. Dev mode overhead is <1% (counter-based, not sampling). |
| Cross-platform physics lib | Medium | Cross-compile Rust for win/mac/linux. Test on all three. |
| Sim-worker crash recovery | Medium | Supervisor restarts once from checkpoint. Fatal on second crash. MCP surfaces crash events. |
| Schema migration failures | Low | Per-field try/catch, defaults on failure, plugin-extensible migration registry. |
| Vision test reliability | Medium | Dual approach: pixel-scan for deterministic checks, LLM for complex assertions. Save screenshots on failure. |
