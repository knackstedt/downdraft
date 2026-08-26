// ============================================================================
// LibraryHostImpl — wires EngineLibrary descriptors
//
// Created by startGame() (renderer side) and the sim worker (sim side).
// Manages SAB allocation, sim system lifecycle, renderer pass lifecycle,
// and DI token registration.
// ============================================================================

import type {
  EngineLibrary,
  LibraryEntry,
  LibraryHost,
  LibraryRendererDrawContext,
  LibraryRendererInitContext,
  LibrarySABChannel,
  LibrarySimContext,
  LibrarySimTickContext,
  LibraryTickPhase,
} from "./library";

interface ActiveLibrary<C = unknown> {
  lib: EngineLibrary<C>;
  config: C;
  simSystem: unknown;
  rendererInstance: unknown;
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

  constructor(entries: LibraryEntry[]) {
    for (const entry of entries) {
      const lib = Array.isArray(entry) ? entry[0] : entry;
      const config = (Array.isArray(entry) ? entry[1] : lib.defaultConfig) as unknown;
      this.libraries.push({ lib, config, simSystem: null, rendererInstance: null });
    }
  }

  allocateBuffers(): Record<string, SharedArrayBuffer> {
    for (const active of this.libraries) {
      const channels = active.lib.sabChannels ?? [];
      for (const ch of channels) {
        this.buffers[ch.name] = new SharedArrayBuffer(ch.size);
      }
    }
    return this.buffers;
  }

  initSim(ctx: LibrarySimContext): void {
    for (const active of this.libraries) {
      if (!active.lib.sim) continue;
      const libCtx: LibrarySimContext = {
        buffers: this.buffers,
        inject: ctx.inject,
        injectOptional: ctx.injectOptional,
      };
      active.simSystem = active.lib.sim.create(active.config, libCtx);
      const phase = active.lib.tickPhase ?? "post-physics";
      this.byPhase[phase].push(active);
    }
  }

  tickPhase(phase: LibraryTickPhase, tickCtx: LibrarySimTickContext): void {
    const libs = this.byPhase[phase];
    for (const active of libs) {
      if (active.lib.sim?.tick && active.simSystem !== null) {
        active.lib.sim.tick(active.simSystem, tickCtx);
      }
    }
  }

  initRenderer(ctx: LibraryRendererInitContext): void {
    for (const active of this.libraries) {
      if (!active.lib.renderer?.init) continue;
      const rctx: LibraryRendererInitContext = {
        device: ctx.device,
        format: ctx.format,
        inject: ctx.inject,
        injectOptional: ctx.injectOptional,
      };
      active.rendererInstance = active.lib.renderer.init(active.config, rctx);
    }
  }

  setRendererBuffers(buffers: Record<string, SharedArrayBuffer>): void {
    for (const active of this.libraries) {
      if (!active.lib.renderer?.setBuffers || active.rendererInstance === null) continue;
      active.lib.renderer.setBuffers(active.rendererInstance, buffers);
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
      if (active.lib.sim?.dispose && active.simSystem !== null) {
        try { active.lib.sim.dispose(active.simSystem); } catch { /* ignore */ }
      }
      active.simSystem = null;
    }
  }

  disposeRenderer(): void {
    for (const active of this.libraries) {
      if (active.lib.renderer?.dispose && active.rendererInstance !== null) {
        try { active.lib.renderer.dispose(active.rendererInstance); } catch { /* ignore */ }
      }
      active.rendererInstance = null;
    }
  }
}
