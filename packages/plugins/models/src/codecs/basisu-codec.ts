// ============================================================================
// basisu texture codec — wires KHR_texture_basisu to the engine's KTX2 reader.
// ============================================================================
//
// KHR_texture_basisu points a glTF texture at an image whose bufferView holds
// KTX2-encoded bytes (with Basisu supercompression). The engine already has a
// KTX2 reader in `@downdraft/core` (`parseKTX2FromBuffer`); this codec is the
// glTF-extension wiring that feeds the image bytes into that reader.
//
// No new WASM is required: KTX2 with Basisu is decoded by the existing reader
// (which hands the raw level data to WebGPU as a compressed-texture format).
//

import type { TextureCodec, TextureCodecInput, TextureCodecOutput } from "./registry";

let parseKtx2: ((buffer: ArrayBuffer) => {
  width: number;
  height: number;
  data: Uint8Array;
  format: string;
  mipLevels: number;
  isHDR: boolean;
} | null) | null = null;

async function loadKtx2Parser(): Promise<NonNullable<typeof parseKtx2>> {
  if (parseKtx2) return parseKtx2;
  // Lazy import from core to avoid a hard circular dep at module load.
  const core = (await import("@downdraft/core")) as unknown as {
    parseKTX2FromBuffer: typeof parseKtx2;
  };
  parseKtx2 = core.parseKTX2FromBuffer;
  return parseKtx2!;
}

export function createBasisuTextureCodec(): TextureCodec {
  return {
    uri: "KHR_texture_basisu",
    async decode(input: TextureCodecInput): Promise<TextureCodecOutput> {
      const parse = await loadKtx2Parser();
      // The image data is KTX2 bytes (from a bufferView or embedded uri).
      const buffer = input.data.slice().buffer;
      const result = parse(buffer);
      if (!result) {
        throw new Error("KHR_texture_basisu: failed to parse KTX2 image data");
      }
      return {
        data: result.data,
        width: result.width,
        height: result.height,
        format: result.format,
        mipLevels: result.mipLevels,
        isHDR: result.isHDR,
      };
    },
  };
}
