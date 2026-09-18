// ============================================================================
// Draco mesh codec — decodes KHR_draco_mesh_compression primitives.
// ============================================================================
//
// Uses the `draco3dgltf` WASM decoder. The decoder module is loaded lazily on
// first decode() call and cached for the process lifetime. The WASM binary
// path is resolved via `locateFile`; see `configureDracoWasmPath()`.
//
// KHR_draco_mesh_compression maps each glTF attribute semantic to a Draco
// attribute unique id. We decode the whole primitive once and return per-
// attribute typed arrays.
//

import { assertCount, MAX_DECOMPRESS_SIZE, MAX_FACE_COUNT, MAX_VERTEX_COUNT } from "@downdraft/engine";
import type {
    AccessorLike,
    DecodedPrimitive,
    MeshCodec,
    MeshCodecInput,
} from "./registry";

// Draco component type constants (mirrors glTF componentType).
const COMPONENT_TYPE_BYTES: Record<number, number> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

// Emscripten decoder module factory + the resolved module instance.
type DracoModuleFactory = (config: {
  locateFile?: (file: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
  onRuntimeInitialized?: () => void;
}) => Promise<DracoModule>;

interface DracoModule {
  DecoderBuffer: new () => DracoDecoderBuffer;
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoMesh;
  PointCloud: new () => DracoPointCloud;
  AttributeData: new () => DracoAttributeData;
  // Typed array constructors bound to the module's heap.
  // The emscripten module exposes heap views; we use module-provided arrays.
  _malloc: (n: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  // Draco status enum values
  POINT_CLOUD: number;
  TRIANGULAR_MESH: number;
  // Attribute data type enum (DT_FLOAT32, DT_UINT8, etc.) — accessed lazily.
  [key: string]: unknown;
}

interface DracoDecoderBuffer {
  Init(data: Uint8Array, length: number): void;
  delete(): void;
}

interface DracoDecoder {
  GetEncodedGeometryType(buffer: DracoDecoderBuffer): number;
  DecodeBufferToMesh(buffer: DracoDecoderBuffer, mesh: DracoMesh): number;
  DecodeBufferToPointCloud(buffer: DracoDecoderBuffer, pc: DracoPointCloud): number;
  GetMeshAttribute(mesh: DracoMesh, uniqueId: number): DracoAttributeData;
  GetAttribute(mesh: DracoMesh, i: number): DracoAttributeData;
  GetFaceFromMesh(mesh: DracoMesh, faceId: number, out: DracoFace): boolean;
  // Read an attribute into a pre-allocated typed array at a heap pointer.
  GetAttributeDataArrayForAllPoints(
    mesh: DracoMesh | DracoPointCloud,
    attr: DracoAttributeData,
    dataType: number,
    outSize: number,
    outPtr: number,
  ): boolean;
  GetAttributeFloatArray(
    mesh: DracoMesh | DracoPointCloud,
    attr: DracoAttributeData,
    outSize: number,
    outPtr: number,
  ): boolean;
  skipAttributeTransform(type: number): void;
  delete(): void;
}

interface DracoMesh {
  num_attributes(): number;
  num_points(): number;
  num_faces(): number;
  delete(): void;
}

interface DracoPointCloud {
  num_attributes(): number;
  num_points(): number;
  delete(): void;
}

interface DracoAttributeData {
  unique_id(): number;
  attribute_type(): number;
  data_type(): number;
  num_components(): number;
  normalized(): boolean;
  size(): number;
  delete(): void;
}

interface DracoFace {
  // DracoDecoder.GetFaceFromMesh writes 3 ints; we use a heap Int32 view.
}

// Draco data type enum (subset we care about).
const DT_FLOAT32 = 9;
const DT_INT8 = 2;
const DT_UINT8 = 3;
const DT_INT16 = 4;
const DT_UINT16 = 5;
const DT_INT32 = 6;
const DT_UINT32 = 7;

// Map glTF componentType → Draco data type for output array allocation.
function componentTypeToDracoDataType(componentType: number): number {
  switch (componentType) {
    case 5126: return DT_FLOAT32;
    case 5121: return DT_UINT8;
    case 5120: return DT_INT8;
    case 5123: return DT_UINT16;
    case 5122: return DT_INT16;
    case 5125: return DT_UINT32;
    default: return DT_FLOAT32;
  }
}

function makeTypedArray(
  module: DracoModule,
  ptr: number,
  componentType: number,
  count: number,
): ArrayBufferView {
  const n = count;
  switch (componentType) {
    case 5126: return module.HEAPF32.subarray(ptr / 4, ptr / 4 + n).slice();
    case 5121: return module.HEAPU8.subarray(ptr, ptr + n).slice();
    case 5120: return new Int8Array(module.HEAPU8.buffer, ptr, n).slice();
    case 5123: {
      const view = new Uint16Array(module.HEAPU8.buffer);
      return view.subarray(ptr / 2, ptr / 2 + n).slice();
    }
    case 5122: {
      const view = new Int16Array(module.HEAPU8.buffer);
      return view.subarray(ptr / 2, ptr / 2 + n).slice();
    }
    case 5125: {
      const view = new Uint32Array(module.HEAPU8.buffer);
      return view.subarray(ptr / 4, ptr / 4 + n).slice();
    }
    default: return module.HEAPF32.subarray(ptr / 4, ptr / 4 + n).slice();
  }
}

// --- Module loading --------------------------------------------------------
let modulePromise: Promise<DracoModule> | null = null;

/**
 * Override the WASM binary path for the Draco decoder. Set this before any
 * Draco-compressed asset is loaded if the default resolution does not work in
 * your runtime (e.g. Electron renderer needs a served URL).
 *
 * Pass either a URL string (located via fetch) or a pre-loaded ArrayBuffer.
 */
export interface DracoWasmConfig {
  wasmUrl?: string;
  wasmBinary?: ArrayBuffer;
}

let dracoWasmConfig: DracoWasmConfig = {};

export function configureDracoWasmPath(config: DracoWasmConfig): void {
  dracoWasmConfig = config;
  // Invalidate cached module so next load uses the new config.
  modulePromise = null;
}

async function loadDracoModule(): Promise<DracoModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    // Dynamic import of the CommonJS package; Bun/Node interop returns the
    // module.exports object. In a bundler (Vite) this is converted to ESM.
    const pkg = (await import("draco3dgltf")) as unknown as {
      createDecoderModule: DracoModuleFactory;
    };
    const factory = pkg.createDecoderModule;

    const config: Parameters<DracoModuleFactory>[0] = {};
    if (dracoWasmConfig.wasmBinary) {
      config.wasmBinary = dracoWasmConfig.wasmBinary;
    } else if (dracoWasmConfig.wasmUrl) {
      const url = dracoWasmConfig.wasmUrl;
      config.locateFile = (file: string) => {
        // Only redirect the .wasm file; the JS glue is already loaded.
        if (file.endsWith(".wasm")) return url;
        return file;
      };
    }
    // else: rely on the module's default locateFile (works in Node where the
    // .wasm sits next to the JS glue; in browsers it needs configuration).

    const mod = (await factory(config)) as unknown as DracoModule;
    return mod;
  })();
  return modulePromise;
}

