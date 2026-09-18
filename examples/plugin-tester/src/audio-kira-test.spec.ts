import type { AudioBackendConfig, AudioBufferDesc, AudioListenerState } from "@downdraft/engine";
import { KiraAudioBackend } from "@downdraft/engine/libraries/audio-kira";
import { beforeEach, describe, expect, it } from "bun:test";

// ============================================================================
// Helper: Create Float32Array samples (sine wave)
// ============================================================================

function makeSamples(numSamples: number = 100): Float32Array {
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(i * 0.1);
  }
  return samples;
}

// ============================================================================
// Helper: Create a valid AudioBufferDesc
// ============================================================================

function makeBufferDesc(format: AudioBufferDesc["format"] = "wav", numSamples: number = 100): AudioBufferDesc {
  return {
    id: `test-buf-${Math.random().toString(36).slice(2)}`,
    format,
    sampleRate: 44100,
    channels: 2,
    samples: makeSamples(numSamples),
  };
}

/**
 * Load a buffer into the backend and return the stored descriptor.
 * The backend assigns its own internal ID (string, starting from "1"),
 * so we use getBuffer() to retrieve the stored descriptor after loading.
 * We find the highest-numbered ID (the most recently loaded buffer).
 */
function loadTestBuffer(audio: KiraAudioBackend, format: AudioBufferDesc["format"] = "wav", numSamples: number = 100): AudioBufferDesc {
  const desc = makeBufferDesc(format, numSamples);
  audio.loadBuffer(desc);
  // The backend uses its own internal ID (String(this.nextBufferId++)),
  // not the desc.id we passed. Find the highest-numbered ID (most recent).
  let lastStored: AudioBufferDesc | undefined;
  for (let i = 1; i <= 100; i++) {
    const stored = audio.getBuffer(String(i));
    if (stored) {
      lastStored = stored;
    } else {
      break; // IDs are sequential, stop at first gap
    }
  }
  if (!lastStored) throw new Error("Buffer not found after loadBuffer");
  return lastStored;
}

function makeConfig(): AudioBackendConfig {
  return {
    sampleRate: 44100,
    bufferSize: 1024,
    channels: 2,
    masterVolume: 1.0,
  };
}

// ============================================================================
// KiraAudioBackend Tests (JS fallback mode — no native lib loaded)
// ============================================================================

