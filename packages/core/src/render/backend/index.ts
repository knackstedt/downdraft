// ============================================================================
// Backend Module — barrel export for the rendering backend abstraction layer
// ============================================================================

export type {
    BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendCommandBuffer, BackendCommandEncoder, BackendComputePassEncoder, BackendPipelineLayout, BackendQueue, BackendRenderPassEncoder, BackendRenderPipeline, BackendSampler,
    BackendShaderModule, BackendTexture, BackendTextureView, BackendType, BindGroupDescriptor, BindGroupEntry, BindGroupLayoutDescriptor, BindGroupLayoutEntry, BlendComponent, BlendFactor,
    BlendOperation, BlendState, BufferDescriptor, BufferUsageFlags, ColorTargetState, ColorWriteFlags, CompareFunction, CullMode, DepthStencilState, FrontFace, IndexFormat, LoadOp, PipelineLayoutDescriptor, PrimitiveTopology, RenderPassColorAttachment,
    RenderPassDepthStencilAttachment,
    RenderPassDescriptor, RenderPipelineDescriptor, SamplerDescriptor, ShaderStageFlags, StencilFaceState, StencilOperation, StoreOp, TextureDescriptor, TextureFormat, TextureUsageFlags, TextureViewDescriptor, VertexAttribute,
    VertexBufferLayout,
    VertexFormat
} from "./types.ts";

export {
    BUFFER_USAGE_COPY_DST, BUFFER_USAGE_COPY_SRC, BUFFER_USAGE_INDEX, BUFFER_USAGE_INDIRECT, BUFFER_USAGE_MAP_READ,
    BUFFER_USAGE_MAP_WRITE, BUFFER_USAGE_NONE, BUFFER_USAGE_QUERY_RESOLVE, BUFFER_USAGE_STORAGE, BUFFER_USAGE_UNIFORM, BUFFER_USAGE_VERTEX, COLOR_WRITE_ALL, COLOR_WRITE_ALPHA, COLOR_WRITE_BLUE, COLOR_WRITE_GREEN, COLOR_WRITE_RED, SHADER_STAGE_COMPUTE, SHADER_STAGE_FRAGMENT, SHADER_STAGE_NONE,
    SHADER_STAGE_VERTEX, TEXTURE_USAGE_COPY_DST, TEXTURE_USAGE_COPY_SRC, TEXTURE_USAGE_NONE, TEXTURE_USAGE_RENDER_ATTACHMENT, TEXTURE_USAGE_STORAGE_BINDING, TEXTURE_USAGE_TEXTURE_BINDING
} from "./types.ts";

export { createWebGL2Capabilities, createWebGPUCapabilities } from "./capabilities.ts";
export type { BackendCapabilities } from "./capabilities.ts";

export { dualShader, glslShader, hasShaderVariant, wgslShader } from "./shader-source.ts";
export type { ShaderLanguage, ShaderSource } from "./shader-source.ts";

export {
    fromWebGPUFormat, getFormatInfo, getWebGL2FallbackFormat, getWebGL2FormatMapping, isCompressedFormat, isDepthFormat, isFilterableFormat,
    isRenderableFormat,
    toWebGPUFormat
} from "./format-mapping.ts";
export type { FormatInfo, WebGL2FormatMapping } from "./format-mapping.ts";

export { createBackend, detectBackends } from "./render-backend.ts";
export type { BackendCreateOptions, RenderBackend, SurfaceConfiguration } from "./render-backend.ts";

export { getShaderSource, getTranspiler, registerShader, transpileShader } from "./shader-registry.ts";
export { ShaderTranspiler } from "./shader-transpiler.ts";
export type { TranspileResult } from "./shader-transpiler.ts";

export { WebGL2Backend } from "./webgl2/webgl2-backend.ts";
export type { WebGL2BackendInitOptions } from "./webgl2/webgl2-backend.ts";
export { WebGL2CommandBuffer, WebGL2CommandEncoder, WebGL2ComputePassEncoder, WebGL2RenderPassEncoder } from "./webgl2/webgl2-encoders.ts";
export type { Command as WebGL2Command } from "./webgl2/webgl2-encoders.ts";
export { WebGL2Queue } from "./webgl2/webgl2-queue.ts";
export { WebGL2BindGroup, WebGL2BindGroupLayout, WebGL2Buffer, WebGL2PipelineLayout, WebGL2RenderPipeline, WebGL2Sampler, WebGL2ShaderModule, WebGL2Texture, WebGL2TextureView } from "./webgl2/webgl2-resources.ts";

