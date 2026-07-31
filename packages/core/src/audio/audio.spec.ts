import { AudioEngine } from "./engine.ts";
import type { AudioBackend, AudioBufferDesc, AudioEffectDesc, AudioSourceHandle } from "./interface.ts";
import { AudioMixer } from "./mixer.ts";
import { createAmbientAudioSource, createAudioSource, createSpatialAudioSource } from "./source.ts";

function makeMockBackend(): AudioBackend {
  const buffers = new Map<string, AudioBufferDesc>();
  const sources = new Map<number, AudioSourceHandle>();
  let nextSourceId = 0;
  let masterVolume = 1;

  return {
    name: "mock",
    version: "1.0.0",
    init: () => {},
    destroy: () => {},
    loadBuffer: (desc: AudioBufferDesc) => { buffers.set(desc.id, desc); },
    unloadBuffer: (id: string) => { buffers.delete(id); },
    play: (bufferId: string) => { const h: AudioSourceHandle = { id: ++nextSourceId, bufferId }; sources.set(h.id, h); return h; },
    stop: (h: AudioSourceHandle) => { sources.delete(h.id); },
    pause: () => {},
    resume: () => {},
    setMasterVolume: (v: number) => { masterVolume = v; },
    getMasterVolume: () => masterVolume,
    setListener: () => {},
    setSourcePosition: () => {},
    setSourceVelocity: () => {},
    update: () => {},
    addEffect: () => {},
    removeEffect: () => {},
    setChannelVolume: () => {},
    setChannelMuted: () => {},
    getChannelVolume: () => 1,
    isChannelMuted: () => false,
  };
}

describe("AudioSource", () => {
  it("should create a default audio source", () => {
    const src = createAudioSource("bgm");
    expect(src.bufferId).toBe("bgm");
    expect(src.volume).toBe(1);
    expect(src.pitch).toBe(1);
    expect(src.spatialized).toBe(false);
    expect(src.channel).toBe("master");
  });

  it("createSpatialAudioSource should have spatial properties", () => {
    const src = createSpatialAudioSource("sfx");
    expect(src.bufferId).toBe("sfx");
    expect(src.spatialized).toBe(true);
    expect(src.position).toBeDefined();
    expect(src.maxDistance).toBeGreaterThan(0);
  });

  it("createAmbientAudioSource should not be spatialized", () => {
    const src = createAmbientAudioSource("ambient");
    expect(src.bufferId).toBe("ambient");
    expect(src.spatialized).toBe(false);
    expect(src.looping).toBe(true);
  });
});

describe("AudioMixer", () => {
  it("should construct with a backend", () => {
    const backend = makeMockBackend();
    const mixer = new AudioMixer(backend);
    expect(mixer).toBeDefined();
  });

  it("should set channel volume", () => {
    const backend = makeMockBackend();
    const mixer = new AudioMixer(backend);
    expect(() => mixer.setChannelVolume("master", 0.5)).not.toThrow();
  });

  it("should mute and unmute channels", () => {
    const backend = makeMockBackend();
    const mixer = new AudioMixer(backend);
    mixer.setChannelMute("sfx", true);
    expect(mixer.isChannelMuted("sfx")).toBe(true);
    mixer.setChannelMute("sfx", false);
    expect(mixer.isChannelMuted("sfx")).toBe(false);
  });

  it("should add and remove effects", () => {
    const backend = makeMockBackend();
    const mixer = new AudioMixer(backend);
    const effect: AudioEffectDesc = { type: "reverb", params: { decay: 2.0 } };
    mixer.addEffect("master", effect);
    mixer.removeEffect("master", 0);
  });
});

describe("AudioEngine", () => {
  it("should construct with a backend", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    expect(engine).toBeDefined();
  });

  it("should load and unload buffers", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    const desc: AudioBufferDesc = { id: "test", format: { sampleRate: 44100, channels: 2, sampleFormat: "f32" }, samples: new Float32Array(100) };
    engine.loadBuffer(desc);
    engine.unloadBuffer("test");
  });

  it("should play a source", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    const desc: AudioBufferDesc = { id: "test", format: { sampleRate: 44100, channels: 2, sampleFormat: "f32" }, samples: new Float32Array(100) };
    engine.loadBuffer(desc);
    const handle = engine.play("test");
    expect(handle).toBeDefined();
    expect(handle.id).toBeGreaterThan(0);
  });

  it("should stop a source", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    const desc: AudioBufferDesc = { id: "test", format: { sampleRate: 44100, channels: 2, sampleFormat: "f32" }, samples: new Float32Array(100) };
    engine.loadBuffer(desc);
    const handle = engine.play("test");
    expect(() => engine.stop(handle)).not.toThrow();
  });

  it("should pause and resume", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    const desc: AudioBufferDesc = { id: "test", format: { sampleRate: 44100, channels: 2, sampleFormat: "f32" }, samples: new Float32Array(100) };
    engine.loadBuffer(desc);
    const handle = engine.play("test");
    expect(() => engine.pause(handle)).not.toThrow();
    expect(() => engine.resume(handle)).not.toThrow();
  });

  it("should update without error", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    expect(() => engine.update()).not.toThrow();
  });

  it("should set listener position", () => {
    const backend = makeMockBackend();
    const engine = new AudioEngine(backend);
    expect(() => engine.setListener({ position: [0, 0, 0], orientation: [0, 0, -1], up: [0, 1, 0] })).not.toThrow();
  });
});
