import { Component } from "../ecs/component.ts";
import type { AudioChannel } from "./interface.ts";

export interface AudioSourceData {
  [key: string]: unknown;
  bufferId: string;
  playing: boolean;
  paused: boolean;
  loop: boolean;
  looping: boolean;
  volume: number;
  pitch: number;
  pan: number;
  spatial: boolean;
  spatialized: boolean;
  position: [number, number, number];
  velocity: [number, number, number];
  minDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  channel: AudioChannel;
  sourceId: number;
  autoPlay: boolean;
}

export const AudioSource = Component.register<AudioSourceData>("AudioSource", {
  bufferId: "",
  playing: false,
  paused: false,
  loop: false,
  looping: false,
  volume: 1.0,
  pitch: 1.0,
  pan: 0.0,
  spatial: false,
  spatialized: false,
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  minDistance: 1.0,
  maxDistance: 100.0,
  rolloffFactor: 1.0,
  channel: "master",
  sourceId: -1,
  autoPlay: false,
});

export function createAudioSource(bufferId: string, opts?: Partial<AudioSourceData>): AudioSourceData {
  return AudioSource.create({ bufferId, spatialized: false, spatial: false, looping: opts?.loop ?? false, ...opts });
}

export function createSpatialAudioSource(bufferId: string, opts?: Partial<AudioSourceData>): AudioSourceData {
  return AudioSource.create({
    bufferId,
    position: opts?.position ?? [0, 0, 0],
    maxDistance: opts?.maxDistance ?? 100,
    ...opts,
    spatialized: true,
    spatial: true,
  });
}

export function createAmbientAudioSource(bufferId: string, opts?: Partial<AudioSourceData>): AudioSourceData {
  return AudioSource.create({
    bufferId,
    channel: "ambient",
    ...opts,
    spatialized: false,
    spatial: false,
    looping: opts?.looping ?? true,
    loop: opts?.loop ?? true,
  });
}
