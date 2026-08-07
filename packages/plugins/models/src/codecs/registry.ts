// ============================================================================
// glTF Codec Registry — extension-URI-keyed decoders for compressed/extended
// glTF data. This is the second axis of the asset pipeline: AssetManager keys
// on file extension, the codec registry keys on glTF extension URI.
// ============================================================================
//
// Mesh codecs decode compressed accessor data (Draco, meshopt) into typed
// arrays. Texture codecs decode extension-encoded image data (basisu/KTX2).
// Extension processors handle non-codec extensions (texture_transform,
// material variants, lights punctual) and are registered separately.
//

export type ComponentType = 5120 | 5121 | 5122 | 5123 | 5125 | 5126;

export interface AccessorLike {
  bufferView: number;
  byteOffset?: number;
  componentType: ComponentType;
  count: number;
  type: string;
  normalized?: boolean;
}

export interface BufferViewLike {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  extensions?: Record<string, unknown>;
}

/** Output of a mesh codec: per-attribute typed arrays keyed by glTF semantic. */
export interface DecodedPrimitive {
  attributes: Map<string, ArrayBufferView>;
  indices?: ArrayBufferView;
  vertexCount: number;
  indexCount: number;
}

/** Input for a mesh codec keyed on a primitive extension (e.g. KHR_draco_mesh_compression). */
export interface MeshCodecInput {
  /** Raw bytes of the bufferView referenced by the extension. */
  bufferViewData: Uint8Array;
  /** The extension object from the primitive. */
  extension: Record<string, unknown>;
  /** Semantic → accessor id map from the primitive (e.g. { POSITION: 0, NORMAL: 1 }). */
  attributes: Record<string, number>;
  /** Whether the primitive has explicit indices (and the accessor id if so). */
  indices?: number;
  /** Accessor metadata by id, for component type / count / type resolution. */
  accessors: Map<number, AccessorLike>;
}

export interface MeshCodec {
  readonly uri: string;
  decode(input: MeshCodecInput): Promise<DecodedPrimitive>;
}

/** Input for a bufferView-level codec (e.g. EXT_meshopt_compression). */
export interface BufferViewCodecInput {
  /** Raw bytes of the *compressed* bufferView referenced by the extension. */
  compressedData: Uint8Array;
  /** The extension object from the bufferView. */
  extension: Record<string, unknown>;
  /** The accessor that reads from this bufferView (for count/type/componentType). */
  accessor: AccessorLike;
  /** Resolved byteStride for the decoded bufferView (from extension or accessor). */
  byteStride: number;
}

export interface BufferViewCodec {
  readonly uri: string;
  /** Decode a single bufferView into a typed array matching the accessor. */
  decode(input: BufferViewCodecInput): Promise<ArrayBufferView>;
}

/** Texture codec input (e.g. KHR_texture_basisu → KTX2 bytes). */
export interface TextureCodecInput {
  /** Raw bytes of the image/bufferView referenced by the texture source. */
  data: Uint8Array;
  /** The extension object from the texture. */
  extension: Record<string, unknown>;
  /** mimeType if known. */
  mimeType?: string;
}

export interface TextureCodecOutput {
  data: Uint8Array;
  width: number;
  height: number;
  format: string;
  mipLevels: number;
  isHDR: boolean;
}

export interface TextureCodec {
  readonly uri: string;
  decode(input: TextureCodecInput): Promise<TextureCodecOutput>;
}

/**
 * Registry of glTF extension codecs. A single shared instance is used by the
 * glTF parser; codecs are registered once at plugin setup.
 */
export class GLTFCodecRegistry {
  private meshCodecs: Map<string, MeshCodec> = new Map();
  private bufferViewCodecs: Map<string, BufferViewCodec> = new Map();
  private textureCodecs: Map<string, TextureCodec> = new Map();
  private supportedExtensions: Set<string> = new Set();

  registerMeshCodec(codec: MeshCodec): void {
    this.meshCodecs.set(codec.uri, codec);
    this.supportedExtensions.add(codec.uri);
  }

