// ============================================================================
// UndertowLib — declarative engine library descriptor for @downdraft/library-undertow
//
// Undertow is a lock-free DOM proxy that moves arbitrary client UI code into a
// Web Worker via a resizable SharedArrayBuffer + Atomics. The MainThreadHost
// owns the dom-sab, handle table, op-map, string pool, and payload heap on the
// main thread; it drains the request ring each frame and writes replies.
//
// Games declare `libraries: [UndertowLib]` (or
// `[[UndertowLib, { ...MainThreadHostOptions }]]` to override config) in their
// GameModule. The host creates the MainThreadHost and exposes it via the
// UndertowTok token.
//
// Games that need full control can still import MainThreadHost directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { MainThreadHost, type MainThreadHostOptions } from "./main/host";

// ── Config ──

export interface UndertowLibConfig extends MainThreadHostOptions {
  /** Drain interval in milliseconds (high-frequency fallback). Default: 4. */
  drainIntervalMs?: number;
}

// ── Typed tokens (DI) ──

/** Token for the main-thread DOM proxy host. Inject in renderer systems. */
export const UndertowTok = resourceToken<MainThreadHost>("undertow:host");

// ── Descriptor ──

export const UndertowLib: EngineLibrary<UndertowLibConfig> = {
  name: "undertow",
  version: "1.0.0",

  // MainThreadHost allocates its own SAB via allocateDomSab() in the
  // constructor, so no sabChannels are declared here — the host manages the
  // dom-sab lifecycle internally (including grow).

  provides: [UndertowTok],

  sim: {
    create(config, ctx) {
      const host = new MainThreadHost(config);
      ctx.provide(UndertowTok, host);
      return host;
    },
    dispose(host) {
      // MainThreadHost.dispose() stops the high-frequency drain interval.
      (host as MainThreadHost).dispose();
    },
    // tick is game-specific (games call host.drain() on rAF or on
    // Atomics.notify from the worker) — games wire this via onReady.
  },

  tickPhase: "pre-physics",

  defaultConfig: {
    drainIntervalMs: 4,
  },
};
