// ============================================================================
// Backend Capabilities — queryable feature support for the active backend.
// Used by render passes to degrade gracefully when features are unavailable
// (e.g. compute shaders on WebGL2).
// ============================================================================

import type { BackendType, TextureFormat } from "./types.ts";
import { getFormatInfo, isFilterableFormat } from "./format-mapping.ts";

export interface BackendCapabilities {
  /** Which backend is active. */
  readonly backend: BackendType;

  // ─── Core Feature Flags ──────────────────────────────────────────────────

  /** Compute shaders are available (WebGPU: yes, WebGL2: no). */
  readonly computeShaders: boolean;
  /** Storage buffers are available (WebGPU: yes, WebGL2: rarely via extension). */
  readonly storageBuffers: boolean;
  /** GPU timestamp queries for profiling. */
  readonly timestampQueries: boolean;
  /** Float color buffer rendering (HDR). Requires EXT_color_buffer_float on WebGL2. */
  readonly floatRenderTargets: boolean;
  /** Half-float color buffer rendering. */
  readonly halfFloatRenderTargets: boolean;
  /** Depth comparison samplers (sampler_comparison / sampler2DShadow). */
  readonly comparisonSamplers: boolean;
  /** BC texture compression support. */
  readonly bcCompression: boolean;
  /** Anisotropic filtering support. */
  readonly anisotropicFiltering: boolean;
  /** Multiple render targets (MRT) — required for deferred rendering. */
  readonly multipleRenderTargets: boolean;
  /** Instanced rendering support. */
  readonly instancing: boolean;
  /** Uniform buffer objects. */
  readonly uniformBuffers: boolean;
  /** Transform feedback (not used currently, but may be useful for fallback). */
  readonly transformFeedback: boolean;

  // ─── Limits ──────────────────────────────────────────────────────────────

  readonly maxTextureSize: number;
  readonly maxTextureArrayLayers: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBindGroups: number;
  readonly maxVertexBuffers: number;
  readonly maxVertexAttributes: number;
  readonly maxColorAttachments: number;
  readonly maxUniformBuffersPerShaderStage: number;
  readonly maxSampledTexturesPerShaderStage: number;
  readonly maxSamplersPerShaderStage: number;

  // ─── Engine-Specific Limits ──────────────────────────────────────────────

  /** Maximum point lights supported by the lighting system. */
  readonly maxPointLights: number;
  /** Maximum spot lights supported by the lighting system. */
  readonly maxSpotLights: number;
  /** Maximum particles supported by the particle system. */
  readonly maxParticles: number;
  /** Maximum shadow map resolution. */
  readonly maxShadowMapSize: number;

  // ─── Query Methods ───────────────────────────────────────────────────────

  /** Check if a texture format is supported. */
  isFormatSupported(format: TextureFormat): boolean;
  /** Check if a texture format can be used as a render attachment. */
  isFormatRenderable(format: TextureFormat): boolean;
  /** Check if a texture format supports linear filtering. */
  isFormatFilterable(format: TextureFormat): boolean;
}

// ─── WebGPU Capabilities ───────────────────────────────────────────────────

export function createWebGPUCapabilities(device: GPUDevice, adapter: GPUAdapter | null): BackendCapabilities {
  const features = device.features;
  const limits = device.limits;

  return {
    backend: "webgpu",
    computeShaders: true,
    storageBuffers: true,
    timestampQueries: features.has("timestamp-query"),
    floatRenderTargets: features.has("float32-filterable"),
    halfFloatRenderTargets: true,
    comparisonSamplers: true,
    bcCompression: adapter?.features.has("texture-compression-bc") ?? false,
    anisotropicFiltering: true,
    multipleRenderTargets: true,
    instancing: true,
    uniformBuffers: true,
    transformFeedback: false,

    maxTextureSize: limits.maxTextureDimension2D,
    maxTextureArrayLayers: limits.maxTextureArrayLayers,
    maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxBindGroups: limits.maxBindGroups,
    maxVertexBuffers: limits.maxVertexBuffers,
    maxVertexAttributes: limits.maxVertexAttributes,
    maxColorAttachments: limits.maxColorAttachments,
    maxUniformBuffersPerShaderStage: limits.maxUniformBuffersPerShaderStage,
    maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
    maxSamplersPerShaderStage: limits.maxSamplersPerShaderStage,

    maxPointLights: 32,
    maxSpotLights: 8,
    maxParticles: 10000,
    maxShadowMapSize: 2048,

    isFormatSupported: (format: TextureFormat) => true, // WebGPU supports all our formats
    isFormatRenderable: (format: TextureFormat) => getFormatInfo(format).renderable,
    isFormatFilterable: (format: TextureFormat) => isFilterableFormat(format),
  };
}

