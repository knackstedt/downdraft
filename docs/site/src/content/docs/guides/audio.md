---
title: Audio
description: Spatial audio system with Kira backend
---

DownDraft provides a pluggable audio system with a Kira backend via Rust FFI.

## AudioEngine

```typescript
import { startGame } from "@downdraft/engine/app/renderer";
import { AudioKiraLib, AudioEngineTok } from "@downdraft/engine/libraries/audio-kira";

startGame({
  libraries: [AudioKiraLib],
  // inject the backend via the typed token in onReady:
  onReady: (ctx) => {
    const audio = ctx.inject(AudioEngineTok);
  },
});
```

## Spatial Audio

Audio sources have 3D positions. An audio listener follows the camera, enabling distance-based attenuation and spatial panning.

### Audio Source Component

```typescript
import { createAudioSource } from "@downdraft/engine";

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

The `AudioBackend` interface defines the contract for audio implementations; `AudioEngine` takes any backend at construction. The Kira backend (`KiraAudioBackend`, wired declaratively via `AudioKiraLib`) is a Rust cdylib (`libdowndraft_audio`, crate `downdraft-audio` under `libraries/audio-kira/native`) loaded over FFI when present. Alternative backends can be implemented by implementing the interface.

## Supported Formats

- OGG
- MP3
- WAV
