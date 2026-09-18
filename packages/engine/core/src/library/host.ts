// ============================================================================
// LibraryHostImpl — wires EngineLibrary descriptors
//
// Created by startGame() (renderer side) and the sim worker (sim side).
// Manages SAB allocation, sim system lifecycle, renderer pass lifecycle,
// and DI token registration.
//
// In DOWNDRAFT_STRICT mode, validates the library dependency graph
// (provides/requires) and warns about potential leaks (library provides
// resources or allocates SAB channels but has no dispose hook).
// ============================================================================

import type { ResourceToken } from "../ecs/resource";
import { assertNoDuplicate, assertRequired, isStrict, warnLeak } from "../module/diagnostics";
import type {
    EngineLibrary,
    LibraryEntry,
    LibraryHost,
    LibraryRendererCreateContext,
    LibraryRendererDrawContext,
    LibraryRendererInitContext,
    LibrarySimContext,
    LibrarySimTickContext,
    LibraryTickPhase
} from "./library";

interface ActiveLibrary<C = unknown> {
  lib: EngineLibrary<C>;
  config: C;
  simSystem: unknown;
  rendererInstance: unknown;
  /** Token keys provided on the sim side (cleanup + leak detection). */
  simProvidedKeys: Set<string>;
  /** Token keys provided on the renderer side (cleanup + leak detection). */
  rendererProvidedKeys: Set<string>;
  /** SAB channel names this library allocated (for leak detection). */
  sabChannelNames: Set<string>;
  /** Whether this library registered a sim dispose hook. */
  hasSimDispose: boolean;
  /** Whether this library registered a renderer dispose hook. */
  hasRendererDispose: boolean;
}

export class LibraryHostImpl implements LibraryHost {
  private libraries: ActiveLibrary[] = [];
  private buffers: Record<string, SharedArrayBuffer> = {};
  private byPhase: Record<LibraryTickPhase, ActiveLibrary[]> = {
    "pre-physics": [],
    "physics": [],
    "post-physics": [],
    "terrain": [],
    "buffer-write": [],
  };
  /** Token keys → provider library name (for DI validation). */
  private providers: Map<string, string> = new Map();

  constructor(entries: LibraryEntry[]) {
    for (const entry of entries) {
      const lib = Array.isArray(entry) ? entry[0] : entry;
      const config = (Array.isArray(entry) ? entry[1] : lib.defaultConfig) as unknown;
      this.libraries.push({
        lib,
        config,
        simSystem: null,
        rendererInstance: null,
        simProvidedKeys: new Set(),
        rendererProvidedKeys: new Set(),
        sabChannelNames: new Set(),
        hasSimDispose: false,
        hasRendererDispose: false,
      });
    }
  }

  allocateBuffers(): Record<string, SharedArrayBuffer> {
    for (const active of this.libraries) {
      const channels = active.lib.sabChannels ?? [];
      for (const ch of channels) {
        if (this.buffers[ch.name]) {
          const msg = `SAB channel "${ch.name}" declared by library "${active.lib.name}" is already allocated — duplicate channel names across libraries are not allowed`;
          if (isStrict()) throw new Error(msg);
          console.warn(`[LibraryHost] ${msg}`);
          continue;
        }
        this.buffers[ch.name] = new SharedArrayBuffer(ch.size);
        active.sabChannelNames.add(ch.name);
      }
    }
    return this.buffers;
  }

  /**
   * Validate the library dependency graph: check for duplicate provides
   * and missing requires providers. Called automatically in STRICT mode
   * during initSim/initRenderer. Can be called manually before init.
   */
  validateGraph(): void {
    if (!isStrict()) return;
    const allProviders = new Map<string, string>();
    for (const active of this.libraries) {
      for (const token of active.lib.provides ?? []) {
        if (allProviders.has(token.key)) {
          throw new Error(
            `Library "${active.lib.name}" provides "${token.key}" but it is already provided by "${allProviders.get(token.key)}". ` +
              `Duplicate provides are not allowed.`,
          );
        }
        allProviders.set(token.key, active.lib.name);
      }
    }
    for (const active of this.libraries) {
      if (!active.lib.requires) continue;
      for (const token of active.lib.requires) {
        if (!allProviders.has(token.key)) {
          assertRequired(allProviders, token, active.lib.name);
        }
      }
    }
  }

  initSim(ctx: LibrarySimContext): void {
    this.validateGraph();
    for (const active of this.libraries) {
      if (!active.lib.sim) continue;
      const libCtx: LibrarySimContext = {
        buffers: this.buffers,
        provide: (token: ResourceToken<unknown>, value: unknown) => {
          if (isStrict()) {
            assertNoDuplicate(this.providers, token, active.lib.name);
          }
          this.providers.set(token.key, active.lib.name);
          active.simProvidedKeys.add(token.key);
          // Delegate to the host's provide if available (for ModuleHost integration)
          ctx.provide(token, value);
        },
        inject: ctx.inject,
        injectOptional: ctx.injectOptional,
      };
      active.simSystem = active.lib.sim.create(active.config, libCtx);
      active.hasSimDispose = !!active.lib.sim.dispose;
      const phase = active.lib.tickPhase ?? "post-physics";
      this.byPhase[phase].push(active);
    }
  }

  initSimWithExistingBuffers(
    buffers: Record<string, SharedArrayBuffer>,
    ctx: Omit<LibrarySimContext, "buffers">,
  ): void {
    // Reuse pre-allocated SABs (e.g. from the renderer side) instead of allocating new ones.
    this.buffers = buffers;
    // Record SAB channel names for leak detection.
    for (const active of this.libraries) {
      const channels = active.lib.sabChannels ?? [];
      for (const ch of channels) {
        if (buffers[ch.name]) {
          active.sabChannelNames.add(ch.name);
        }
      }
    }
    this.initSim({ buffers: this.buffers, ...ctx });
  }

