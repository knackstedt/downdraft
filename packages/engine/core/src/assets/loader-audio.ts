import type { AudioEngine } from "../audio/engine";
import type { AudioBufferDesc, AudioFormat } from "../audio/interface";
import type { AssetManager } from "./manager";

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

  // Lazy node:fs import — this module is reachable from the browser-side
  // barrel, so node builtins must not be evaluated at import time. Fall back
  // to fetch() when fs is unavailable (browser/worker realms).
  let fsPromises: typeof import("node:fs").promises | null = null;
  try {
    fsPromises = (await import("node:fs")).promises;
  } catch {
    // node:fs unavailable (browser bundle) — use fetch below.
  }
  let data: ArrayBuffer;
  if (fsPromises) {
    const buf = await fsPromises.readFile(uri);
    data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } else {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`Failed to load audio "${uri}": HTTP ${res.status}`);
    data = await res.arrayBuffer();
  }
  const desc: AudioBufferDesc = {
    id: uri,
    format,
    samples: new Float32Array(data.byteLength / 4),
  };
  const view = new DataView(data);
  for (let i = 0; i < desc.samples.length; i++) {
    desc.samples[i] = view.getFloat32(i * 4, true);
  }
  engine.loadBuffer(desc);
  return desc;
}

export async function loadAudioFromBuffer(
  format: AudioFormat,
  data: ArrayBuffer,
  engine: AudioEngine,
): Promise<AudioBufferDesc> {
  const desc: AudioBufferDesc = {
    id: `buffer-${Date.now()}`,
    format,
    samples: new Float32Array(data.byteLength / 4),
  };
  const view = new DataView(data);
  for (let i = 0; i < desc.samples.length; i++) {
    desc.samples[i] = view.getFloat32(i * 4, true);
  }
  engine.loadBuffer(desc);
  return desc;
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