describe("KiraAudioBackend", () => {
  let audio: KiraAudioBackend;

  beforeEach(() => {
    audio = new KiraAudioBackend();
    // Don't call init() with native lib so we use JS fallback
  });

  describe("Identity", () => {
    it("should have name 'kira'", () => {
      expect(audio.name).toBe("kira");
    });

    it("should have version", () => {
      expect(audio.version).toBe("0.1.0");
    });

    it("should not be initialized before init()", () => {
      expect(audio.isInitialized()).toBe(false);
    });
  });

  describe("Init", () => {
    it("should initialize successfully", async () => {
      await audio.init(makeConfig());
      expect(audio.isInitialized()).toBe(true);
    });

    it("should not re-initialize if already initialized", async () => {
      await audio.init(makeConfig());
      await audio.init(makeConfig());
      expect(audio.isInitialized()).toBe(true);
    });
  });

  describe("Buffer Management", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should load a buffer and return its descriptor", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      expect(buf.id).toBeDefined();
      expect(buf.sampleRate).toBe(44100);
      expect(buf.channels).toBe(2);
      expect(buf.samples.length).toBe(100);
      expect(buf.duration).toBeCloseTo(100 / 44100, 5);
    });

    it("should load multiple buffers with incrementing IDs", () => {
      const buf1 = loadTestBuffer(audio, "wav", 50);
      const buf2 = loadTestBuffer(audio, "ogg", 50);
      expect(buf1.id).not.toBe(buf2.id);
    });

    it("should get a loaded buffer by ID", () => {
      const loaded = loadTestBuffer(audio, "wav", 100);
      const got = audio.getBuffer(loaded.id);
      expect(got).toBeDefined();
      expect(got!.id).toBe(loaded.id);
    });

    it("should return undefined for non-existent buffer", () => {
      expect(audio.getBuffer(999)).toBeUndefined();
    });

    it("should unload a buffer", () => {
      const loaded = loadTestBuffer(audio, "wav", 100);
      audio.unloadBuffer(loaded.id);
      expect(audio.getBuffer(loaded.id)).toBeUndefined();
    });

    it("should handle unloading non-existent buffer gracefully", () => {
      expect(() => audio.unloadBuffer(999)).not.toThrow();
    });
  });

  describe("Playback", () => {
    let bufferId: string;

    beforeEach(async () => {
      await audio.init(makeConfig());
      const buf = loadTestBuffer(audio, "wav", 100);
      bufferId = buf.id;
    });

    it("should play a buffer and return a source handle", () => {
      const handle = audio.play(bufferId);
      expect(handle.sourceId).toBe(1);
      expect(handle.bufferId).toBe(bufferId);
      expect(handle.playing).toBe(true);
      expect(handle.paused).toBe(false);
      expect(handle.volume).toBe(1.0);
      expect(handle.pitch).toBe(1.0);
      expect(handle.spatial).toBe(true);
    });

    it("should throw when playing non-existent buffer", () => {
      expect(() => audio.play(999)).toThrow();
    });

    it("should play with custom options", () => {
      const handle = audio.play(bufferId, {
        volume: 0.5,
        loop: true,
        spatial: false,
        channel: "music",
        position: [1, 2, 3],
      });
      expect(handle.volume).toBe(0.5);
      expect(handle.loop).toBe(true);
      expect(handle.spatial).toBe(false);
      expect(handle.channel).toBe("music");
      expect(handle.position).toEqual([1, 2, 3]);
    });

    it("should stop a playing source", () => {
      const handle = audio.play(bufferId);
      audio.stop(handle.sourceId);
      const state = audio.getSourceState(handle.sourceId);
      expect(state).toBeNull();
    });

    it("should pause a playing source", () => {
      const handle = audio.play(bufferId);
      audio.pause(handle.sourceId);
      const state = audio.getSourceState(handle.sourceId);
      expect(state).not.toBeNull();
      expect(state!.playing).toBe(false);
      expect(state!.paused).toBe(true);
    });

    it("should resume a paused source", () => {
      const handle = audio.play(bufferId);
      audio.pause(handle.sourceId);
      audio.resume(handle.sourceId);
      const state = audio.getSourceState(handle.sourceId);
      expect(state!.playing).toBe(true);
      expect(state!.paused).toBe(false);
    });

    it("should handle stop on non-existent source gracefully", () => {
      expect(() => audio.stop(999)).not.toThrow();
    });

    it("should handle pause on non-existent source gracefully", () => {
      expect(() => audio.pause(999)).not.toThrow();
    });

    it("should handle resume on non-existent source gracefully", () => {
      expect(() => audio.resume(999)).not.toThrow();
    });
  });

  describe("Source Properties", () => {
    let sourceId: number;

    beforeEach(async () => {
      await audio.init(makeConfig());
      const buf = loadTestBuffer(audio, "wav", 100);
      const handle = audio.play(buf.id);
      sourceId = handle.sourceId;
    });

    it("should set and get source volume", () => {
      audio.setSourceVolume(sourceId, 0.3);
      const state = audio.getSourceState(sourceId);
      expect(state!.volume).toBe(0.3);
    });

    it("should set source loop", () => {
      audio.setSourceLoop(sourceId, true);
      const state = audio.getSourceState(sourceId);
      expect(state!.loop).toBe(true);
    });

    it("should set source position", () => {
      audio.setSourcePosition(sourceId, [10, 20, 30]);
      const state = audio.getSourceState(sourceId);
      expect(state!.position).toEqual([10, 20, 30]);
    });

    it("should set source velocity", () => {
      audio.setSourceVelocity(sourceId, [1, 2, 3]);
      const state = audio.getSourceState(sourceId);
      expect(state!.velocity).toEqual([1, 2, 3]);
    });

    it("should set source spatial", () => {
      audio.setSourceSpatial(sourceId, false);
      const state = audio.getSourceState(sourceId);
      expect(state!.spatial).toBe(false);
    });

    it("should set source distance model", () => {
      audio.setSourceDistanceModel(sourceId, 5, 200, 2.0);
      const state = audio.getSourceState(sourceId);
      expect(state!.minDistance).toBe(5);
      expect(state!.maxDistance).toBe(200);
      expect(state!.rolloffFactor).toBe(2.0);
    });

    it("should set source channel", () => {
      audio.setSourceChannel(sourceId, "voice");
      const state = audio.getSourceState(sourceId);
      expect(state!.channel).toBe("voice");
    });

    it("should return null for non-existent source state", () => {
      expect(audio.getSourceState(999)).toBeNull();
    });
  });

  describe("Active Sources", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should list active sources", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      audio.play(buf.id);
      audio.play(buf.id);
      const active = audio.getActiveSources();
      expect(active.length).toBe(2);
    });

    it("should not list stopped sources", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      const h1 = audio.play(buf.id);
      audio.play(buf.id);
      audio.stop(h1.sourceId);
      const active = audio.getActiveSources();
      expect(active.length).toBe(1);
    });
  });

  describe("Listener", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should return default listener state", () => {
      const listener = audio.getListener();
      expect(listener.position).toEqual([0, 0, 0]);
      expect(listener.orientation).toEqual([0, 0, 0, 1]);
      expect(listener.velocity).toEqual([0, 0, 0]);
      expect(listener.gain).toBe(1.0);
    });

    it("should set listener state", () => {
      const newListener: AudioListenerState = {
        position: [10, 20, 30],
        orientation: [0, 1, 0, 0],
        velocity: [1, 0, 0],
        gain: 0.8,
      };
      audio.setListener(newListener);
      const got = audio.getListener();
      expect(got.position).toEqual([10, 20, 30]);
      expect(got.orientation).toEqual([0, 1, 0, 0]);
      expect(got.velocity).toEqual([1, 0, 0]);
      expect(got.gain).toBe(0.8);
    });

    it("should return a shallow copy from getListener", () => {
      const l1 = audio.getListener();
      l1.gain = 999;
      const l2 = audio.getListener();
      expect(l2.gain).toBe(1.0);
    });
  });

  describe("Channel Volume & Mute", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should set channel volume", () => {
      audio.setChannelVolume("sfx", 0.5);
      expect(audio.getChannelVolume("sfx")).toBe(0.5);
    });

    it("should set master volume", () => {
      audio.setChannelVolume("master", 0.7);
      expect(audio.getChannelVolume("master")).toBe(0.7);
    });

    it("should mute a channel", () => {
      audio.setChannelMuted("music", true);
      expect(audio.isChannelMuted("music")).toBe(true);
    });

    it("should unmute a channel", () => {
      audio.setChannelMuted("music", true);
      audio.setChannelMuted("music", false);
      expect(audio.isChannelMuted("music")).toBe(false);
    });

    it("should have channel volumes that are configurable", () => {
      audio.setChannelVolume('sfx', 0.5);
      expect(audio.getChannelVolume('sfx')).toBe(0.5);
      audio.setChannelVolume('music', 0.3);
      expect(audio.getChannelVolume('music')).toBe(0.3);
    });
  });

  describe("Effects", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should return -1 for addEffect (not implemented)", () => {
      const id = audio.addEffect("sfx", { type: "reverb", params: { decay: 0.5 } });
      expect(id).toBe(-1);
    });

    it("should handle removeEffect gracefully", () => {
      expect(() => audio.removeEffect("sfx", 1)).not.toThrow();
    });

    it("should handle updateEffect gracefully", () => {
      expect(() => audio.updateEffect("sfx", 1, { decay: 0.3 })).not.toThrow();
    });
  });

  describe("Update", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should run update without error", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      audio.play(buf.id);
      expect(() => audio.update(0.016)).not.toThrow();
    });
  });

  describe("Position Sync", () => {
    beforeEach(async () => {
      await audio.init(makeConfig());
    });

    it("should sync positions into buffer", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      audio.play(buf.id, { position: [1, 2, 3], spatial: true });
      audio.play(buf.id, { position: [4, 5, 6], spatial: true });
      const posBuffer = new Float32Array(6);
      audio.syncPositions(posBuffer, 2);
      expect(posBuffer[0]).toBe(1);
      expect(posBuffer[1]).toBe(2);
      expect(posBuffer[2]).toBe(3);
      expect(posBuffer[3]).toBe(4);
      expect(posBuffer[4]).toBe(5);
      expect(posBuffer[5]).toBe(6);
    });

    it("should skip non-spatial sources in sync", () => {
      const buf = loadTestBuffer(audio, "wav", 100);
      audio.play(buf.id, { position: [1, 2, 3], spatial: false });
      const posBuffer = new Float32Array(3);
      audio.syncPositions(posBuffer, 1);
      // Non-spatial sources are skipped, buffer remains zeros
      expect(posBuffer[0]).toBe(0);
    });
  });

  describe("Destroy", () => {
    it("should destroy cleanly", async () => {
      await audio.init(makeConfig());
      const buf = loadTestBuffer(audio, "wav", 100);
      audio.play(buf.id);
      expect(() => audio.destroy()).not.toThrow();
    });

    it("should not be initialized after destroy", async () => {
      await audio.init(makeConfig());
      audio.destroy();
      expect(audio.isInitialized()).toBe(false);
    });

    it("should not double-destroy", async () => {
      await audio.init(makeConfig());
      audio.destroy();
      expect(() => audio.destroy()).not.toThrow();
    });
  });
});
