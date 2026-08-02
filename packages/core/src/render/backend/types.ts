// ============================================================================
// Backend Types — backend-agnostic GPU abstraction types
// These mirror the WebGPU API surface but allow for alternative backends
// (e.g. WebGL2). Each backend implementation wraps its native objects
// behind these interfaces.
// ============================================================================

// ─── Enums (string unions for debuggability) ──────────────────────────────

export type BackendType = "webgpu" | "webgl2";

export type TextureFormat =
  | "rgba8unorm"
  | "rgba8snorm"
  | "bgra8unorm"
  | "rgba16float"
  | "rg16float"
  | "r16float"
  | "rgba32float"
  | "rg32float"
  | "r32float"
  | "depth32float"
  | "depth16unorm"
  | "depth24plus"
  | "depth24plus-stencil8"
  | "bc1-rgba-unorm"
  | "bc2-rgba-unorm"
  | "bc3-rgba-unorm"
  | "bc4-r-unorm"
  | "bc5-rg-unorm"
  | "bc6h-rgb-ufloat"
  | "bc7-rgba-unorm";

export type IndexFormat = "uint16" | "uint32";

export type PrimitiveTopology =
  | "point-list"
  | "line-list"
  | "line-strip"
  | "triangle-list"
  | "triangle-strip";

export type CullMode = "none" | "front" | "back";
export type FrontFace = "ccw" | "cw";

export type CompareFunction =
  | "never"
  | "less"
  | "less-equal"
  | "greater"
  | "greater-equal"
  | "equal"
  | "not-equal"
  | "always";

export type StencilOperation =
  | "keep"
  | "zero"
  | "replace"
  | "invert"
  | "increment-clamp"
  | "decrement-clamp"
  | "increment-wrap"
  | "decrement-wrap";

export type BlendFactor =
  | "zero"
  | "one"
  | "src"
  | "one-minus-src"
  | "src-alpha"
  | "one-minus-src-alpha"
  | "dst"
  | "one-minus-dst"
  | "dst-alpha"
  | "one-minus-dst-alpha"
  | "src-alpha-saturated"
  | "constant"
  | "one-minus-constant";

export type BlendOperation =
  | "add"
  | "subtract"
  | "reverse-subtract"
  | "min"
  | "max";

export type LoadOp = "clear" | "load";
export type StoreOp = "store" | "discard";

export type ShaderStageFlags = number;
export const SHADER_STAGE_NONE: ShaderStageFlags = 0;
export const SHADER_STAGE_VERTEX: ShaderStageFlags = 1;
export const SHADER_STAGE_FRAGMENT: ShaderStageFlags = 2;
export const SHADER_STAGE_COMPUTE: ShaderStageFlags = 4;

// ─── Buffer Usage Flags ────────────────────────────────────────────────────

export type BufferUsageFlags = number;
export const BUFFER_USAGE_NONE: BufferUsageFlags = 0;
export const BUFFER_USAGE_MAP_READ: BufferUsageFlags = 1;
export const BUFFER_USAGE_MAP_WRITE: BufferUsageFlags = 2;
export const BUFFER_USAGE_COPY_SRC: BufferUsageFlags = 4;
export const BUFFER_USAGE_COPY_DST: BufferUsageFlags = 8;
export const BUFFER_USAGE_INDEX: BufferUsageFlags = 16;
export const BUFFER_USAGE_VERTEX: BufferUsageFlags = 32;
export const BUFFER_USAGE_UNIFORM: BufferUsageFlags = 64;
export const BUFFER_USAGE_STORAGE: BufferUsageFlags = 128;
export const BUFFER_USAGE_INDIRECT: BufferUsageFlags = 256;
export const BUFFER_USAGE_QUERY_RESOLVE: BufferUsageFlags = 512;

// ─── Texture Usage Flags ───────────────────────────────────────────────────

export type TextureUsageFlags = number;
export const TEXTURE_USAGE_NONE: TextureUsageFlags = 0;
export const TEXTURE_USAGE_COPY_SRC: TextureUsageFlags = 1;
export const TEXTURE_USAGE_COPY_DST: TextureUsageFlags = 2;
export const TEXTURE_USAGE_TEXTURE_BINDING: TextureUsageFlags = 4;
export const TEXTURE_USAGE_STORAGE_BINDING: TextureUsageFlags = 8;
export const TEXTURE_USAGE_RENDER_ATTACHMENT: TextureUsageFlags = 16;

// ─── Color Write Flags ─────────────────────────────────────────────────────

export type ColorWriteFlags = number;
export const COLOR_WRITE_RED: ColorWriteFlags = 1;
export const COLOR_WRITE_GREEN: ColorWriteFlags = 2;
export const COLOR_WRITE_BLUE: ColorWriteFlags = 4;
export const COLOR_WRITE_ALPHA: ColorWriteFlags = 8;
export const COLOR_WRITE_ALL: ColorWriteFlags = 15;

