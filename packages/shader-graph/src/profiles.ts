// ============================================================================
// Shader Graph Profile — configures the compiler for a specific render context
// ============================================================================

// Shader stage visibility flags — mirror GPUShaderStage values to avoid runtime WebGPU dependency
const SHADER_STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4,
} as const;

export interface BindGroupEntry {
  binding: number;
  visibility: number;
  type: "uniform" | "storage-read" | "storage-write" | "texture-2d" | "texture-cube" | "sampler";
  label?: string;
}

export interface BindGroupDescriptor {
  group: number;
  entries: BindGroupEntry[];
}

export interface VertexAttributeDescriptor {
  location: number;
  name: string;
  format: "float32x3" | "float32x2" | "float32x4" | "uint32x4";
  offset: number;
}

export interface VertexLayoutDescriptor {
  stride: number;
  attributes: VertexAttributeDescriptor[];
}

export interface UniformField {
  name: string;
  type: string;
}

export interface ShaderGraphProfile {
  name: string;
  // WGSL chunks to inject at the top of the shader (e.g. PBR functions, light structs)
  chunks: string[];
  // Uniform struct fields for group 0 binding 0
  uniformFields: UniformField[];
  // Additional bind groups beyond group 0 binding 0
  bindGroups: BindGroupDescriptor[];
  // Vertex layout
  vertexLayout: VertexLayoutDescriptor;
  // Whether this profile supports instancing (adds instance_index builtin)
  instanced: boolean;
  // Whether this profile supports skinning (adds bone matrix storage buffer)
  skinned: boolean;
  // Max bones for skinning
  maxBones?: number;
  // Fragment output format (GPUTextureFormat as string, e.g. "bgra8unorm").
  // For single-target profiles. When outputFormats is set, this is ignored
  // (kept for backward compatibility with existing profiles).
  outputFormat: string;
  // Multi-render-target output formats (deferred GBuffer). When set, the
  // compiler emits a fragment main returning a struct with one @location per
  // target. The graph's output nodes map to surface properties (albedo,
  // normal, roughness, metallic, emissive) rather than a final color.
  outputFormats?: string[];
  // Names of the output targets, parallel to outputFormats. Used by the
  // compiler to map graph output nodes to @location indices. Standard names:
  // "albedo", "normal", "metallicEmissive", "velocity".
  outputNames?: string[];
  // Depth format (GPUTextureFormat as string, e.g. "depth32float")
  depthFormat: string;
  // Whether depth write is enabled
  depthWriteEnabled: boolean;
  // Blend mode
  blend: "opaque" | "transparent" | "additive";
  // Topology
  topology: "triangle-list" | "line-list" | "point-list";
  // Additional WGSL code to inject before the vertex/fragment functions
  preMain?: string;
}

// --- Built-in profiles ---

export const SIMPLE_PROFILE: ShaderGraphProfile = {
  name: "simple",
  chunks: [],
  uniformFields: [
    { name: "viewProj", type: "mat4x4<f32>" },
    { name: "modelMatrix", type: "mat4x4<f32>" },
    { name: "cameraPos", type: "vec3<f32>" },
    { name: "time", type: "f32" },
  ],
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
        { binding: 1, visibility: SHADER_STAGE.FRAGMENT, type: "texture-2d", label: "albedoMap" },
        { binding: 2, visibility: SHADER_STAGE.FRAGMENT, type: "sampler", label: "albedoSampler" },
      ],
    },
  ],
  vertexLayout: {
    stride: 32,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
      { location: 2, name: "uv", format: "float32x2", offset: 24 },
    ],
  },
  instanced: false,
  skinned: false,
  outputFormat: "bgra8unorm",
  depthFormat: "depth32float",
  depthWriteEnabled: true,
  blend: "opaque",
  topology: "triangle-list",
};

export const PBR_PROFILE: ShaderGraphProfile = {
  name: "pbr",
  chunks: ["pbr_lighting", "qrotate"],
  uniformFields: [
    { name: "viewProj", type: "mat4x4<f32>" },
    { name: "cameraPos", type: "vec3<f32>" },
    { name: "time", type: "f32" },
    { name: "entityPos", type: "vec3<f32>" },
    { name: "entityScale", type: "f32" },
    { name: "entityRot", type: "vec4<f32>" },
    { name: "entityType", type: "u32" },
    { name: "entityFlags", type: "u32" },
    { name: "wetness", type: "f32" },
    { name: "_pad3", type: "f32" },
    { name: "sunDirIntensity", type: "vec4<f32>" },
    { name: "ambientParams", type: "vec4<f32>" },
    { name: "fogColor", type: "vec4<f32>" },
  ],
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
      ],
    },
    {
      group: 1,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "lightData" },
      ],
    },
    {
      group: 2,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "texture-2d", label: "brdfLUT" },
        { binding: 1, visibility: SHADER_STAGE.FRAGMENT, type: "sampler", label: "brdfSampler" },
      ],
    },
  ],
  vertexLayout: {
    stride: 24,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
    ],
  },
  instanced: false,
  skinned: false,
  outputFormat: "bgra8unorm",
  depthFormat: "depth32float",
  depthWriteEnabled: true,
  blend: "opaque",
  topology: "triangle-list",
};

export const PBR_TEXTURED_PROFILE: ShaderGraphProfile = {
  ...PBR_PROFILE,
  name: "pbr-textured",
  vertexLayout: {
    stride: 32,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
      { location: 2, name: "uv", format: "float32x2", offset: 24 },
    ],
  },
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
      ],
    },
    {
      group: 1,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "lightData" },
      ],
    },
    {
      group: 2,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "texture-2d", label: "brdfLUT" },
        { binding: 1, visibility: SHADER_STAGE.FRAGMENT, type: "sampler", label: "brdfSampler" },
      ],
    },
    // Bindless material binding model (@group(3)): material SSBO + texture arrays.
    // The host sets this bind group once per frame; per-draw material selection
    // is via materialIndex in the uniform struct.
    {
      group: 3,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "bindlessMaterials" },
      ],
    },
  ],
};

