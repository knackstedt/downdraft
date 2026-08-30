export { CHUNKS, getChunk } from "./chunks";
export { GraphCompiler } from "./compiler";
export type { CompileOptions, CompileResult } from "./compiler";
export { MaterialGraph } from "./graph";
export type { GraphNode } from "./graph";
export {
    GBUFFER_PROFILE, getProfile, PBR_COLOR_VERTEX_PROFILE, PBR_INSTANCED_PROFILE, PBR_PROFILE, PBR_SKINNED_PROFILE, PBR_TEXTURED_PROFILE, PROFILE_REGISTRY, SIMPLE_PROFILE
} from "./profiles";
export type {
    BindGroupDescriptor, BindGroupEntry, ShaderGraphProfile, UniformField, VertexAttributeDescriptor,
    VertexLayoutDescriptor
} from "./profiles";
export { GraphValidator } from "./validator";

// Typed WGSL struct system — single source of truth for uniform/storage layout.
export {
    arrayOf, f16, f32, i32, mat2x2f, mat2x4f, mat3x3f, mat3x4f, mat4x2f, mat4x3f, mat4x4f,
    u32, vec2f, vec2i, vec2u, vec3f, vec3i, vec3u, vec4f, vec4i, vec4u, wgsl
} from "./wgsl-struct";
export type { StructView, WgslFieldLayout, WgslStruct, WgslType } from "./wgsl-struct";
export {
    assertWgslStructMatches, compareStruct, parseWgslStructs, wgslTypeFromString
} from "./wgsl-struct-validator";
export type { ParsedWgslField, ParsedWgslStruct, StructMismatch } from "./wgsl-struct-validator";

// Compute graph
export { ComputeGraphCompiler } from "./compute-compiler";
export type { ComputeCompileOptions, ComputeCompileResult } from "./compute-compiler";
export { ComputeGraph } from "./compute-graph";
export type {
    ComputeDispatchConfig,
    ComputeGraphConnection,
    StorageBufferDecl,
    StructField,
    UniformBufferDecl
} from "./compute-graph";
export {
    COMPUTE_PROFILE_REGISTRY,
    getComputeProfile,
    PARTICLE_COMPUTE_PROFILE,
    SIMPLE_COMPUTE_PROFILE,
    TEXTURE_COMPUTE_PROFILE,
    VOLUMETRIC_COMPUTE_PROFILE
} from "./compute-profiles";
export type { ComputeProfile } from "./compute-profiles";

