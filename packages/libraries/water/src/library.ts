// ============================================================================
// WaterLib — declarative engine library descriptor for @downdraft/library-water
//
// Games declare `libraries: [WaterLib]` (or `[[WaterLib, { patchSize: 8 }]]`
// to override config) in their GameModule. The host allocates the water SAB,
// creates the WaterBufferWriter (sim-side) and WaterBufferReader (renderer-side),
// and exposes them via typed tokens.
//
// Games that need full control can still import WaterBufferWriter/Reader
// directly (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { WaterBufferReader, WaterBufferWriter, WaterChannel } from "./water-sab";

// ── Config ──

export interface WaterLibConfig {
  /** Water grid patch size (grid units per patch). Default: 4. */
  patchSize?: number;
  /** Water grid resolution. Default: 256 (from WaterChannel). */
  gridSize?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side water buffer writer. Inject in sim systems. */
export const WaterWriterTok = resourceToken<WaterBufferWriter>("water:writer");
/** Token for the renderer-side water buffer reader. Inject in renderer passes. */
export const WaterReaderTok = resourceToken<WaterBufferReader>("water:reader");

// ── Descriptor ──

export const WaterLib: EngineLibrary<WaterLibConfig> = {
  name: "water",
  version: "1.0.0",

  sabChannels: [
    { name: "water", size: WaterChannel.allocate().byteLength },
  ],

  provides: [WaterWriterTok, WaterReaderTok],

  sim: {
    create(config, ctx) {
      const writer = new WaterBufferWriter(ctx.buffers.water);
      writer.init(config.patchSize ?? 4);
      return writer;
    },
    // tick is game-specific (calls updateWaterBuffer with Gerstner waves,
    // shore damping, wake sources, etc.) — games wire this via onReady.
  },

  tickPhase: "pre-physics",

  renderer: {
    init(_config, _ctx) {
      // WaterPass is in @downdraft/core, not this library.
      // The game creates the pass in onReady and injects WaterReaderTok.
      return null;
    },
    setBuffers(_instance, buffers) {
      // The reader is created here and provided to the DI graph.
      // Games inject WaterReaderTok in onReady to get it.
      return new WaterBufferReader(buffers.water);
    },
  },

  defaultConfig: {
    patchSize: 4,
    gridSize: 256,
  },
};
