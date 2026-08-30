// Specs for the bake config resolution.
import { describe, it, expect } from "bun:test";
import { resolveOptions, DEFAULT_BAKE_OPTIONS, BAKE_CONFIG_VERSION } from "./config";

describe("resolveOptions", () => {
  it("returns a clone of defaults when no user options are given", () => {
    const opts = resolveOptions();
    expect(opts.enabled).toBe(DEFAULT_BAKE_OPTIONS.enabled);
    expect(opts.gltf.enabled).toBe(true);
    expect(opts.gltf.meshoptLevel).toBe("medium");
    expect(opts.gltf.textures.codec).toBe("auto");
    expect(opts.audio.target).toBe("ogg");
    // Must be a deep clone, not a reference.
    opts.gltf.meshoptLevel = "high";
    expect(DEFAULT_BAKE_OPTIONS.gltf.meshoptLevel).toBe("medium");
  });

  it("merges partial user options over defaults", () => {
    const opts = resolveOptions({
      gltf: { meshoptLevel: "high", textures: { codec: "uastc" } },
      audio: { bitrate: 128 },
    });
    expect(opts.gltf.meshoptLevel).toBe("high");
    expect(opts.gltf.textures.codec).toBe("uastc");
    // Untouched fields keep defaults.
    expect(opts.gltf.prune).toBe(true);
    expect(opts.gltf.textures.generateMipmap).toBe(true);
    expect(opts.audio.bitrate).toBe(128);
    expect(opts.audio.target).toBe("ogg");
  });

  it("respects enabled: false", () => {
    const opts = resolveOptions({ enabled: false });
    expect(opts.enabled).toBe(false);
  });

  it("respects gltf.enabled: false without disabling audio", () => {
    const opts = resolveOptions({ gltf: { enabled: false } });
    expect(opts.gltf.enabled).toBe(false);
    expect(opts.audio.enabled).toBe(true);
  });

  it("exposes a BAKE_CONFIG_VERSION constant", () => {
    expect(BAKE_CONFIG_VERSION).toBeGreaterThan(0);
    expect(typeof BAKE_CONFIG_VERSION).toBe("number");
  });
});
