import type {
    AudioBackend,
    AudioBackendConfig,
    AudioBufferDesc,
    AudioChannel,
    AudioEffectDesc,
    AudioFormat,
    AudioListenerState,
    AudioSourceHandle,
} from "@downdraft/engine";
import { createLogger } from "@downdraft/engine";
import { findPackageRoot } from "@downdraft/engine/platform/pkg-root";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger();

/**
 * Native audio library interface — implemented by libdowndraft_audio
 * (the audio-kira Rust crate, loaded via bun:ffi through the
 * platform-native resolver). When the cdylib is absent the backend runs
 * in JS mode; init/decode errors fall back the same way.
 */
interface AudioLib {
  init(sampleRate: number, bufferSize: number): number;
  destroy(): number;
  loadBuffer(data: Uint8Array, format: number): number;
  unloadBuffer(bufferId: number): number;
  play(bufferId: number, loop: number, volume: number): number;
  stop(soundId: number): number;
  pause(soundId: number): number;
  resume(soundId: number): number;
  setVolume(soundId: number, volume: number): number;
  setMasterVolume(volume: number): number;
  update(): number;
  isPlaying(soundId: number): number;
}

let audioLoadAttempted = false;

async function loadAudioLib(): Promise<AudioLib | null> {
  if (audioLoadAttempted) return null;
  audioLoadAttempted = true;
  try {
    const { dlopen, ptr, resolveNativeLibrary } = await import("@downdraft/platform-native");
    const libPath = resolveNativeLibrary("downdraft_audio", {
      envVars: ["AUDIO_NATIVE_PATH"],
      crateDir: join(findPackageRoot(dirname(fileURLToPath(import.meta.url))), "libraries", "audio-kira", "native"),
      buildHint: 'run "bun run build:native" from the repo root',
      optional: true,
    });
    if (!libPath) {
      log.info("audio-kira", "Using JS audio backend (no native library available).");
      return null;
    }
    const s = dlopen(libPath, {
      dd_audio_init: { args: ["i32", "i32"], returns: "i32" },
      dd_audio_destroy: { args: [], returns: "i32" },
      dd_audio_load_buffer: { args: ["ptr", "u64", "i32"], returns: "i32" },
      dd_audio_unload_buffer: { args: ["i32"], returns: "i32" },
      dd_audio_play: { args: ["i32", "i32", "f32"], returns: "i32" },
      dd_audio_stop: { args: ["i32"], returns: "i32" },
      dd_audio_pause: { args: ["i32"], returns: "i32" },
      dd_audio_resume: { args: ["i32"], returns: "i32" },
      dd_audio_set_volume: { args: ["i32", "f32"], returns: "i32" },
      dd_audio_set_master_volume: { args: ["f32"], returns: "i32" },
      dd_audio_update: { args: [], returns: "i32" },
      dd_audio_is_playing: { args: ["i32"], returns: "i32" },
    }).symbols;
    log.info("audio-kira", `Native audio backend: ${libPath}`);
    return {
      init: (sr, bs) => s.dd_audio_init(sr, bs),
      destroy: () => s.dd_audio_destroy(),
      // from_cursor copies the bytes — safe to hand over a transient view.
      loadBuffer: (data, format) => s.dd_audio_load_buffer(ptr(data), data.byteLength, format),
      unloadBuffer: (id) => s.dd_audio_unload_buffer(id),
      play: (b, loop, vol) => s.dd_audio_play(b, loop, vol),
      stop: (id) => s.dd_audio_stop(id),
      pause: (id) => s.dd_audio_pause(id),
      resume: (id) => s.dd_audio_resume(id),
      setVolume: (id, v) => s.dd_audio_set_volume(id, v),
      setMasterVolume: (v) => s.dd_audio_set_master_volume(v),
      update: () => s.dd_audio_update(),
      isPlaying: (id) => s.dd_audio_is_playing(id),
    };
  } catch (e) {
    log.info("audio-kira", `Native audio unavailable (${e}) — using JS backend.`);
    return null;
  }
}

