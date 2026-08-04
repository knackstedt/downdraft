import type { AudioBackend, AudioChannel, AudioEffectDesc, AudioEffectType } from "./interface";

export interface MixerChannelState {
  name: AudioChannel;
  volume: number;
  muted: boolean;
  effects: Map<number, AudioEffectDesc>;
}

const DEFAULT_CHANNELS: AudioChannel[] = ["master", "sfx", "music", "voice", "ambient", "ui"];

const DEFAULT_EFFECT_PARAMS: Record<AudioEffectType, Record<string, number>> = {
  reverb: { roomSize: 0.5, decay: 0.5, diffusion: 0.7 },
  lowpass: { cutoff: 1000, resonance: 0.1 },
  highpass: { cutoff: 100, resonance: 0.1 },
  echo: { delay: 0.3, feedback: 0.4, mix: 0.3 },
  distortion: { drive: 0.5, threshold: 0.1 },
  chorus: { rate: 0.5, depth: 0.3, mix: 0.3 },
};

export class AudioMixer {
  private backend: AudioBackend;
  private channels: Map<AudioChannel, MixerChannelState> = new Map();
  private nextEffectId = 1;

  constructor(backend: AudioBackend) {
    this.backend = backend;
    for (const name of DEFAULT_CHANNELS) {
      this.channels.set(name, {
        name,
        volume: name === "master" ? 1.0 : 0.8,
        muted: false,
        effects: new Map(),
      });
      this.backend.setChannelVolume(name, name === "master" ? 1.0 : 0.8);
    }
  }

  setVolume(channel: AudioChannel, volume: number): void {
    const state = this.channels.get(channel);
    if (!state) return;
    state.volume = Math.max(0, Math.min(1, volume));
    this.backend.setChannelVolume(channel, state.volume);
  }

  getVolume(channel: AudioChannel): number {
    return this.channels.get(channel)?.volume ?? 0;
  }

  mute(channel: AudioChannel): void {
    const state = this.channels.get(channel);
    if (!state) return;
    state.muted = true;
    this.backend.setChannelMuted?.(channel, true);
  }

  unmute(channel: AudioChannel): void {
    const state = this.channels.get(channel);
    if (!state) return;
    state.muted = false;
    this.backend.setChannelMuted?.(channel, false);
  }

  isMuted(channel: AudioChannel): boolean {
    return this.channels.get(channel)?.muted ?? false;
  }

  setChannelVolume(channel: AudioChannel, volume: number): void {
    this.setVolume(channel, volume);
  }

  getChannelVolume(channel: AudioChannel): number {
    return this.getVolume(channel);
  }

  setChannelMute(channel: AudioChannel, muted: boolean): void {
    if (muted) this.mute(channel);
    else this.unmute(channel);
  }

  isChannelMuted(channel: AudioChannel): boolean {
    return this.isMuted(channel);
  }

  addEffect(channel: AudioChannel, typeOrEffect: AudioEffectType | AudioEffectDesc, params?: Partial<Record<string, number>>, wet = 1.0, dry = 1.0): number {
    const state = this.channels.get(channel);
    if (!state) return -1;
    let effect: AudioEffectDesc;
    if (typeof typeOrEffect === "object") {
      effect = typeOrEffect;
    } else {
      effect = {
        type: typeOrEffect,
        params: { ...DEFAULT_EFFECT_PARAMS[typeOrEffect], ...params } as Record<string, number>,
        wet,
        dry,
      };
    }
    const id = this.backend.addEffect(channel, effect);
    state.effects.set(id, effect);
    return id;
  }

  removeEffect(channel: AudioChannel, effectId: number): void {
    const state = this.channels.get(channel);
    if (!state) return;
    this.backend.removeEffect(channel, effectId);
    state.effects.delete(effectId);
  }

  updateEffect(channel: AudioChannel, effectId: number, params: Partial<Record<string, number>>): void {
    const state = this.channels.get(channel);
    if (!state) return;
    const effect = state.effects.get(effectId);
    if (!effect) return;
    effect.params = { ...effect.params, ...params } as Record<string, number>;
    this.backend.updateEffect?.(channel, effectId, effect.params);
  }

  getChannelState(channel: AudioChannel): MixerChannelState | undefined {
    return this.channels.get(channel);
  }

  listChannels(): AudioChannel[] {
    return [...this.channels.keys()];
  }

  reset(): void {
    for (const [name, state] of this.channels) {
      state.volume = name === "master" ? 1.0 : 0.8;
      state.muted = false;
      state.effects.clear();
      this.backend.setChannelVolume(name, state.volume);
      this.backend.setChannelMuted?.(name, false);
    }
  }
}
