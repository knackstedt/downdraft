// ============================================================================
// AudioKiraLib — declarative engine library descriptor for @downdraft/library-audio-kira
//
// Games declare `libraries: [AudioKiraLib]` (or with config override) in their
// GameModule. The host creates the KiraAudioBackend (sim-side only — audio is
// simulated on the sim thread and mixed there) and exposes it via the
// AudioEngineTok typed token.
//
// Games that need full control can still import KiraAudioBackend directly
// (escape hatch).
// ============================================================================

import { resourceToken, type EngineLibrary } from "@downdraft/core";
import { KiraAudioBackend } from "./backend";

// ── Config ──

export interface AudioKiraLibConfig {
  /** Sample rate in Hz. Default: 44100. */
  sampleRate?: number;
  /** Audio buffer size (frames). Default: 1024. */
  bufferSize?: number;
  /** Number of output channels. Default: 2. */
  channels?: number;
  /** Enable spatial (3D positional) audio. Default: true. */
  spatialEnabled?: boolean;
  /** Maximum concurrent audio sources. Default: 256. */
  maxSources?: number;
  /** Speed of sound (m/s) for spatial doppler/hrtf. Default: 343. */
  speedOfSound?: number;
}

// ── Typed tokens (DI) ──

/** Token for the sim-side audio backend. Inject in sim systems that play audio. */
export const AudioEngineTok = resourceToken<KiraAudioBackend>("audio:engine");

// ── Descriptor ──

export const AudioKiraLib: EngineLibrary<AudioKiraLibConfig> = {
  name: "audio-kira",
  version: "1.0.0",

  // No SAB channels — audio is sim-only; the backend mixes in-process.
  sabChannels: [],

  provides: [AudioEngineTok],

  sim: {
    async create(config, ctx) {
      const backend = new KiraAudioBackend();
      await backend.init({
        sampleRate: config.sampleRate ?? 44100,
        bufferSize: config.bufferSize ?? 1024,
        channels: config.channels ?? 2,
        spatialEnabled: config.spatialEnabled ?? true,
        maxSources: config.maxSources ?? 256,
        speedOfSound: config.speedOfSound ?? 343,
      });
      ctx.provide(AudioEngineTok, backend);
      return backend;
    },
    dispose(backend) {
      (backend as KiraAudioBackend).destroy();
    },
    // tick is game-specific (calls backend.update(dt), syncs listener/source
    // positions, etc.) — games wire this via onReady or a sim system.
  },

  tickPhase: "post-physics",

  // No renderer setup — audio is entirely sim-side.

  defaultConfig: {
    sampleRate: 44100,
    bufferSize: 1024,
    channels: 2,
    spatialEnabled: true,
    maxSources: 256,
    speedOfSound: 343,
  },
};
