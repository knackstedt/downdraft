// Bindless material binding model — public surface
export { BINDLESS_MATERIAL_CHUNK, BINDLESS_TEXTURE_BINDINGS_CHUNK, materialIndexAttribute } from "./bindless.wgsl";
export { BindlessFrameBindings, DEFAULT_FORMAT_SLOTS } from "./frame-bindings";
export type { BindlessFormatSlot, BindlessFrameBindingsOptions } from "./frame-bindings";
export { BindlessMaterialManager, MATERIAL_STRUCT_SIZE, packHandle16 } from "./material-manager";
export type { MaterialManagerOptions, MaterialParams } from "./material-manager";
export { BindlessTextureRegistry, computeBucketKey } from "./texture-registry";
export type { RegisteredTexture, TextureBucketKey, TextureRegistryOptions } from "./texture-registry";

