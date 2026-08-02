// ============================================================================
// Backend Module — barrel export for the rendering backend abstraction layer
// ============================================================================

export type {
  BackendType,
  TextureFormat,
  IndexFormat,
  PrimitiveTopology,
  CullMode,
  FrontFace,
  CompareFunction,
  StencilOperation,
  BlendFactor,
  BlendOperation,
  LoadOp,
  StoreOp,
  ShaderStageFlags,
  BufferUsageFlags,
  TextureUsageFlags,
  ColorWriteFlags,
  BufferDescriptor,
  TextureDescriptor,
  SamplerDescriptor,
  VertexAttribute,
  VertexBufferLayout,
  VertexFormat,
  BlendComponent,
  BlendState,
  ColorTargetState,
  DepthStencilState,
  StencilFaceState,
  RenderPipelineDescriptor,
  BindGroupLayoutEntry,
  BindGroupLayoutDescriptor,
  BindGroupEntry,
  BindGroupDescriptor,
  PipelineLayoutDescriptor,
  RenderPassColorAttachment,
  RenderPassDepthStencilAttachment,
  RenderPassDescriptor,
  BackendBuffer,
  BackendTexture,
  TextureViewDescriptor,
  BackendTextureView,
  BackendSampler,
  BackendShaderModule,
  BackendBindGroupLayout,
  BackendPipelineLayout,
  BackendBindGroup,
  BackendRenderPipeline,
  BackendCommandEncoder,
  BackendCommandBuffer,
  BackendRenderPassEncoder,
  BackendComputePassEncoder,
  BackendQueue,
} from "./types.ts";

export {
  SHADER_STAGE_NONE,
  SHADER_STAGE_VERTEX,
  SHADER_STAGE_FRAGMENT,
  SHADER_STAGE_COMPUTE,
  BUFFER_USAGE_NONE,
  BUFFER_USAGE_MAP_READ,
  BUFFER_USAGE_MAP_WRITE,
  BUFFER_USAGE_COPY_SRC,
  BUFFER_USAGE_COPY_DST,
  BUFFER_USAGE_INDEX,
  BUFFER_USAGE_VERTEX,
  BUFFER_USAGE_UNIFORM,
  BUFFER_USAGE_STORAGE,
  BUFFER_USAGE_INDIRECT,
  BUFFER_USAGE_QUERY_RESOLVE,
  TEXTURE_USAGE_NONE,
  TEXTURE_USAGE_COPY_SRC,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_TEXTURE_BINDING,
  TEXTURE_USAGE_STORAGE_BINDING,
  TEXTURE_USAGE_RENDER_ATTACHMENT,
  COLOR_WRITE_RED,
  COLOR_WRITE_GREEN,
  COLOR_WRITE_BLUE,
  COLOR_WRITE_ALPHA,
  COLOR_WRITE_ALL,
} from "./types.ts";

export type { BackendCapabilities } from "./capabilities.ts";
export { createWebGPUCapabilities, createWebGL2Capabilities } from "./capabilities.ts";

export type { ShaderSource, ShaderLanguage } from "./shader-source.ts";
export { wgslShader, dualShader, glslShader, hasShaderVariant } from "./shader-source.ts";

export {
  getFormatInfo,
  isDepthFormat,
  isCompressedFormat,
  isFilterableFormat,
  isRenderableFormat,
  toWebGPUFormat,
  fromWebGPUFormat,
  getWebGL2FormatMapping,
  getWebGL2FallbackFormat,
} from "./format-mapping.ts";
export type { FormatInfo, WebGL2FormatMapping } from "./format-mapping.ts";

export type { RenderBackend, SurfaceConfiguration, BackendCreateOptions } from "./render-backend.ts";
export { createBackend, detectBackends } from "./render-backend.ts";