// ─── Resource Descriptors ──────────────────────────────────────────────────

export interface BufferDescriptor {
  label?: string;
  size: number;
  usage: BufferUsageFlags;
  mappedAtCreation?: boolean;
}

export interface TextureDescriptor {
  label?: string;
  size: [number, number, number] | [number, number] | number;
  format: TextureFormat;
  usage: TextureUsageFlags;
  sampleCount?: number;
  mipLevelCount?: number;
  dimension?: "1d" | "2d" | "3d";
}

export interface SamplerDescriptor {
  label?: string;
  addressModeU?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  addressModeV?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  addressModeW?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  magFilter?: "nearest" | "linear";
  minFilter?: "nearest" | "linear";
  mipmapFilter?: "nearest" | "linear";
  lodMinClamp?: number;
  lodMaxClamp?: number;
  compare?: CompareFunction;
  maxAnisotropy?: number;
}

export interface VertexAttribute {
  format: VertexFormat;
  offset: number;
  shaderLocation: number;
}

export interface VertexBufferLayout {
  arrayStride: number;
  stepMode?: "vertex" | "instance";
  attributes: VertexAttribute[];
}

export type VertexFormat =
  | "uint8x2"
  | "uint8x4"
  | "sint8x2"
  | "sint8x4"
  | "unorm8x2"
  | "unorm8x4"
  | "snorm8x2"
  | "snorm8x4"
  | "uint16x2"
  | "uint16x4"
  | "sint16x2"
  | "sint16x4"
  | "unorm16x2"
  | "unorm16x4"
  | "snorm16x2"
  | "snorm16x4"
  | "float16x2"
  | "float16x4"
  | "float32"
  | "float32x2"
  | "float32x3"
  | "float32x4"
  | "uint32"
  | "uint32x2"
  | "uint32x3"
  | "uint32x4"
  | "sint32"
  | "sint32x2"
  | "sint32x3"
  | "sint32x4";

export interface BlendComponent {
  operation?: BlendOperation;
  srcFactor?: BlendFactor;
  dstFactor?: BlendFactor;
}

export interface BlendState {
  color: BlendComponent;
  alpha: BlendComponent;
}

export interface ColorTargetState {
  format: TextureFormat;
  blend?: BlendState;
  writeMask?: ColorWriteFlags;
}

export interface DepthStencilState {
  format: TextureFormat;
  depthWriteEnabled: boolean;
  depthCompare: CompareFunction;
  stencilFront?: StencilFaceState;
  stencilBack?: StencilFaceState;
  stencilReadMask?: number;
  stencilWriteMask?: number;
  depthBias?: number;
  depthBiasSlopeScale?: number;
  depthBiasClamp?: number;
}

export interface StencilFaceState {
  compare: CompareFunction;
  failOp: StencilOperation;
  depthFailOp: StencilOperation;
  passOp: StencilOperation;
}

export interface RenderPipelineDescriptor {
  label?: string;
  vertex: {
    module: BackendShaderModule;
    entryPoint?: string;
    buffers?: VertexBufferLayout[];
  };
  fragment?: {
    module: BackendShaderModule;
    entryPoint?: string;
    targets: ColorTargetState[];
  };
  primitive?: {
    topology: PrimitiveTopology;
    stripIndexFormat?: IndexFormat;
    frontFace?: FrontFace;
    cullMode?: CullMode;
  };
  depthStencil?: DepthStencilState;
  multisample?: {
    count?: number;
    mask?: number;
    alphaToCoverageEnabled?: boolean;
  };
  layout?: "auto" | BackendPipelineLayout;
}

export interface BindGroupLayoutEntry {
  binding: number;
  visibility: ShaderStageFlags;
  buffer?: {
    type?: "uniform" | "storage" | "read-only-storage";
    hasDynamicOffset?: boolean;
    minBindingSize?: number;
  };
  sampler?: {
    type?: "filtering" | "non-filtering" | "comparison";
  };
  texture?: {
    sampleType?: "float" | "unfilterable-float" | "depth" | "sint" | "uint";
    viewDimension?: "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d";
    multisampled?: boolean;
  };
  storageTexture?: {
    access?: "write-only" | "read-only" | "read-write";
    format: TextureFormat;
    viewDimension?: "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d";
  };
}

export interface BindGroupLayoutDescriptor {
  label?: string;
  entries: BindGroupLayoutEntry[];
}

export interface BindGroupEntry {
  binding: number;
  resource:
    | { buffer: BackendBuffer; offset?: number; size?: number }
    | { sampler: BackendSampler }
    | { textureView: BackendTextureView }
    | { externalTexture: unknown };
}

export interface BindGroupDescriptor {
  label?: string;
  layout: BackendBindGroupLayout;
  entries: BindGroupEntry[];
}

