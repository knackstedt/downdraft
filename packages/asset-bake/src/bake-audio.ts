// ============================================================================
// bake-audio.ts — normalize/transcode audio assets.
// ============================================================================
//
// Strategy:
//   1. If a system `ffmpeg` binary is available → transcode via child process
//      (fast, no extra deps).
//   2. Else → skip with a warning (do NOT fail the build over audio). The
//      original file is passed through unchanged.
//
// We deliberately avoid bundling a wasm ffmpeg here (large + slow). Games that
// need guaranteed audio baking can install ffmpeg on the build host.
//

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BakeResult, ResolvedBakeOptions } from "./config";

let ffmpegChecked: boolean | null = null;

/** Returns true if a system `ffmpeg` binary is on PATH. */
export function hasFfmpeg(): boolean {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000 });
    ffmpegChecked = r.status === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

const TARGET_EXT: Record<string, string> = {
  ogg: "ogg",
  mp3: "mp3",
  wav: "wav",
  flac: "flac",
};

const TARGET_CODEC: Record<string, string> = {
  ogg: "libvorbis",
  mp3: "libmp3lame",
  wav: "pcm_s16le",
  flac: "flac",
};

/**
 * Bake an audio file. If ffmpeg is unavailable, the original bytes are
 * returned unchanged with a warning (the build never fails over audio).
 */
export async function bakeAudio(
  sourceAbsPath: string,
  opts: ResolvedBakeOptions,
  log?: (msg: string) => void,
): Promise<BakeResult> {
  const a = opts.audio;
  const srcSize = statSync(sourceAbsPath).size;

  if (!a.enabled) {
    return passThrough(sourceAbsPath, srcSize);
  }

  if (!hasFfmpeg()) {
    log?.(`  audio: ffmpeg not found — skipping (pass-through)`);
    return passThrough(sourceAbsPath, srcSize);
  }

  const target = a.target;
  const outExt = TARGET_EXT[target];
  const codec = TARGET_CODEC[target];

  // Write to a temp file, then transcode.
  const tmpOut = join(tmpdir(), `downdraft-bake-${process.pid}-${Date.now()}.${outExt}`);
  const args: string[] = ["-y", "-i", sourceAbsPath];
  if (a.sampleRate > 0) args.push("-ar", String(a.sampleRate));
  if (a.channels > 0) args.push("-ac", String(a.channels));
  if (target === "ogg" || target === "mp3") {
    args.push("-b:a", `${a.bitrate}k`);
  }
  args.push("-c:a", codec, tmpOut);

  const res = spawnSync("ffmpeg", args, { stdio: "ignore", timeout: 120000 });
  if (res.status !== 0) {
    log?.(`  audio: ffmpeg failed (exit ${res.status}) — pass-through`);
    return passThrough(sourceAbsPath, srcSize);
  }

  const baked = readFileSync(tmpOut);
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpOut);
  } catch {}
  log?.(`  audio: ${srcSize} → ${baked.byteLength} bytes (${outExt})`);

  return {
    bytes: new Uint8Array(baked),
    ext: outExt,
    mimeType: AUDIO_MIME[outExt] ?? `audio/${outExt}`,
    sourceSize: srcSize,
  };
}

function passThrough(sourceAbsPath: string, srcSize: number): BakeResult {
  const data = readFileSync(sourceAbsPath);
  const ext = sourceAbsPath.split(".").pop()?.toLowerCase() ?? "bin";
  const mime = PASS_THROUGH_MIME[ext] ?? "application/octet-stream";
  return { bytes: new Uint8Array(data), ext, mimeType: mime, sourceSize: srcSize };
}

const AUDIO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

const PASS_THROUGH_MIME: Record<string, string> = AUDIO_MIME;
