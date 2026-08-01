---
title: Audio
description: Spatial audio system with Kira backend
---

DownDraft provides a pluggable audio system with a Kira backend via Rust FFI.

## AudioEngine

```typescript
import { AudioEngine, createAudioSource } from "@downdraft/core";
import { AudioKiraPlugin } from "@downdraft/plugin-audio-kira";

gameWorld.usePlugin(AudioKiraPlugin);
const source = createAudioSource({ buffer: "explosion.wav", volume: 0.8 });
```

## Spatial Audio

Audio sources have 3D positions. An audio listener follows the camera, enabling distance-based attenuation and spatial panning.

### Audio Source Component

```typescript
import { createAudioSource } from "@downdraft/core";

const source = createAudioSource({
  buffer: "explosion.wav",
  volume: 0.8,
  loop: false,
  spatial: true,
});
```

### Audio Listener

The audio listener tracks the camera position and orientation. Spatial audio is calculated relative to the listener.

## Mixer

The audio mixer supports:

- Multiple channels (master, music, sfx, voice)
- Per-channel volume control
- Effects (reverb, low-pass filter, etc.)

## Backend Interface

The `AudioBackend` interface defines the contract for audio implementations. The default backend is Kira (via Rust FFI in `packages/audio-native`). Alternative backends can be implemented by implementing the interface.

## Supported Formats

- OGG
- MP3
- WAV