  tickPhase(phase: LibraryTickPhase, tickCtx: LibrarySimTickContext): void {
    const libs = this.byPhase[phase];
    for (const active of libs) {
      if (active.lib.sim?.tick && active.simSystem !== null) {
        active.lib.sim.tick(active.simSystem, tickCtx);
      }
    }
  }

  /**
   * Call `renderer.create` for libraries that define it. Runs early, before
   * the WebGPU device is acquired. The returned instance is stored and later
   * passed to `renderer.init` (if defined) as the first arg, so a library
   * can use `create` to build a host and `init` to wire GPU passes onto it.
   */
  createRenderer(ctx: LibraryRendererCreateContext): void {
    this.validateGraph();
    for (const active of this.libraries) {
      if (!active.lib.renderer?.create) continue;
      const cctx: LibraryRendererCreateContext = {
        provide: (token: ResourceToken<unknown>, value: unknown) => {
          if (isStrict()) {
            assertNoDuplicate(this.providers, token, active.lib.name);
          }
          this.providers.set(token.key, active.lib.name);
          active.rendererProvidedKeys.add(token.key);
          ctx.provide(token, value);
        },
        inject: ctx.inject,
        injectOptional: ctx.injectOptional,
      };
      active.rendererInstance = active.lib.renderer.create(active.config, cctx);
      // `create`-only libraries (no init/draw) still get dispose + leak detection.
      active.hasRendererDispose = !!active.lib.renderer.dispose;
    }
  }

  initRenderer(ctx: LibraryRendererInitContext): void {
    this.validateGraph();
    for (const active of this.libraries) {
      if (!active.lib.renderer?.init) continue;
      const rctx: LibraryRendererInitContext = {
        device: ctx.device,
        format: ctx.format,
        provide: (token: ResourceToken<unknown>, value: unknown) => {
          if (isStrict()) {
            assertNoDuplicate(this.providers, token, active.lib.name);
          }
          this.providers.set(token.key, active.lib.name);
          active.rendererProvidedKeys.add(token.key);
          ctx.provide(token, value);
        },
        inject: ctx.inject,
        injectOptional: ctx.injectOptional,
      };
      // If `create` ran and returned an instance, keep it unless `init`
      // returns a new one. A library that defines both `create` and `init`
      // can access its `create`-built host via DI (`ctx.inject` — `create`
      // provided it) and wire GPU passes onto it inside `init`.
      // Backwards-compatible: libraries without `create` get `init`'s return.
      const created = active.rendererInstance;
      const inst = active.lib.renderer.init(active.config, rctx);
      active.rendererInstance = inst ?? created;
      active.hasRendererDispose = !!active.lib.renderer.dispose;
    }
  }

  setRendererBuffers(buffers: Record<string, SharedArrayBuffer>): void {
    for (const active of this.libraries) {
      if (!active.lib.renderer?.setBuffers || active.rendererInstance === null) continue;
      active.lib.renderer.setBuffers(active.rendererInstance, buffers, {
        provide: (token: ResourceToken<unknown>, _value: unknown) => {
          if (isStrict()) {
            assertNoDuplicate(this.providers, token, active.lib.name);
          }
          this.providers.set(token.key, active.lib.name);
          active.rendererProvidedKeys.add(token.key);
        },
      });
    }
  }

  drawRenderer(ctx: LibraryRendererDrawContext): void {
    for (const active of this.libraries) {
      if (active.lib.renderer?.draw && active.rendererInstance !== null) {
        active.lib.renderer.draw(active.rendererInstance, ctx);
      }
    }
  }

  disposeSim(): void {
    for (const active of this.libraries) {
      // Leak detection: warn if library provided resources or allocated SAB
      // channels but has no sim dispose hook.
      if (isStrict()) {
        warnLeak(active.lib.name, {
          providedCount: active.simProvidedKeys.size,
          sabCount: active.sabChannelNames.size,
          disposeFnCount: active.hasSimDispose ? 1 : 0,
        });
      }
      if (active.lib.sim?.dispose && active.simSystem !== null) {
        try { active.lib.sim.dispose(active.simSystem); } catch { /* ignore */ }
      }
      active.simSystem = null;
      // Clean up sim-side provided tokens only — renderer-side providers
      // belong to the renderer lifecycle and are cleaned by disposeRenderer().
      for (const key of active.simProvidedKeys) {
        this.providers.delete(key);
      }
      active.simProvidedKeys.clear();
    }
    // Clear tick-phase registrations so a subsequent initSim doesn't
    // double-register libraries and double-tick them.
    for (const phase of Object.keys(this.byPhase) as LibraryTickPhase[]) {
      this.byPhase[phase].length = 0;
    }
  }

  disposeRenderer(): void {
    for (const active of this.libraries) {
      if (isStrict()) {
        warnLeak(active.lib.name, {
          providedCount: active.rendererProvidedKeys.size,
          sabCount: active.sabChannelNames.size,
          disposeFnCount: active.hasRendererDispose ? 1 : 0,
        });
      }
      if (active.lib.renderer?.dispose && active.rendererInstance !== null) {
        try { active.lib.renderer.dispose(active.rendererInstance); } catch { /* ignore */ }
      }
      active.rendererInstance = null;
      for (const key of active.rendererProvidedKeys) {
        this.providers.delete(key);
      }
      active.rendererProvidedKeys.clear();
    }
  }
}
