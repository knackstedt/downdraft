import type {
  AudioBackend,
  AudioBackendConfig,
  AudioBufferDesc,
  AudioSourceHandle,
  AudioListenerState,
  AudioChannel,
  AudioEffectDesc,
  AudioFormat,
} from "./interface.ts";
import { DEFAULT_AUDIO_CONFIG } from "./interface.ts";
import { AudioMixer } from "./mixer.ts";

export class AudioEngine {
  private backend: AudioBackend;
  private mixer: AudioMixer | null = null;
  private config: AudioBackendConfig;
  private buffers: Map<number, AudioBufferDesc> = new Map();
  private sources: Map<number, AudioSourceHandle> = new Map();
  private listener: AudioListenerState = {
    position: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    gain: 1.0,
  };
  private initialized = false;

  constructor(backend: AudioBackend, config?: Partial<AudioBackendConfig>) {
    this.backend = backend;
    this.config = { ...DEFAULT_AUDIO_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.backend.init(this.config);
    this.mixer = new AudioMixer(this.backend);
    this.backend.setListener(this.listener);
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async loadBuffer(format: AudioFormat, data: ArrayBuffer): Promise<AudioBufferDesc> {
    const buffer = await this.backend.loadBuffer(format, data);
    this.buffers.set(buffer.id, buffer);
    return buffer;
  }

  unloadBuffer(bufferId: number): void {
    const buffer = this.buffers.get(bufferId);
    if (!buffer) return;
    for (const [sourceId, source] of this.sources) {
      if (source.bufferId === bufferId) {
        this.backend.stop(sourceId);
        this.sources.delete(sourceId);
      }
    }
    this.backend.unloadBuffer(bufferId);
    this.buffers.delete(bufferId);
  }

  getBuffer(bufferId: number): AudioBufferDesc | undefined {
    return this.buffers.get(bufferId) ?? this.backend.getBuffer(bufferId);
  }

  play(bufferId: number, opts?: Partial<AudioSourceHandle>): AudioSourceHandle {
    const handle = this.backend.play(bufferId, opts);
    this.sources.set(handle.sourceId, handle);
    return handle;
  }

  stop(sourceId: number): void {
    this.backend.stop(sourceId);
    this.sources.delete(sourceId);
  }

  stopAll(): void {
    for (const sourceId of this.sources.keys()) {
      this.backend.stop(sourceId);
    }
    this.sources.clear();
  }

  pause(sourceId: number): void {
    this.backend.pause(sourceId);
    const source = this.sources.get(sourceId);
    if (source) {
      source.paused = true;
      source.playing = false;
    }
  }

  resume(sourceId: number): void {
    this.backend.resume(sourceId);
    const source = this.sources.get(sourceId);
    if (source) {
      source.paused = false;
      source.playing = true;
    }
  }

  seek(sourceId: number, positionSec: number): void {
    this.backend.seek(sourceId, positionSec);
  }

  setSourceVolume(sourceId: number, volume: number): void {
    this.backend.setSourceVolume(sourceId, volume);
    const source = this.sources.get(sourceId);
    if (source) source.volume = volume;
  }

  setSourcePitch(sourceId: number, pitch: number): void {
    this.backend.setSourcePitch(sourceId, pitch);
    const source = this.sources.get(sourceId);
    if (source) source.pitch = pitch;
  }

  setSourcePosition(sourceId: number, pos: [number, number, number]): void {
    this.backend.setSourcePosition(sourceId, pos);
    const source = this.sources.get(sourceId);
    if (source) source.position = pos;
  }

  setSourceVelocity(sourceId: number, vel: [number, number, number]): void {
    this.backend.setSourceVelocity(sourceId, vel);
    const source = this.sources.get(sourceId);
    if (source) source.velocity = vel;
  }

  setListener(listener: AudioListenerState): void {
    this.listener = listener;
    this.backend.setListener(listener);
  }

  getListener(): AudioListenerState {
    return this.backend.getListener();
  }

  getMixer(): AudioMixer | null {
    return this.mixer;
  }

  getBackend(): AudioBackend {
    return this.backend;
  }

  getActiveSources(): AudioSourceHandle[] {
    return this.backend.getActiveSources();
  }

  update(dt: number): void {
    if (!this.initialized) return;
    this.backend.update(dt);
    const active = this.backend.getActiveSources();
    this.sources.clear();
    for (const source of active) {
      this.sources.set(source.sourceId, source);
    }
  }

  syncPositions(positionBuffer: Float32Array, sourceCount: number): void {
    this.backend.syncPositions(positionBuffer, sourceCount);
  }

  destroy(): void {
    this.stopAll();
    this.buffers.clear();
    this.mixer = null;
    this.backend.destroy();
    this.initialized = false;
  }
}
