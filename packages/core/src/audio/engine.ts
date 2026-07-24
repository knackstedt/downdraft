import type {
    AudioBackend,
    AudioBackendConfig,
    AudioBufferDesc,
    AudioListenerState,
    AudioSourceHandle
} from "./interface.ts";
import { DEFAULT_AUDIO_CONFIG } from "./interface.ts";
import { AudioMixer } from "./mixer.ts";

export class AudioEngine {
  private backend: AudioBackend;
  private mixer: AudioMixer | null = null;
  private config: AudioBackendConfig;
  private buffers: Map<string, AudioBufferDesc> = new Map();
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
    if (this.backend.init) await this.backend.init(this.config);
    this.mixer = new AudioMixer(this.backend);
    this.backend.setListener(this.listener);
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  loadBuffer(desc: AudioBufferDesc): void {
    this.backend.loadBuffer(desc);
    this.buffers.set(desc.id, desc);
  }

  unloadBuffer(bufferId: string): void {
    const buffer = this.buffers.get(bufferId);
    if (!buffer) return;
    for (const [id, source] of this.sources) {
      if (source.bufferId === bufferId) {
        this.backend.stop(source);
        this.sources.delete(id);
      }
    }
    this.backend.unloadBuffer(bufferId);
    this.buffers.delete(bufferId);
  }

  getBuffer(bufferId: string): AudioBufferDesc | undefined {
    return this.buffers.get(bufferId) ?? this.backend.getBuffer?.(bufferId);
  }

  play(bufferId: string): AudioSourceHandle {
    const handle = this.backend.play(bufferId);
    const id = handle.id ?? handle.sourceId ?? 0;
    this.sources.set(id, handle);
    return handle;
  }

  stop(handle: AudioSourceHandle): void {
    this.backend.stop(handle);
    const id = handle.id ?? handle.sourceId ?? 0;
    this.sources.delete(id);
  }

  stopAll(): void {
    for (const [, source] of this.sources) {
      this.backend.stop(source);
    }
    this.sources.clear();
  }

  pause(handle: AudioSourceHandle): void {
    this.backend.pause(handle);
    const id = handle.id ?? handle.sourceId ?? 0;
    const source = this.sources.get(id);
    if (source) {
      source.paused = true;
      source.playing = false;
    }
  }

  resume(handle: AudioSourceHandle): void {
    this.backend.resume(handle);
    const id = handle.id ?? handle.sourceId ?? 0;
    const source = this.sources.get(id);
    if (source) {
      source.paused = false;
      source.playing = true;
    }
  }

  seek(sourceId: number, positionSec: number): void {
    this.backend.seek?.(sourceId, positionSec);
  }

  setSourceVolume(sourceId: number, volume: number): void {
    this.backend.setSourceVolume?.(sourceId, volume);
    const source = this.sources.get(sourceId);
    if (source) source.volume = volume;
  }

  setSourcePitch(sourceId: number, pitch: number): void {
    this.backend.setSourcePitch?.(sourceId, pitch);
    const source = this.sources.get(sourceId);
    if (source) source.pitch = pitch;
  }

  setSourcePosition(sourceId: number, pos: [number, number, number]): void {
    this.backend.setSourcePosition?.(sourceId, pos);
    const source = this.sources.get(sourceId);
    if (source) source.position = pos;
  }

  setSourceVelocity(sourceId: number, vel: [number, number, number]): void {
    this.backend.setSourceVelocity?.(sourceId, vel);
    const source = this.sources.get(sourceId);
    if (source) source.velocity = vel;
  }

  setListener(listener: AudioListenerState): void {
    this.listener = listener;
    this.backend.setListener(listener);
  }

  getListener(): AudioListenerState {
    return this.backend.getListener?.() ?? this.listener;
  }

  getMixer(): AudioMixer | null {
    return this.mixer;
  }

  getBackend(): AudioBackend {
    return this.backend;
  }

  getActiveSources(): AudioSourceHandle[] {
    return this.backend.getActiveSources?.() ?? [...this.sources.values()];
  }

  update(dt?: number): void {
    if (!this.initialized) return;
    this.backend.update(dt ?? 0);
    const active = this.backend.getActiveSources?.() ?? [];
    this.sources.clear();
    for (const source of active) {
      const id = source.id ?? source.sourceId ?? 0;
      this.sources.set(id, source);
    }
  }

  syncPositions(positionBuffer: Float32Array, sourceCount: number): void {
    this.backend.syncPositions?.(positionBuffer, sourceCount);
  }

  destroy(): void {
    this.stopAll();
    this.buffers.clear();
    this.mixer = null;
    this.backend.destroy();
    this.initialized = false;
  }
}
