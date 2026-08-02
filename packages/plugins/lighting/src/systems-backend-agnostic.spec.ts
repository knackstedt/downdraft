import type { RenderBackend } from "@downdraft/core/render/backend/render-backend";
import type {
    BackendBindGroup,
    BackendBindGroupLayout,
    BackendBuffer,
    BackendCommandBuffer,
    BackendCommandEncoder,
    BackendRenderPassEncoder,
    BackendRenderPipeline,
    BackendSampler,
    BackendShaderModule,
    BackendTexture,
    BackendTextureView,
    BindGroupDescriptor,
    BindGroupLayoutDescriptor,
    BufferDescriptor,
    PipelineLayoutDescriptor,
    RenderPassDescriptor,
    RenderPipelineDescriptor,
    SamplerDescriptor,
    TextureDescriptor,
    TextureViewDescriptor,
} from "@downdraft/core/render/backend/types";
import { describe, expect, it, vi } from "bun:test";
import { LightSystem } from "./light-system";

function createMockBackend(): RenderBackend {
  const createBuffer = vi.fn((desc: BufferDescriptor) => ({ size: desc.size, usage: desc.usage, getNative: () => ({}), destroy: vi.fn() }) as unknown as BackendBuffer);
  const createTexture = vi.fn((desc: TextureDescriptor) => ({ getNative: () => ({}), destroy: vi.fn(), createView: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendTextureView) }) as unknown as BackendTexture);
  const createTextureView = vi.fn((_tex: BackendTexture, _desc?: TextureViewDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendTextureView);
  const createSampler = vi.fn((_desc: SamplerDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendSampler);
  const createShaderModule = vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendShaderModule);
  const createBindGroupLayout = vi.fn((_desc: BindGroupLayoutDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendBindGroupLayout);
  const createPipelineLayout = vi.fn((_desc: PipelineLayoutDescriptor) => ({ getNative: () => ({}) }) as unknown as { getNative: () => unknown });
  const createBindGroup = vi.fn((_desc: BindGroupDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendBindGroup);
  const createRenderPipeline = vi.fn((_desc: RenderPipelineDescriptor) => ({ getNative: () => ({}) }) as unknown as BackendRenderPipeline);

  const passEncoder = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    setViewport: vi.fn(),
    setScissorRect: vi.fn(),
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    end: vi.fn(),
    getNative: () => ({}),
  } as unknown as BackendRenderPassEncoder;

  const commandBuffer = { getNative: () => ({}) } as unknown as BackendCommandBuffer;
  const encoder = {
    beginRenderPass: vi.fn((_desc: RenderPassDescriptor) => passEncoder),
    beginComputePass: vi.fn(),
    copyBufferToBuffer: vi.fn(),
    copyBufferToTexture: vi.fn(),
    copyTextureToBuffer: vi.fn(),
    copyTextureToTexture: vi.fn(),
    finish: vi.fn(() => commandBuffer),
    getNative: () => ({}),
  } as unknown as BackendCommandEncoder;

  const createCommandEncoder = vi.fn(() => encoder);

  const queue = {
    submit: vi.fn(),
    writeBuffer: vi.fn(),
    writeTexture: vi.fn(),
    copyExternalImageToTexture: vi.fn(),
    onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
    getNative: () => ({}),
  };

  return {
    type: "webgl2",
    capabilities: {
      backend: "webgl2",
      computeShaders: false,
      storageBuffers: false,
      timestampQueries: false,
      floatRenderTargets: true,
      halfFloatRenderTargets: true,
      comparisonSamplers: true,
      bcCompression: false,
      anisotropicFiltering: false,
      multipleRenderTargets: true,
      instancing: true,
      uniformBuffers: true,
      transformFeedback: true,
      maxTextureSize: 4096,
      maxTextureArrayLayers: 256,
      maxUniformBufferBindingSize: 16384,
      maxStorageBufferBindingSize: 0,
      maxBindGroups: 4,
      maxVertexBuffers: 16,
      maxVertexAttributes: 16,
      maxColorAttachments: 4,
      maxUniformBuffersPerShaderStage: 24,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxPointLights: 8,
      maxSpotLights: 4,
      maxParticles: 1000,
      maxShadowMapSize: 1024,
      isFormatSupported: vi.fn(() => true),
      isFormatRenderable: vi.fn(() => true),
      isFormatFilterable: vi.fn(() => true),
    },
    configureSurface: vi.fn(),
    getCurrentSurfaceTexture: vi.fn(() => null),
    getSurfaceFormat: vi.fn(() => "rgba8unorm"),
    reconfigureSurface: vi.fn(),
    createBuffer,
    createTexture,
    createSampler,
    createShaderModule,
    createBindGroupLayout,
    createPipelineLayout,
    createBindGroup,
    createRenderPipeline,
    createCommandEncoder,
    createTextureView,
    destroy: vi.fn(),
    onDeviceLost: vi.fn(),
    getNativeDevice: vi.fn(() => null),
    queue,
  } as unknown as RenderBackend;
}

describe("LightSystem backend-agnostic", () => {
  it("constructs with null device and backend without throwing", () => {
    const backend = createMockBackend();
    expect(() => new LightSystem(null, backend)).not.toThrow();
  });

  it("init creates storage buffer and bind group via backend", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    expect(backend.createBuffer).toHaveBeenCalled();
    expect(backend.createBindGroupLayout).toHaveBeenCalled();
    expect(backend.createBindGroup).toHaveBeenCalled();
  });

  it("init creates buffer with STORAGE | COPY_DST usage flags", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    const bufDesc = (backend.createBuffer as any).mock.calls[0][0];
    expect(bufDesc.usage).toBe(0x80 | 0x08); // STORAGE | COPY_DST
  });

  it("init creates bind group layout with FRAGMENT visibility", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    const layoutDesc = (backend.createBindGroupLayout as any).mock.calls[0][0];
    expect(layoutDesc.entries[0].visibility).toBe(2); // FRAGMENT
    expect(layoutDesc.entries[0].buffer.type).toBe("read-only-storage");
  });

  it("init writes initial data via backend queue", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    expect((backend.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("getLightBindGroup returns backend bind group", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    expect(ls.getLightBindGroup()).not.toBeNull();
  });

  it("getLightBindGroupLayout returns backend bind group layout", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    expect(ls.getLightBindGroupLayout()).not.toBeNull();
  });

  it("upload writes to backend queue", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();

    // Clear mock from init
    (backend.queue as any).writeBuffer.mockClear();
    ls.upload([0, 0, 0]);

    expect((backend.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("initDebugGizmos creates debug pipeline via backend", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");

    expect(backend.createRenderPipeline).toHaveBeenCalled();
    expect(backend.createShaderModule).toHaveBeenCalled();
  });

  it("initDebugGizmos creates vertex/index/instance/uniform buffers", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");

    // Should have created multiple buffers: sphere verts, index, instance, uniform
    expect((backend.createBuffer as any).mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("renderDebugGizmos does not throw on backend", () => {
    const backend = createMockBackend();
    const ls = new LightSystem(null, backend);
    ls.init();
    ls.initDebugGizmos("bgra8unorm");
    ls.showDebugGizmos = true;

    const mockPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      drawIndexed: vi.fn(),
    };

    expect(() => ls.renderDebugGizmos(mockPass as any, {
      position: [0, 0, 0], yaw: 0, pitch: 0, fov: 75, aspect: 1,
      near: 0.1, far: 1000, viewportW: 800, viewportH: 600,
      projectionMatrix: new Float32Array(16), viewMatrix: new Float32Array(16),
    } as any)).not.toThrow();
  });

  it("still works with GPUDevice when provided", () => {
    (globalThis as any).GPUBufferUsage = { STORAGE: 0x80, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, UNIFORM: 0x40 };
    (globalThis as any).GPUShaderStage = { VERTEX: 0x20, FRAGMENT: 0x10, COMPUTE: 0x04 };

    const mockDevice = {
      createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
      createBindGroupLayout: vi.fn(() => ({})),
      createBindGroup: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      createRenderPipeline: vi.fn(() => ({})),
      createPipelineLayout: vi.fn(() => ({})),
      queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;

    const ls = new LightSystem(mockDevice, null);
    ls.init();

    expect(mockDevice.createBuffer).toHaveBeenCalled();
    expect(mockDevice.createBindGroupLayout).toHaveBeenCalled();

    delete (globalThis as any).GPUBufferUsage;
    delete (globalThis as any).GPUShaderStage;
  });
});
