import { Component } from "../ecs/component";
import type { AudioListenerState } from "./interface";

export interface AudioListenerData {
  [key: string]: unknown;
  position: [number, number, number];
  orientation: [number, number, number, number];
  velocity: [number, number, number];
  gain: number;
  active: boolean;
}

export const AudioListener = Component.register<AudioListenerData>("AudioListener", {
  position: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  velocity: [0, 0, 0],
  gain: 1.0,
  active: true,
});

export function createAudioListener(opts?: Partial<AudioListenerData>): AudioListenerData {
  return AudioListener.create(opts);
}

export function listenerToState(data: AudioListenerData): AudioListenerState {
  return {
    position: data.position,
    orientation: data.orientation,
    velocity: data.velocity,
    gain: data.gain,
  }
}