export interface PipelineLayoutDescriptor {
  label?: string;
  bindGroupLayouts: BackendBindGroupLayout[];
}

// ─── Render Pass Attachment Descriptors ────────────────────────────────────

export interface RenderPassColorAttachment {
  view: BackendTextureView;
  depthSlice?: number;
  resolveTarget?: BackendTextureView | null;
  loadOp: LoadOp;
  storeOp: StoreOp;
  clearValue?: { r: number; g: number; b: number; a: number };
}

export interface RenderPassDepthStencilAttachment {
  view: BackendTextureView;
  depthLoadOp: LoadOp;
  depthStoreOp: StoreOp;
  depthClearValue?: number;
  depthReadOnly?: boolean;
  stencilLoadOp?: LoadOp;
  stencilStoreOp?: StoreOp;
  stencilClearValue?: number;
  stencilReadOnly?: boolean;
}

export interface RenderPassDescriptor {
  label?: string;
  colorAttachments: RenderPassColorAttachment[];
  depthStencilAttachment?: RenderPassDepthStencilAttachment;
  occlusionQuerySet?: unknown;
  timestampWrites?: unknown;
}

// ─── Backend Resource Interfaces ───────────────────────────────────────────

export interface BackendBuffer {
  readonly size: number;
  readonly usage: BufferUsageFlags;
  readonly label: string | undefined;
  destroy(): void;
  getNative(): unknown;
}

export interface BackendTexture {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly format: TextureFormat;
  readonly usage: TextureUsageFlags;
  readonly sampleCount: number;
  readonly mipLevelCount: number;
  readonly label: string | undefined;
  createView(descriptor?: TextureViewDescriptor): BackendTextureView;
  destroy(): void;
  getNative(): unknown;
}

export interface TextureViewDescriptor {
  label?: string;
  format?: TextureFormat;
  dimension?: "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d";
  aspect?: "all" | "depth-only" | "stencil-only";
  baseMipLevel?: number;
  mipLevelCount?: number;
  baseArrayLayer?: number;
  arrayLayerCount?: number;
}

export interface BackendTextureView {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendSampler {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendShaderModule {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendBindGroupLayout {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendPipelineLayout {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendBindGroup {
  readonly label: string | undefined;
  getNative(): unknown;
}

export interface BackendRenderPipeline {
  readonly label: string | undefined;
  getNative(): unknown;
}

// ─── Command Recording Interfaces ──────────────────────────────────────────

export interface BackendCommandEncoder {
  beginRenderPass(descriptor: RenderPassDescriptor): BackendRenderPassEncoder;
  beginComputePass(descriptor?: { label?: string }): BackendComputePassEncoder;
  copyBufferToBuffer(
    source: BackendBuffer,
    sourceOffset: number,
    destination: BackendBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  copyBufferToTexture(
    source: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void;
  copyTextureToBuffer(
    source: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    destination: { buffer: BackendBuffer; offset: number; bytesPerRow: number; rowsPerImage?: number },
    copySize: [number, number, number] | [number, number] | number,
  ): void;
  copyTextureToTexture(
    source: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void;
  finish(): BackendCommandBuffer;
  getNative(): unknown;
}

export interface BackendCommandBuffer {
  getNative(): unknown;
}

export interface BackendRenderPassEncoder {
  setPipeline(pipeline: BackendRenderPipeline): void;
  setBindGroup(index: number, bindGroup: BackendBindGroup, dynamicOffsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: BackendBuffer, offset?: number): void;
  setIndexBuffer(buffer: BackendBuffer, format: IndexFormat, offset?: number): void;
  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number,
  ): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  setBlendColor(r: number, g: number, b: number, a: number): void;
  setStencilReference(reference: number): void;
  draw(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndexed(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void;
  drawIndexedIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void;
  end(): void;
  getNative(): unknown;
}

export interface BackendComputePassEncoder {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: BackendBindGroup, dynamicOffsets?: number[]): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  dispatchWorkgroupsIndirect(indirectBuffer: BackendBuffer, indirectOffset: number): void;
  end(): void;
  getNative(): unknown;
}

// ─── Queue Interface ───────────────────────────────────────────────────────

export interface BackendQueue {
  submit(commandBuffers: BackendCommandBuffer[]): void;
  writeBuffer(buffer: BackendBuffer, offset: number, data: BufferSource): void;
  writeTexture(
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    data: BufferSource,
    dataLayout: { offset: number; bytesPerRow: number; rowsPerImage?: number },
    size: [number, number, number] | [number, number] | number,
  ): void;
  copyExternalImageToTexture(
    source: { source: CanvasImageSource | OffscreenCanvas; flipY?: boolean },
    destination: { texture: BackendTexture; mipLevel: number; origin: [number, number, number] | [number, number] | number },
    copySize: [number, number, number] | [number, number] | number,
  ): void;
  onSubmittedWorkDone(): Promise<void>;
  getNative(): unknown;
}
