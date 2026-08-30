// Specs for bake-audio — pass-through when ffmpeg is unavailable.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeAudio, hasFfmpeg } from "./bake-audio";
import { resolveOptions } from "./config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "downdraft-audio-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bakeAudio", () => {
  it("passes through unchanged when audio baking is disabled", async () => {
    const src = join(tmpDir, "sound.wav");
    const data = Buffer.from("RIFF....WAVEfmt ");
    writeFileSync(src, data);
    const opts = resolveOptions({ audio: { enabled: false } });
    const result = await bakeAudio(src, opts);
    expect(result.ext).toBe("wav");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.sourceSize).toBe(data.byteLength);
    expect(result.bytes.byteLength).toBe(data.byteLength);
  });

  it("passes through when ffmpeg is not available", async () => {
    // This test assumes ffmpeg may or may not be present. If it is, the
    // pass-through path is skipped. We verify the pass-through by checking
    // that the result has the original extension when ffmpeg is absent.
    const src = join(tmpDir, "sound.ogg");
    const data = Buffer.from("OggS....vorbis");
    writeFileSync(src, data);
    const opts = resolveOptions();
    const result = await bakeAudio(src, opts);
    if (!hasFfmpeg()) {
      expect(result.ext).toBe("ogg");
      expect(result.bytes.byteLength).toBe(data.byteLength);
    } else {
      // If ffmpeg is present, it should have transcoded (or fallen back).
      expect(result.ext).toMatch(/^(ogg|mp3|wav|flac)$/);
    }
  });

  it("returns the correct MIME type for pass-through mp3", async () => {
    const src = join(tmpDir, "music.mp3");
    writeFileSync(src, Buffer.from("ID3....mp3data"));
    const opts = resolveOptions({ audio: { enabled: false } });
    const result = await bakeAudio(src, opts);
    expect(result.mimeType).toBe("audio/mpeg");
  });
});
