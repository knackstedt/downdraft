// ============================================================================
// meshopt bufferView codec — decodes EXT_meshopt_compression bufferViews.
// ============================================================================
//
// Uses the `meshoptimizer` WASM decoder (`MeshoptDecoder`). The decoder is
// loaded lazily and its `ready` promise is awaited before first decode.
//
// EXT_meshopt_compression sits on a bufferView and describes how to decode it
// into `count * byteStride` bytes. The decoded bytes are then read by glTF
// accessors exactly like an uncompressed bufferView. We return the decoded
// Uint8Array; the parser caches it per-bufferView so all accessors sharing
// the bufferView reuse one decode.
//

import { assertFinite, assertPositive, MAX_DECOMPRESS_SIZE } from "@downdraft/engine";
import type { BufferViewCodec, BufferViewCodecInput } from "./registry";

// Minimal type for the meshoptimizer decoder module (see meshopt_decoder.d.ts).
interface MeshoptDecoderModule {
  supported: boolean;
  ready: Promise<void>;
  decodeGltfBuffer: (
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ) => void;
  decodeGltfBufferAsync: (
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ) => Promise<Uint8Array>;
}

let decoderPromise: Promise<MeshoptDecoderModule> | null = null;

async function loadMeshoptDecoder(): Promise<MeshoptDecoderModule> {
  if (decoderPromise) return decoderPromise;
  decoderPromise = (async () => {
    const mod = (await import("meshoptimizer/decoder")) as unknown as {
      MeshoptDecoder: MeshoptDecoderModule;
    };
    const decoder = mod.MeshoptDecoder;
    if (!decoder.supported) {
      throw new Error("meshoptimizer: WebAssembly not supported in this runtime");
    }
    await decoder.ready;
    return decoder;
  })();
  return decoderPromise;
}

export function createMeshoptBufferViewCodec(): BufferViewCodec {
  return {
    uri: "EXT_meshopt_compression",
    async decode(input: BufferViewCodecInput): Promise<Uint8Array> {
      const decoder = await loadMeshoptDecoder();

      const ext = input.extension;
      const count = (ext.count as number) ?? input.accessor.count;
      const byteStride = (ext.byteStride as number) ?? input.byteStride;
      const mode = (ext.mode as string) ?? "ATTRIBUTES";
      const filter = (ext.filter as string) ?? "NONE";

      if (!mode) throw new Error("EXT_meshopt_compression: missing mode");
      if (!byteStride) throw new Error("EXT_meshopt_compression: missing byteStride");

      // Validate count and byteStride are positive finite numbers
      assertFinite("meshopt count", count);
      assertPositive("meshopt count", count);
      assertFinite("meshopt byteStride", byteStride);
      assertPositive("meshopt byteStride", byteStride);

      // Validate count * byteStride doesn't overflow and is within decompress limit
      const totalSize = count * byteStride;
      if (!Number.isFinite(totalSize) || totalSize > MAX_DECOMPRESS_SIZE) {
        throw new RangeError(
          `EXT_meshopt_compression: decoded size ${totalSize} exceeds max ${MAX_DECOMPRESS_SIZE}`,
        );
      }

      const target = new Uint8Array(totalSize);
      decoder.decodeGltfBuffer(target, count, byteStride, input.compressedData, mode, filter);
      return target;
    },
  };
}
