export type AudioFormat = "wav" | "ogg" | "mp3" | "flac";

export type AudioChannel = "master" | "sfx" | "music" | "voice" | "ambient" | "ui";

export interface AudioBufferFormat {
  sampleRate: number;
  channels: number;
  sampleFormat: string;
}

export interface AudioBufferDesc {
  id: string;
  format: AudioBufferFormat | AudioFormat;
  sampleRate?: number;
  channels?: number;
  samples: Float32Array;
  duration?: number;
}

export interface AudioSourceHandle {
  id?: number;
  sourceId?: number;
  bufferId: string | number;
  playing?: boolean;
  paused?: boolean;
  loop?: boolean;
  volume?: number;
  pitch?: number;
  pan?: number;
  spatial?: boolean;
  position?: [number, number, number];
  velocity?: [number, number, number];
  minDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  channel?: AudioChannel;
}

export interface AudioListenerState {
  position: [number, number, number];
  orientation: [number, number, number] | [number, number, number, number];
  up?: [number, number, number];
  velocity?: [number, number, number];
  gain?: number;
}

export type AudioEffectType = "reverb" | "lowpass" | "highpass" | "echo" | "distortion" | "chorus";

export interface AudioEffectDesc {
  type: AudioEffectType;
  params: Record<string, number>;
  wet?: number;
  dry?: number;
}

export interface AudioChannelConfig {
  name: AudioChannel;
  volume: number;
  muted: boolean;
  effects: AudioEffectDesc[];
}

export interface AudioBackendConfig {
  sampleRate: number;
  bufferSize: number;
  channels: number;
  spatialEnabled: boolean;
  maxSources: number;
  speedOfSound: number;
}

export const DEFAULT_AUDIO_CONFIG: AudioBackendConfig = {
  sampleRate: 44100,
  bufferSize: 1024,
  channels: 2,
  spatialEnabled: true,
  maxSources: 64,
  speedOfSound: 343.3,
};

export interface AudioBackend {
  readonly name: string;
  readonly version: string;

  init(config: AudioBackendConfig): Promise<void>;
  isInitialized(): boolean;

  loadBuffer(desc: AudioBufferDesc): void;
  unloadBuffer(bufferId: string | number): void;
  getBuffer?(bufferId: string | number): AudioBufferDesc | undefined;

  play(bufferId: string | number, opts?: Partial<AudioSourceHandle>): AudioSourceHandle;
  stop(sourceId: number | AudioSourceHandle): void;
  pause(sourceId?: number | AudioSourceHandle): void;
  resume(sourceId?: number | AudioSourceHandle): void;
  seek?(sourceId: number, positionSec: number): void;

  setSourceVolume?(sourceId: number, volume: number): void;
  setSourcePitch?(sourceId: number, pitch: number): void;
  setSourcePan?(sourceId: number, pan: number): void;
  setSourceLoop?(sourceId: number, loop: boolean): void;
  setSourcePosition?(sourceId: number, pos: [number, number, number]): void;
  setSourceVelocity?(sourceId: number, vel: [number, number, number]): void;
  setSourceSpatial?(sourceId: number, spatial: boolean): void;
  setSourceDistanceModel?(sourceId: number, minDist: number, maxDist: number, rolloff: number): void;
  setSourceChannel?(sourceId: number, channel: AudioChannel): void;

  getSourceState?(sourceId: number): AudioSourceHandle | null;
  getActiveSources?(): AudioSourceHandle[];

  setListener(listener: AudioListenerState): void;
  getListener?(): AudioListenerState;

  setChannelVolume(channel: AudioChannel, volume: number): void;
  setChannelMute?(channel: AudioChannel, muted: boolean): void;
  setChannelMuted?(channel: AudioChannel, muted: boolean): void;
  getChannelVolume(channel: AudioChannel): number;
  isChannelMuted(channel: AudioChannel): boolean;

  addEffect(channel: AudioChannel, effect: AudioEffectDesc): number;
  removeEffect(channel: AudioChannel, effectId: number): void;
  updateEffect?(channel: AudioChannel, effectId: number, params: Record<string, number>): void;

  update(dt?: number): void;
  syncPositions?(positionBuffer: Float32Array, sourceCount: number): void;

  init?(config: AudioBackendConfig): Promise<void>;
  isInitialized?(): boolean;
  setVolume?(): void;
  setMasterVolume?(v: number): void;
  getMasterVolume?(): number;
  setPitch?(): void;
  isPlaying?(): boolean;

  destroy(): void;
}