// --- Codec -----------------------------------------------------------------

export function createDracoMeshCodec(): MeshCodec {
  return {
    uri: "KHR_draco_mesh_compression",
    async decode(input: MeshCodecInput): Promise<DecodedPrimitive> {
      const mod = await loadDracoModule();

      const decoderBuffer = new mod.DecoderBuffer();
      decoderBuffer.Init(input.bufferViewData, input.bufferViewData.length);

      const decoder = new mod.Decoder();

      try {
        const geomType = decoder.GetEncodedGeometryType(decoderBuffer);
        const isMesh = geomType === mod.TRIANGULAR_MESH;

        const attributes = new Map<string, ArrayBufferView>();
        let vertexCount = 0;
        let indexCount = 0;
        let indices: ArrayBufferView | undefined;

        if (isMesh) {
          const mesh = new mod.Mesh();
          const ok = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
          if (!ok) throw new Error("Draco: DecodeBufferToMesh failed");
          vertexCount = mesh.num_points();
          indexCount = mesh.num_faces() * 3;
          assertCount("draco vertices", vertexCount, MAX_VERTEX_COUNT);
          assertCount("draco indices", indexCount, MAX_FACE_COUNT * 3);

          // Decode each attribute by glTF semantic → Draco unique id.
          for (const [semantic, uniqueId] of Object.entries(input.attributes)) {
            const attr = decoder.GetMeshAttribute(mesh, uniqueId as number) as any;
            if (!attr) {
              continue;
            }
            const accessor = input.accessors.get(uniqueId as number);
            const componentType = accessor?.componentType ?? 5126;
            const components = accessor ? TYPE_COMPONENTS[accessor.type] ?? 1 : attr.num_components();
            const totalComponents = vertexCount * components;
            const bytesPer = COMPONENT_TYPE_BYTES[componentType] ?? 4;
            if (totalComponents * bytesPer > MAX_DECOMPRESS_SIZE) {
              throw new RangeError(
                `Draco: attribute ${semantic} decoded size ${totalComponents * bytesPer} exceeds max ${MAX_DECOMPRESS_SIZE}`,
              );
            }
            const ptr = mod._malloc(totalComponents * bytesPer);
            try {
              const dataType = componentTypeToDracoDataType(componentType);
              const success = decoder.GetAttributeDataArrayForAllPoints(
                mesh,
                attr,
                dataType,
                totalComponents * bytesPer,
                ptr,
              );
              if (!success) {
                throw new Error(`Draco: failed to decode attribute ${semantic}`);
              }
              attributes.set(semantic, makeTypedArray(mod, ptr, componentType, totalComponents));
            } finally {
              mod._free(ptr);
              attr.delete();
            }
          }

          // Decode indices (faces → triangle index buffer).
          if (input.indices !== undefined) {
            const accessor = input.accessors.get(input.indices);
            const componentType = accessor?.componentType ?? 5123;
            const bytesPer = COMPONENT_TYPE_BYTES[componentType] ?? 2;
            const ptr = mod._malloc(indexCount * bytesPer);
            try {
              // Draco face indices are uint32; we read via GetFaceFromMesh
              // would be slow per-face. Use the typed-array path: Draco
              // exposes mesh indices through the same array API when the
              // "indices" attribute is requested. Fall back to per-face read.
              const indexArray = componentType === 5125
                ? new Uint32Array(indexCount)
                : componentType === 5122
                  ? new Int16Array(indexCount)
                  : new Uint16Array(indexCount);
              const faceView = new Int32Array(mod.HEAPU8.buffer);
              const facePtr = mod._malloc(12);
              try {
                for (let f = 0; f < mesh.num_faces(); f++) {
                  decoder.GetFaceFromMesh(mesh, f, { ptr: facePtr } as unknown as DracoFace);
                  const i0 = faceView[facePtr / 4];
                  const i1 = faceView[facePtr / 4 + 1];
                  const i2 = faceView[facePtr / 4 + 2];
                  indexArray[f * 3] = i0;
                  indexArray[f * 3 + 1] = i1;
                  indexArray[f * 3 + 2] = i2;
                }
              } finally {
                mod._free(facePtr);
              }
              indices = indexArray;
            } finally {
              mod._free(ptr);
            }
          }

          mesh.delete();
        } else {
          // Point cloud (no indices).
          const pc = new mod.PointCloud();
          const ok = decoder.DecodeBufferToPointCloud(decoderBuffer, pc);
          if (!ok) throw new Error("Draco: DecodeBufferToPointCloud failed");
          vertexCount = pc.num_points();

          for (const [semantic, uniqueId] of Object.entries(input.attributes)) {
            const attr = decoder.GetMeshAttribute(pc as unknown as DracoMesh, uniqueId as number);
            if (!attr) continue;
            const accessor = input.accessors.get(uniqueId as number);
            const componentType = accessor?.componentType ?? 5126;
            const components = accessor ? TYPE_COMPONENTS[accessor.type] ?? 1 : attr.num_components();
            const totalComponents = vertexCount * components;
            const bytesPer = COMPONENT_TYPE_BYTES[componentType] ?? 4;
            const ptr = mod._malloc(totalComponents * bytesPer);
            try {
              const dataType = componentTypeToDracoDataType(componentType);
              const success = decoder.GetAttributeDataArrayForAllPoints(
                pc as unknown as DracoMesh,
                attr,
                dataType,
                totalComponents * bytesPer,
                ptr,
              );
              if (!success) throw new Error(`Draco: failed to decode attribute ${semantic}`);
              attributes.set(semantic, makeTypedArray(mod, ptr, componentType, totalComponents));
            } finally {
              mod._free(ptr);
              attr.delete();
            }
          }
          pc.delete();
        }

        return { attributes, indices, vertexCount, indexCount };
      } finally {
        decoder.delete();
        decoderBuffer.delete();
      }
    },
  };
}

export type { AccessorLike };