  registerBufferViewCodec(codec: BufferViewCodec): void {
    this.bufferViewCodecs.set(codec.uri, codec);
    this.supportedExtensions.add(codec.uri);
  }

  registerTextureCodec(codec: TextureCodec): void {
    this.textureCodecs.set(codec.uri, codec);
    this.supportedExtensions.add(codec.uri);
  }

  /** Declare support for a non-codec extension (e.g. KHR_texture_transform). */
  declareSupported(uri: string): void {
    this.supportedExtensions.add(uri);
  }

  getMeshCodec(uri: string): MeshCodec | undefined {
    return this.meshCodecs.get(uri);
  }

  getBufferViewCodec(uri: string): BufferViewCodec | undefined {
    return this.bufferViewCodecs.get(uri);
  }

  getTextureCodec(uri: string): TextureCodec | undefined {
    return this.textureCodecs.get(uri);
  }

  hasMeshCodec(uri: string): boolean {
    return this.meshCodecs.has(uri);
  }

  hasBufferViewCodec(uri: string): boolean {
    return this.bufferViewCodecs.has(uri);
  }

  hasTextureCodec(uri: string): boolean {
    return this.textureCodecs.has(uri);
  }

  listSupported(): string[] {
    return Array.from(this.supportedExtensions).sort();
  }
}

let defaultRegistry: GLTFCodecRegistry | null = null;

/** Lazily-created process-wide registry with default codecs registered. */
export function getDefaultCodecRegistry(): GLTFCodecRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new GLTFCodecRegistry();
    registerDefaultCodecs(defaultRegistry);
  }
  return defaultRegistry;
}

/** Replace the default registry (useful for tests with isolated codec sets). */
export function setDefaultCodecRegistry(registry: GLTFCodecRegistry): void {
  defaultRegistry = registry;
}

/**
 * Register the bundled default codecs (Draco, meshopt, basisu) and declare
 * support for non-codec extensions handled directly by the parser
 * (texture_transform, mesh_quantization, material_variants, lights_punctual).
 *
 * WASM paths are resolved lazily; if a codec's WASM module cannot be loaded
 * (e.g. missing asset path in a given runtime), that codec is simply absent
 * and the parser will surface a clear error on assets that require it.
 */
export function registerDefaultCodecs(registry: GLTFCodecRegistry): void {
  // Codec-backed extensions (registered lazily on first use to avoid pulling
  // WASM modules in environments that never load compressed assets).
  registry.registerMeshCodec(createLazyDracoMeshCodec());
  registry.registerBufferViewCodec(createLazyMeshoptBufferViewCodec());
  registry.registerTextureCodec(createLazyBasisuTextureCodec());

  // Non-codec extensions handled directly in the parser/extension processors.
  registry.declareSupported("KHR_texture_transform");
  registry.declareSupported("KHR_mesh_quantization");
  registry.declareSupported("KHR_materials_variants");
  registry.declareSupported("KHR_lights_punctual");
  registry.declareSupported("KHR_materials_pbrSpecularGlossiness");
  registry.declareSupported("KHR_materials_unlit");
  registry.declareSupported("KHR_materials_emissive_strength");
}

// --- Lazy codec factories -------------------------------------------------
// These are split into their own modules but referenced here so the registry
// wires them on first access. Each factory returns a codec that loads its
// WASM/JS glue only when decode() is first called.
import { createDracoMeshCodec } from "./draco-codec";
import { createMeshoptBufferViewCodec } from "./meshopt-codec";
import { createBasisuTextureCodec } from "./basisu-codec";

function createLazyDracoMeshCodec(): MeshCodec {
  return createDracoMeshCodec();
}

function createLazyMeshoptBufferViewCodec(): BufferViewCodec {
  return createMeshoptBufferViewCodec();
}

function createLazyBasisuTextureCodec(): TextureCodec {
  return createBasisuTextureCodec();
}