interface InternalSource {
  handle: AudioSourceHandle;
  nativeSoundId: number;
}

const FORMAT_MAP: Record<AudioFormat, number> = {
  wav: 0,
  ogg: 1,
  mp3: 2,
  flac: 3,
};

const CHANNEL_VOLUMES: Record<AudioChannel, number> = {
  master: 1.0,
  sfx: 0.8,
  music: 0.7,
  voice: 0.9,
  ambient: 0.6,
  ui: 0.8,
};

const CHANNEL_MUTED: Record<AudioChannel, boolean> = {
  master: false,
  sfx: false,
  music: false,
  voice: false,
  ambient: false,
  ui: false,
};

export class KiraAudioBackend implements AudioBackend {
  readonly name = "kira";
  readonly version = "0.1.0";

  private lib: AudioLib | null = null;
  private buffers: Map<string, AudioBufferDesc> = new Map();
  private sources: Map<number, InternalSource> = new Map();
  private listener: AudioListenerState = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    gain: 1.0,
  };
  private nextBufferId = 1;
  private nextSourceId = 1;
  private initialized = false;
  private destroyed = false;

  async init(config: AudioBackendConfig): Promise<void> {
    if (this.initialized) return;
    this.lib = await loadAudioLib();

    if (this.lib) {
      const result = this.lib.init(config.sampleRate, config.bufferSize);
      if (result !== 0) {
        log.warn("audio-kira", "Native init failed, falling back to JS mode");
        this.lib = null;
      }
    }

    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  loadBuffer(desc: AudioBufferDesc): void {
    const id = String(this.nextBufferId++);
    const data = desc.samples.buffer;
    const format = typeof desc.format === "string" ? desc.format : "wav";
    const samples = desc.samples;

    let nativeBufferId = -1;
    if (this.lib) {
      const result = this.lib.loadBuffer(new Uint8Array(data), FORMAT_MAP[format as AudioFormat] ?? 0);
      if (result > 0) {
        nativeBufferId = result;
      }
    }

    const buffer: AudioBufferDesc = {
      id,
      format,
      sampleRate: desc.sampleRate ?? 44100,
      channels: desc.channels ?? 2,
      samples,
      duration: samples.length / (desc.sampleRate ?? 44100),
    };

    (buffer as unknown as { _nativeId?: number })._nativeId = nativeBufferId;
    this.buffers.set(id, buffer);
  }

  unloadBuffer(bufferId: string | number): void {
    const buffer = this.buffers.get(String(bufferId));
    if (!buffer) return;
    if (this.lib) {
      const nativeId = (buffer as unknown as { _nativeId?: number })._nativeId;
      if (nativeId && nativeId > 0) {
        this.lib.unloadBuffer(nativeId);
      }
    }
    this.buffers.delete(String(bufferId));
  }

  getBuffer(bufferId: string | number): AudioBufferDesc | undefined {
    return this.buffers.get(String(bufferId));
  }

  play(bufferId: string | number, opts?: Partial<AudioSourceHandle>): AudioSourceHandle {
    const buffer = this.buffers.get(String(bufferId));
    if (!buffer) throw new Error(`Audio buffer ${bufferId} not found`);

    const sourceId = this.nextSourceId++;
    const handle: AudioSourceHandle = {
      sourceId,
      bufferId,
      playing: true,
      paused: false,
      loop: opts?.loop ?? false,
      volume: opts?.volume ?? 1.0,
      pitch: opts?.pitch ?? 1.0,
      pan: opts?.pan ?? 0.0,
      spatial: opts?.spatial ?? true,
      position: opts?.position ?? [0, 0, 0],
      velocity: opts?.velocity ?? [0, 0, 0],
      minDistance: opts?.minDistance ?? 1.0,
      maxDistance: opts?.maxDistance ?? 100.0,
      rolloffFactor: opts?.rolloffFactor ?? 1.0,
      channel: opts?.channel ?? "sfx",
    };

    let nativeSoundId = -1;
    if (this.lib) {
      const nativeBufferId = (buffer as unknown as { _nativeId?: number })._nativeId;
      if (nativeBufferId && nativeBufferId > 0) {
        const channelVol = CHANNEL_VOLUMES[handle.channel ?? "master"] ?? 1.0;
        const effectiveVol = (handle.volume ?? 1.0) * channelVol;
        nativeSoundId = this.lib.play(nativeBufferId, handle.loop ? 1 : 0, effectiveVol);
        if (nativeSoundId > 0 && (handle.volume ?? 1.0) !== effectiveVol) {
          this.lib.setVolume(nativeSoundId, effectiveVol);
        }
      }
    }

    this.sources.set(sourceId, { handle, nativeSoundId });
    return handle;
  }

  stop(sourceId: number | AudioSourceHandle): void {
    const id = typeof sourceId === "number" ? sourceId : sourceId.sourceId ?? -1;
    const source = this.sources.get(id);
    if (!source) return;
    if (this.lib && source.nativeSoundId > 0) {
      this.lib.stop(source.nativeSoundId);
    }
    source.handle.playing = false;
    this.sources.delete(id);
  }

  pause(sourceId?: number | AudioSourceHandle): void {
    if (sourceId === undefined) return;
    const id = typeof sourceId === "number" ? sourceId : sourceId.sourceId ?? -1;
    const source = this.sources.get(id);
    if (!source) return;
    if (this.lib && source.nativeSoundId > 0) {
      this.lib.pause(source.nativeSoundId);
    }
    source.handle.playing = false;
    source.handle.paused = true;
  }

  resume(sourceId?: number | AudioSourceHandle): void {
    if (sourceId === undefined) return;
    const id = typeof sourceId === "number" ? sourceId : sourceId.sourceId ?? -1;
    const source = this.sources.get(id);
    if (!source) return;
    if (this.lib && source.nativeSoundId > 0) {
      this.lib.resume(source.nativeSoundId);
    }
    source.handle.playing = true;
    source.handle.paused = false;
  }

  seek(sourceId: number, _positionSec: number): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
  }

  setSourceVolume(sourceId: number, volume: number): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.volume = volume;
    if (this.lib && source.nativeSoundId > 0) {
      const channelVol = CHANNEL_VOLUMES[source.handle.channel ?? "master"] ?? 1.0;
      this.lib.setVolume(source.nativeSoundId, volume * channelVol);
    }
  }

  setSourcePitch(_sourceId: number, _pitch: number): void {
  }

  setSourcePan(_sourceId: number, _pan: number): void {
  }

  setSourceLoop(sourceId: number, loop: boolean): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.loop = loop;
  }

  setSourcePosition(sourceId: number, pos: [number, number, number]): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.position = pos;
  }

  setSourceVelocity(sourceId: number, vel: [number, number, number]): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.velocity = vel;
  }

  setSourceSpatial(sourceId: number, spatial: boolean): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.spatial = spatial;
  }

  setSourceDistanceModel(sourceId: number, minDist: number, maxDist: number, rolloff: number): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.minDistance = minDist;
    source.handle.maxDistance = maxDist;
    source.handle.rolloffFactor = rolloff;
  }

  setSourceChannel(sourceId: number, channel: AudioChannel): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    source.handle.channel = channel;
    if (this.lib && source.nativeSoundId > 0) {
      const channelVol = CHANNEL_VOLUMES[channel] ?? 1.0;
      this.lib.setVolume(source.nativeSoundId, (source.handle.volume ?? 1.0) * channelVol);
    }
  }

  getSourceState(sourceId: number): AudioSourceHandle | null {
    const source = this.sources.get(sourceId);
    if (!source) return null;

    if (this.lib && source.nativeSoundId > 0) {
      const playing = this.lib.isPlaying(source.nativeSoundId);
      if (playing === 0 && source.handle.playing) {
        source.handle.playing = false;
      }
    }

    return { ...source.handle };
  }

  getActiveSources(): AudioSourceHandle[] {
    const active: AudioSourceHandle[] = [];
    for (const [sourceId, source] of this.sources.entries()) {
      if (this.lib && source.nativeSoundId > 0) {
        const playing = this.lib.isPlaying(source.nativeSoundId);
        if (playing === 0) {
          source.handle.playing = false;
          this.sources.delete(sourceId);
          continue;
        }
      }
      active.push({ ...source.handle });
    }
    return active;
  }

  setListener(listener: AudioListenerState): void {
    this.listener = { ...listener };
  }

  getListener(): AudioListenerState {
    return { ...this.listener };
  }

  setChannelVolume(channel: AudioChannel, volume: number): void {
    CHANNEL_VOLUMES[channel] = volume;
    if (channel === "master" && this.lib) {
      this.lib.setMasterVolume(volume);
    }
    for (const [, source] of this.sources.entries()) {
      if (source.handle.channel === channel && this.lib && source.nativeSoundId > 0) {
        this.lib.setVolume(source.nativeSoundId, (source.handle.volume ?? 1.0) * volume);
      }
    }
  }

  setChannelMuted(channel: AudioChannel, muted: boolean): void {
    CHANNEL_MUTED[channel] = muted;
    for (const [, source] of this.sources.entries()) {
      if (source.handle.channel === channel && this.lib && source.nativeSoundId > 0) {
        this.lib.setVolume(source.nativeSoundId, muted ? 0 : (source.handle.volume ?? 1.0) * CHANNEL_VOLUMES[channel]);
      }
    }
  }

  getChannelVolume(channel: AudioChannel): number {
    return CHANNEL_VOLUMES[channel] ?? 1.0;
  }

  isChannelMuted(channel: AudioChannel): boolean {
    return CHANNEL_MUTED[channel] ?? false;
  }

  addEffect(_channel: AudioChannel, _effect: AudioEffectDesc): number {
    return -1;
  }

  removeEffect(_channel: AudioChannel, _effectId: number): void {
  }

  updateEffect(_channel: AudioChannel, _effectId: number, _params: Record<string, number>): void {
  }

  update(_dt: number): void {
    if (this.lib) {
      this.lib.update();
    }
    for (const [sourceId, source] of this.sources.entries()) {
      if (this.lib && source.nativeSoundId > 0) {
        const playing = this.lib.isPlaying(source.nativeSoundId);
        if (playing === 0) {
          source.handle.playing = false;
          this.sources.delete(sourceId);
        }
      }
    }
  }

  syncPositions(positionBuffer: Float32Array, sourceCount: number): void {
    let idx = 0;
    for (const [, source] of this.sources.entries()) {
      if (idx >= sourceCount) break;
      if (!source.handle.spatial) continue;
      const offset = idx * 3;
      if (offset + 2 < positionBuffer.length) {
        positionBuffer[offset] = source.handle.position?.[0] ?? 0;
        positionBuffer[offset + 1] = source.handle.position?.[1] ?? 0;
        positionBuffer[offset + 2] = source.handle.position?.[2] ?? 0;
      }
      idx++;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [, source] of this.sources.entries()) {
      if (this.lib && source.nativeSoundId > 0) {
        this.lib.stop(source.nativeSoundId);
      }
    }
    this.sources.clear();
    for (const buffer of this.buffers.values()) {
      if (this.lib) {
        const nativeId = (buffer as unknown as { _nativeId?: number })._nativeId;
        if (nativeId && nativeId > 0) {
          this.lib.unloadBuffer(nativeId);
        }
      }
    }
    this.buffers.clear();
    if (this.lib) {
      this.lib.destroy();
    }
    this.initialized = false;
  }
}