export const PBR_SKINNED_PROFILE: ShaderGraphProfile = {
  ...PBR_TEXTURED_PROFILE,
  name: "pbr-skinned",
  skinned: true,
  maxBones: 256,
  vertexLayout: {
    stride: 72,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
      { location: 2, name: "uv", format: "float32x2", offset: 24 },
      { location: 3, name: "color", format: "float32x3", offset: 32 },
      { location: 4, name: "joints", format: "uint32x4", offset: 48 },
      { location: 5, name: "weights", format: "float32x4", offset: 64 },
    ],
  },
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
        { binding: 3, visibility: SHADER_STAGE.VERTEX, type: "storage-read", label: "boneMatrices" },
      ],
    },
    {
      group: 1,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "lightData" },
      ],
    },
    {
      group: 2,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "texture-2d", label: "brdfLUT" },
        { binding: 1, visibility: SHADER_STAGE.FRAGMENT, type: "sampler", label: "brdfSampler" },
      ],
    },
    {
      group: 3,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "bindlessMaterials" },
      ],
    },
  ],
};

export const PBR_INSTANCED_PROFILE: ShaderGraphProfile = {
  name: "pbr-instanced",
  chunks: ["dynamic_lights", "pbr_functions", "pbr_bindings", "qrotate"],
  uniformFields: [
    { name: "viewProj", type: "mat4x4<f32>" },
    { name: "cameraPos", type: "vec3<f32>" },
    { name: "time", type: "f32" },
    { name: "sunDirIntensity", type: "vec4<f32>" },
    { name: "ambientParams", type: "vec4<f32>" },
    { name: "fogColor", type: "vec4<f32>" },
  ],
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
        { binding: 1, visibility: SHADER_STAGE.VERTEX, type: "storage-read", label: "instances" },
      ],
    },
    {
      group: 1,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "storage-read", label: "lightData" },
      ],
    },
    {
      group: 2,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.FRAGMENT, type: "texture-2d", label: "brdfLUT" },
        { binding: 1, visibility: SHADER_STAGE.FRAGMENT, type: "sampler", label: "brdfSampler" },
      ],
    },
  ],
  vertexLayout: {
    stride: 24,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
    ],
  },
  instanced: true,
  skinned: false,
  outputFormat: "bgra8unorm",
  depthFormat: "depth32float",
  depthWriteEnabled: true,
  blend: "opaque",
  topology: "triangle-list",
};

export const PBR_COLOR_VERTEX_PROFILE: ShaderGraphProfile = {
  ...PBR_PROFILE,
  name: "pbr-color-vertex",
  vertexLayout: {
    stride: 36,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
      { location: 2, name: "color", format: "float32x3", offset: 24 },
    ],
  },
};

// ============================================================================
// GBUFFER_PROFILE — deferred rendering surface shader (multi-render-target)
// ============================================================================
// The graph compiles a *surface* shader that writes 4 GBuffer targets:
//   @location(0) albedo (RGB) + AO (A)        — vec4
//   @location(1) normal (RGB) + roughness (A) — vec4
//   @location(2) metallic (R) + emissive (GBA)— vec4
//   @location(3) velocity (screen-space motion)— vec2
// The graph's output nodes use names: "albedo", "normal", "metallicEmissive",
// "velocity". Lighting is applied in a separate deferred-lighting pass.
export const GBUFFER_PROFILE: ShaderGraphProfile = {
  name: "gbuffer",
  chunks: ["pbr_functions", "qrotate"],
  uniformFields: [
    { name: "viewProj", type: "mat4x4<f32>" },
    { name: "prevViewProj", type: "mat4x4<f32>" },
    { name: "modelMatrix", type: "mat4x4<f32>" },
    { name: "prevModelMatrix", type: "mat4x4<f32>" },
    { name: "cameraPos", type: "vec3<f32>" },
    { name: "time", type: "f32" },
  ],
  bindGroups: [
    {
      group: 0,
      entries: [
        { binding: 0, visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT, type: "uniform" },
      ],
    },
  ],
  vertexLayout: {
    stride: 32,
    attributes: [
      { location: 0, name: "position", format: "float32x3", offset: 0 },
      { location: 1, name: "normal", format: "float32x3", offset: 12 },
      { location: 2, name: "uv", format: "float32x2", offset: 24 },
    ],
  },
  instanced: false,
  skinned: false,
  outputFormat: "bgra8unorm", // ignored when outputFormats is set
  outputFormats: ["bgra8unorm", "bgra8unorm", "bgra8unorm", "rg16float"],
  outputNames: ["albedo", "normal", "metallicEmissive", "velocity"],
  depthFormat: "depth32float",
  depthWriteEnabled: true,
  blend: "opaque",
  topology: "triangle-list",
};

export const PROFILE_REGISTRY: Record<string, ShaderGraphProfile> = {
  simple: SIMPLE_PROFILE,
  pbr: PBR_PROFILE,
  "pbr-textured": PBR_TEXTURED_PROFILE,
  "pbr-skinned": PBR_SKINNED_PROFILE,
  "pbr-instanced": PBR_INSTANCED_PROFILE,
  "pbr-color-vertex": PBR_COLOR_VERTEX_PROFILE,
  "gbuffer": GBUFFER_PROFILE,
};

export function getProfile(name: string): ShaderGraphProfile | undefined {
  return PROFILE_REGISTRY[name];
}
