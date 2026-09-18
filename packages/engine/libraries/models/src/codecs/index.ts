// Codec registry + bundled codecs for the glTF asset pipeline.
export { configureBasisuWasmPath, createBasisuTextureCodec } from "./basisu-codec";
export type { BasisuWasmConfig } from "./basisu-codec";
export { configureDracoWasmPath, createDracoMeshCodec } from "./draco-codec";
export type { DracoWasmConfig } from "./draco-codec";
export { createMeshoptBufferViewCodec } from "./meshopt-codec";
export {
    getDefaultCodecRegistry, GLTFCodecRegistry, registerDefaultCodecs,
    setDefaultCodecRegistry
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
    TextureCodecOutput
} from "./registry";

