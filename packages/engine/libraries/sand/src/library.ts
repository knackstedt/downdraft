// ============================================================================
// SandLib — declarative engine library descriptor for @downdraft/engine/libraries/sand
//
// Games declare `libraries: [SandLib]` (or with config override) in their
// GameModule. The host allocates the sand grid SAB, creates the SandWorld
// (sim-side), and exposes it via a typed token.
//
// Games that need full control can still import SandWorld directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/engine";
import { SandWorld } from "./sand-world";

// ── Config ──

export interface SandLibConfig {
  /** Grid width. Default: 256. */
  width?: number;
  /** Grid height. Default: 256. */
  height?: number;
  /** Whether to allocate a SAB for the grid (multi-threaded sand step). Default: true. */
  useSAB?: boolean;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side sand world. Inject in sim systems that need sand. */
export const SandWorldTok = resourceToken<SandWorld>("sand:world");

// ── SAB channel sizing ──

// Grid: W*H cells * 4 bytes (Uint32Array)
// Fields: W*H cells * 4 bytes (Uint8Array: gravity, temp, windX, windY)
// Skip mask: W*H cells * 1 byte
// Deferred mask: W*H cells * 1 byte
function sandSABSize(w: number, h: number): number {
  const cells = w * h;
  return cells * 4 + cells * 4 + cells + cells;
}

// ── Descriptor ──

export const SandLib: EngineLibrary<SandLibConfig> = {
  name: "sand",
  version: "1.0.0",

  sabChannels: [
    { name: "sand", size: sandSABSize(256, 256) },
  ],

  provides: [SandWorldTok],

  sim: {
    create(config, ctx) {
      const w = config.width ?? 256;
      const h = config.height ?? 256;
      const cells = w * h;
      const gridBytes = cells * 4;
      const fieldsBytes = cells * 4;
      const skipMaskOffset = gridBytes + fieldsBytes;
      const deferredMaskOffset = skipMaskOffset + cells;

      const world = new SandWorld(w, h, {
        sab: ctx.buffers.sand,
        gridOffset: 0,
        fieldsOffset: gridBytes,
        skipMaskOffset,
        deferredMaskOffset,
      });
      ctx.provide(SandWorldTok, world);
      return world;
    },
    dispose(world) {
      // SandWorld holds SAB views — no GPU resources to free.
      // The SAB itself is managed by the host.
    },
    // tick is game-specific (calls world.step() with material rules, etc.)
    // — games wire this via onReady or a sim system.
  },

  tickPhase: "post-physics",

  // No renderer setup — sand rendering is game-specific (the game creates
  // a sand render pass that reads the grid SAB).

  defaultConfig: {
    width: 256,
    height: 256,
    useSAB: true,
  },
};
