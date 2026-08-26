import { describe, expect, it } from "bun:test";
import {
  MAX_SHORES,
  MAX_WAKES,
  SHORE_FLOATS,
  WAKE_FLOATS,
  collectShoreSources,
  collectWakeSources,
  packShoreSources,
} from "./wave-sources";

describe("collectWakeSources", () => {
  it("caps at MAX_WAKES", () => {
    const providers = Array.from({ length: MAX_WAKES + 10 }, () => ({
      x: 0, z: 0, heading: 0, speed: 1,
    }));
    const out = new Float32Array(MAX_WAKES * WAKE_FLOATS);
    const count = collectWakeSources(providers, out);
    expect(count).toBe(MAX_WAKES);
  });

  it("caps at output buffer capacity", () => {
    const providers = Array.from({ length: 5 }, () => ({
      x: 0, z: 0, heading: 0, speed: 1,
    }));
    const out = new Float32Array(2 * WAKE_FLOATS);
    const count = collectWakeSources(providers, out);
    expect(count).toBe(2);
  });
});

describe("collectShoreSources", () => {
  it("caps at MAX_SHORES", () => {
    const providers = Array.from({ length: MAX_SHORES + 10 }, () => ({
      x: 0, z: 0, radius: 1,
    }));
    const out = Array.from({ length: MAX_SHORES }, () => ({
      x: 0, z: 0, radius: 0, cutoutRadius: 0,
    }));
    const count = collectShoreSources(providers, out);
    expect(count).toBe(MAX_SHORES);
  });

  it("caps at output array length", () => {
    const providers = Array.from({ length: 10 }, () => ({
      x: 0, z: 0, radius: 1,
    }));
    const out = Array.from({ length: 3 }, () => ({
      x: 0, z: 0, radius: 0, cutoutRadius: 0,
    }));
    const count = collectShoreSources(providers, out);
    expect(count).toBe(3);
  });
});

describe("packShoreSources", () => {
  it("does not write beyond output buffer", () => {
    const sources = Array.from({ length: MAX_SHORES + 10 }, () => ({
      x: 1, z: 2, radius: 3, cutoutRadius: 4,
    }));
    const out = new Float32Array(MAX_SHORES * SHORE_FLOATS);
    expect(() => packShoreSources(sources, sources.length, out)).not.toThrow();
  });
});
