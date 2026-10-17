// ============================================================================
// basisu texture codec — transcodes KHR_texture_basisu KTX2 → GPU texture.
// ============================================================================
//
// KHR_texture_basisu points a glTF texture at an image whose bufferView holds
// KTX2-encoded bytes with Basis Universal supercompression (vkFormat=0). The
// engine's KTX2 reader (parseKTX2FromBuffer) only handles KTX2 with concrete
// vkFormats (BC/ASTC/ETC/uncompressed) — it cannot transcode Basisu. This
// codec bridges that gap: it transcodes Basisu KTX2 → the best GPU format the
// device supports using @h00w/basis-universal-transcoder (wasm, ~486KB,
// lazy-loaded).
//
// Transcode target selection (see selectBasisuTranscodeTarget): BC7 when the
// device exposes texture-compression-bc (desktop), ASTC 4x4 for
// texture-compression-astc and ETC2 for texture-compression-etc2 (mobile),
// and RGBA32 otherwise — every WebGPU device supports rgba8unorm.
//
// The transcoder wasm is loaded lazily on first decode(). In the Vite
// renderer the wasm URL is resolved via a `?url` import; in Node it is read
// from the package on disk. Override with configureBasisuWasmPath().
//

import type { TextureCodec, TextureCodecInput, TextureCodecOutput } from "./registry";

// Vite resolves this to a hashed asset URL in the renderer build. In Node the
// import is unused (we read from disk). `vite/client` types declare `*?url`.
// Loaded lazily: Deno rejects the `?url` package subpath at resolution time.
let wasmUrlCached: string | null = null;
async function getWasmUrl(): Promise<string> {
  if (wasmUrlCached === null) {
    try {
      const mod = await import("@h00w/basis-universal-transcoder/basis_capi_transcoder.wasm?url") as { default: string };
      wasmUrlCached = mod.default;
    } catch {
      wasmUrlCached = "";
    }
  }
  return wasmUrlCached;
}

export interface BasisuWasmConfig {
  wasmUrl?: string;
  wasmBinary?: ArrayBuffer;
}

let basisuWasmConfig: BasisuWasmConfig = {};

/** Override the transcoder wasm source (URL or pre-loaded ArrayBuffer). */
export function configureBasisuWasmPath(config: BasisuWasmConfig): void {
  basisuWasmConfig = config;
  basisuPromise = null;
}

// Minimal typed surface of @h00w/basis-universal-transcoder.
interface TranscodeResult {
  data: Uint8Array;
  width: number;
  height: number;
}
interface KTX2TranscoderT {
  init(data: Uint8Array): boolean;
  getHeader(): { width: number; height: number; levels: number };
  startTranscoding(): boolean;
  transcodeImageLevel(opts: {
    format: number;
    level?: number;
    layer?: number;
    face?: number;
  }): TranscodeResult | null;
  dispose(): void;
}
interface BasisUniversalT {
  createKTX2Transcoder(): KTX2TranscoderT;
}
type TranscoderTextureFormat = number;
const cTFETC2_RGBA = 1 as TranscoderTextureFormat;
const cTFBC7_RGBA = 6 as TranscoderTextureFormat;
const cTFASTC_4x4_RGBA = 10 as TranscoderTextureFormat;
const cTFRGBA32 = 13 as TranscoderTextureFormat;

export interface BasisuTranscodeTarget {
  /** @h00w/basis-universal-transcoder format enum passed to transcodeImageLevel. */
  transcodeFormat: TranscoderTextureFormat;
  /** WebGPU format of the emitted bytes (input for createGPUTextureFromData). */
  gpuFormat: GPUTextureFormat;
}

/**
 * Pick the transcode target for the device's texture-compression features.
 * Desktop adapters expose texture-compression-bc (→ BC7, ~4x VRAM reduction
 * vs RGBA32); mobile adapters expose astc/etc2. Falls back to RGBA32, which
 * every WebGPU device accepts.
 */
