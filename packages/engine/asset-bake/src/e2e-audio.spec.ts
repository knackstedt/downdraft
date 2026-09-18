// E2E test: bake a real WAV file through ffmpeg → verify output is valid OGG.
// Run: bun test packages/engine/asset-bake/src/e2e-audio.spec.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeAudio, hasFfmpeg } from "./bake-audio";
import { resolveOptions } from "./config";

let tmpDir: string;
let wavPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "downdraft-audio-e2e-"));
  wavPath = join(tmpDir, "test.wav");
  // Generate a 0.5s 440Hz sine wave WAV via ffmpeg.
  spawnSync("ffmpeg", [
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
    "-ar", "44100", "-ac", "1", wavPath, "-y",
  ], { stdio: "ignore" });
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("e2e: bake audio with real ffmpeg", () => {
  it("transcodes WAV → OGG via ffmpeg", async () => {
    if (!hasFfmpeg()) {
      console.log("  [e2e] ffmpeg not available — skipping");
      return;
    }
    expect(existsSync(wavPath)).toBe(true);
    const srcSize = readFileSync(wavPath).byteLength;
    console.log(`  [e2e] source WAV: ${srcSize} bytes`);

    const opts = resolveOptions({ audio: { target: "ogg", bitrate: 96, sampleRate: 48000, channels: 1 } });
    const result = await bakeAudio(wavPath, opts, (msg) => console.log(`  [e2e]${msg}`));

    expect(result.ext).toBe("ogg");
    expect(result.mimeType).toBe("audio/ogg");
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.bytes.byteLength).toBeLessThan(srcSize); // OGG should be smaller than WAV
    console.log(`  [e2e] baked OGG: ${result.bytes.byteLength} bytes (${((1 - result.bytes.byteLength / srcSize) * 100).toFixed(1)}% smaller)`);

    // Verify the output is a valid OGG file (OGG magic: "OggS").
    const magic = String.fromCharCode(...result.bytes.slice(0, 4));
    expect(magic).toBe("OggS");

    // Verify ffmpeg can probe the output (round-trip validation).
    const tmpOut = join(tmpDir, "probe.ogg");
    writeFileSync(tmpOut, result.bytes);
    const probe = spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", tmpOut], { encoding: "utf-8" });
    expect(probe.status).toBe(0);
    const info = JSON.parse(probe.stdout);
    expect(info.format.format_name).toBe("ogg");
    console.log(`  [e2e] ffprobe confirms valid OGG: duration=${info.format.duration}s`);
  }, 30000);

  it("transcodes WAV → MP3 via ffmpeg", async () => {
    if (!hasFfmpeg()) return;
    const opts = resolveOptions({ audio: { target: "mp3", bitrate: 128 } });
    const result = await bakeAudio(wavPath, opts);
    expect(result.ext).toBe("mp3");
    expect(result.mimeType).toBe("audio/mpeg");
    // MP3 magic: ID3 tag or frame sync 0xFF 0xFB.
    const isID3 = result.bytes[0] === 0x49 && result.bytes[1] === 0x44 && result.bytes[2] === 0x33;
    const isFrameSync = result.bytes[0] === 0xff && (result.bytes[1] & 0xe0) === 0xe0;
    expect(isID3 || isFrameSync).toBe(true);
    console.log(`  [e2e] MP3: ${result.bytes.byteLength} bytes, valid header`);
  }, 30000);
});
