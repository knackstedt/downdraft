// Codec registry + bundled codecs for the glTF asset pipeline.
export {
  GLTFCodecRegistry,
  getDefaultCodecRegistry,
  registerDefaultCodecs,
  setDefaultCodecRegistry,
} from "./registry";
export type {
  AccessorLike,
  BufferViewCodec,
  BufferViewCodecInput,
  DecodedPrimitive,
  MeshCodec,
  MeshCodecInput,
  TextureCodec,
  TextureCodecInput,
  TextureCodecOutput,
} from "./registry";
export { configureDracoWasmPath } from "./draco-codec";
export type { DracoWasmConfig } from "./draco-codec";
export { createDracoMeshCodec } from "./draco-codec";
export { createMeshoptBufferViewCodec } from "./meshopt-codec";
export { createBasisuTextureCodec } from "./basisu-codec";