export function selectBasisuTranscodeTarget(
  compressionFeatures: readonly string[] | undefined,
  srgb: boolean,
): BasisuTranscodeTarget {
  const s = srgb ? "-srgb" : "";
  if (compressionFeatures?.includes("texture-compression-bc")) {
    return { transcodeFormat: cTFBC7_RGBA, gpuFormat: `bc7-rgba-unorm${s}` as GPUTextureFormat };
  }
  if (compressionFeatures?.includes("texture-compression-astc")) {
    return { transcodeFormat: cTFASTC_4x4_RGBA, gpuFormat: `astc-4x4-unorm${s}` as GPUTextureFormat };
  }
  if (compressionFeatures?.includes("texture-compression-etc2")) {
    return { transcodeFormat: cTFETC2_RGBA, gpuFormat: `etc2-rgba8unorm${s}` as GPUTextureFormat };
  }
  return { transcodeFormat: cTFRGBA32, gpuFormat: `rgba8unorm${s}` as GPUTextureFormat };
}

let basisuPromise: Promise<BasisUniversalT> | null = null;

async function loadBasisu(): Promise<BasisUniversalT> {
  if (basisuPromise) return basisuPromise;
  basisuPromise = (async () => {
    const mod = await import("@h00w/basis-universal-transcoder");
    const { BasisUniversal } = mod as unknown as {
      BasisUniversal: {
        getInstance(instantiate: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>): Promise<BasisUniversalT>;
      };
    };

    const instantiate = async (imports: WebAssembly.Imports): Promise<WebAssembly.WebAssemblyInstantiatedSource> => {
      // Explicit override wins.
      if (basisuWasmConfig.wasmBinary) {
        return WebAssembly.instantiate(basisuWasmConfig.wasmBinary, imports);
      }
      const url = basisuWasmConfig.wasmUrl ?? (await getWasmUrl());
      // Browser/renderer: fetch the URL if it's a valid http/https URL.
      // The `?url` import produces a real URL in Vite; in Node/bun it may
      // produce an invalid string, so we validate before fetching.
      if (typeof fetch === "function" && /^https?:\/\//.test(url)) {
        const res = await fetch(url);
        const bytes = await res.arrayBuffer();
        return WebAssembly.instantiate(bytes, imports);
      }
      // Node fallback: read the wasm from the package on disk.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("@h00w/basis-universal-transcoder/package.json");
      const wasmPath = path.join(path.dirname(pkgPath), "dist", "basis_capi_transcoder.wasm");
      const bytes = fs.readFileSync(wasmPath);
      return WebAssembly.instantiate(bytes, imports);
    };

    return BasisUniversal.getInstance(instantiate);
  })();
  return basisuPromise;
}

export function createBasisuTextureCodec(): TextureCodec {
  return {
    uri: "KHR_texture_basisu",
    async decode(input: TextureCodecInput): Promise<TextureCodecOutput> {
      const basisu = await loadBasisu();
      const data = input.data;
      const transcoder = basisu.createKTX2Transcoder();

      if (!transcoder.init(data)) {
        transcoder.dispose();
        throw new Error("KHR_texture_basisu: failed to init KTX2 transcoder");
      }
      if (!transcoder.startTranscoding()) {
        transcoder.dispose();
        throw new Error("KHR_texture_basisu: failed to start transcoding");
      }

      const header = transcoder.getHeader();
      const levels = header.levels;
      const w0 = header.width;
      const h0 = header.height;
      const target = selectBasisuTranscodeTarget(input.compressionFeatures, input.srgb ?? false);

      // Transcode each mip level to the target format and concatenate.
      const levelBytes: Uint8Array[] = [];
      let totalSize = 0;
      for (let level = 0; level < levels; level++) {
        const result = transcoder.transcodeImageLevel({ format: target.transcodeFormat, level });
        if (!result) {
          // Some encoders emit fewer levels than the header claims; stop at
          // the first missing level rather than failing the whole texture.
          break;
        }
        // The wasm memory is invalidated on the next transcode call — copy now.
        const copy = new Uint8Array(result.data);
        levelBytes.push(copy);
        totalSize += copy.byteLength;
      }
      transcoder.dispose();

      if (levelBytes.length === 0) {
        throw new Error("KHR_texture_basisu: no mip levels transcoded");
      }

      const combined = new Uint8Array(totalSize);
      let offset = 0;
      levelBytes.forEach((lb) => {
        combined.set(lb, offset);
        offset += lb.byteLength;
      });

      return {
        data: combined,
        width: w0,
        height: h0,
        format: target.gpuFormat,
        mipLevels: levelBytes.length,
        isHDR: false,
      };
    },
  };
}
