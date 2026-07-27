import type { AudioFormat, AudioBufferDesc } from "../audio/interface.ts";
import type { AudioEngine } from "../audio/engine.ts";
import type { AssetManager } from "./manager.ts";
import { promises as fs } from "node:fs";

const EXTENSION_FORMAT_MAP: Record<string, AudioFormat> = {
  wav: "wav",
  wave: "wav",
  ogg: "ogg",
  oga: "ogg",
  mp3: "mp3",
  flac: "flac",
};

export function detectAudioFormat(uri: string): AudioFormat | null {
  const ext = uri.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_FORMAT_MAP[ext] ?? null;
}

export async function loadAudioFile(
  uri: string,
  engine: AudioEngine,
): Promise<AudioBufferDesc> {
  const format = detectAudioFormat(uri);
  if (!format) {
    throw new Error(`Unsupported audio format: ${uri}`);
  }

  const buf = await fs.readFile(uri);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return engine.loadBuffer(format, data);
}

export async function loadAudioFromBuffer(
  format: AudioFormat,
  data: ArrayBuffer,
  engine: AudioEngine,
): Promise<AudioBufferDesc> {
  return engine.loadBuffer(format, data);
}

export function registerAudioLoader(
  manager: AssetManager,
  engine: AudioEngine,
): void {
  for (const ext of Object.keys(EXTENSION_FORMAT_MAP)) {
    manager.registerLoader(ext, async (uri: string) => {
      return loadAudioFile(uri, engine);
    });
  }
}
