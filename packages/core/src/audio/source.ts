import { Component } from "../ecs/component.ts";
import type { AudioChannel } from "./interface.ts";

export interface AudioSourceData {
  [key: string]: unknown;
  bufferId: number;
  playing: boolean;
  paused: boolean;
  loop: boolean;
  volume: number;
  pitch: number;
  pan: number;
  spatial: boolean;
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
  bufferId: -1,
  playing: false,
  paused: false,
  loop: false,
  volume: 1.0,
  pitch: 1.0,
  pan: 0.0,
  spatial: true,
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  minDistance: 1.0,
  maxDistance: 100.0,
  rolloffFactor: 1.0,
  channel: "sfx",
  sourceId: -1,
  autoPlay: false,
});

export function createAudioSource(bufferId: number, opts?: Partial<AudioSourceData>): AudioSourceData {
  return AudioSource.create({ bufferId, ...opts });
}

export function createSpatialAudioSource(
  bufferId: number,
  position: [number, number, number],
  opts?: Partial<AudioSourceData>,
): AudioSourceData {
  return AudioSource.create({
    bufferId,
    spatial: true,
    position,
    ...opts,
  });
}

export function createAmbientAudioSource(
  bufferId: number,
  opts?: Partial<AudioSourceData>,
): AudioSourceData {
  return AudioSource.create({
    bufferId,
    spatial: false,
    channel: "ambient",
    loop: true,
    ...opts,
  });
}