// ─── WebGL2 Capabilities ───────────────────────────────────────────────────

export function createWebGL2Capabilities(gl: WebGL2RenderingContext): BackendCapabilities {
  const extColorBufferFloat = gl.getExtension("EXT_color_buffer_float");
  const extColorBufferHalfFloat = gl.getExtension("EXT_color_buffer_half_float");
  const extTextureFilterAnisotropic = gl.getExtension("EXT_texture_filter_anisotropic");
  const extCompressedTextureS3tc = gl.getExtension("WEBGL_compressed_texture_s3tc");
  const extCompressedTextureS3tcSrgb = gl.getExtension("WEBGL_compressed_texture_s3tc_srgb");
  const extShaderStorageBuffer = gl.getExtension("EXT_shader_storage_buffer_object");

  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const maxTextureArrayLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
  const maxUniformBlockBindings = gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) as number;
  const maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number;
  const maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) as number;

  return {
    backend: "webgl2",
    computeShaders: false,
    storageBuffers: !!extShaderStorageBuffer,
    timestampQueries: false,
    floatRenderTargets: !!extColorBufferFloat,
    halfFloatRenderTargets: !!extColorBufferHalfFloat || !!extColorBufferFloat,
    comparisonSamplers: true, // sampler2DShadow is core in WebGL2
    bcCompression: !!(extCompressedTextureS3tc || extCompressedTextureS3tcSrgb),
    anisotropicFiltering: !!extTextureFilterAnisotropic,
    multipleRenderTargets: maxColorAttachments >= 4,
    instancing: true, // Core in WebGL2
    uniformBuffers: true, // Core in WebGL2
    transformFeedback: true, // Core in WebGL2

    maxTextureSize,
    maxTextureArrayLayers,
    maxUniformBufferBindingSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
    maxStorageBufferBindingSize: extShaderStorageBuffer ? (gl.getParameter(0x90DD) as number) : 0, // GL_MAX_SHADER_STORAGE_BLOCK_SIZE
    maxBindGroups: Math.min(maxUniformBlockBindings, 4), // Map bind groups to UBO binding points
    maxVertexBuffers: 16, // WebGL2 supports up to 16 vertex attributes
    maxVertexAttributes: maxVertexAttribs,
    maxColorAttachments,
    maxUniformBuffersPerShaderStage: maxUniformBlockBindings,
    maxSampledTexturesPerShaderStage: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
    maxSamplersPerShaderStage: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,

    // Reduced limits for WebGL2
    maxPointLights: 8,
    maxSpotLights: 4,
    maxParticles: 1000,
    maxShadowMapSize: 1024,

    isFormatSupported: (format: TextureFormat) => {
      const info = getFormatInfo(format);
      if (info.compressed && !extCompressedTextureS3tc && !extCompressedTextureS3tcSrgb) return false;
      if (format === "rgba16float" || format === "rg16float" || format === "r16float") {
        return !!extColorBufferHalfFloat || !!extColorBufferFloat;
      }
      if (format === "rgba32float" || format === "rg32float" || format === "r32float") {
        return !!extColorBufferFloat;
      }
      if (format === "bgra8unorm") return false; // Not natively supported in WebGL2
      return true;
    },
    isFormatRenderable: (format: TextureFormat) => {
      const info = getFormatInfo(format);
      if (!info.renderable) return false;
      if (format === "rgba16float" || format === "rg16float" || format === "r16float") {
        return !!extColorBufferHalfFloat || !!extColorBufferFloat;
      }
      if (format === "rgba32float" || format === "rg32float" || format === "r32float") {
        return !!extColorBufferFloat;
      }
      if (format === "bgra8unorm") return false;
      return true;
    },
    isFormatFilterable: (format: TextureFormat) => {
      if (format === "rgba32float" || format === "rg32float" || format === "r32float") {
        return !!gl.getExtension("OES_texture_float_linear");
      }
      return isFilterableFormat(format);
    },
  };
}
