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
import { ParticleSystem } from "./particle-system";

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

const mockCamera = {
  position: [0, 0, 0] as [number, number, number],
  yaw: 0, pitch: 0, fov: 75, aspect: 1,
  near: 0.1, far: 1000, viewportW: 800, viewportH: 600,
  projectionMatrix: new Float32Array(16),
  viewMatrix: new Float32Array(16),
};

describe("ParticleSystem backend-agnostic", () => {
  it("constructs with null device and backend without throwing", () => {
    const backend = createMockBackend();
    expect(() => new ParticleSystem(null, "bgra8unorm", backend)).not.toThrow();
  });

  it("init creates render pipeline only (no compute) via backend", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    expect(backend.createRenderPipeline).toHaveBeenCalled();
    expect(backend.createShaderModule).toHaveBeenCalled();
  });

  it("init does not create compute pipelines on backend", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    // On backend, no compute pipeline should be created
    // We verify by checking that createBindGroupLayout was called only once (render only)
    const layoutCalls = (backend.createBindGroupLayout as any).mock.calls;
    expect(layoutCalls.length).toBe(1); // Only render bind group layout
  });

  it("init creates buffers with correct usage flags", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    const bufferCalls = (backend.createBuffer as any).mock.calls;
    expect(bufferCalls.length).toBeGreaterThanOrEqual(5);

    // Particle buffer: STORAGE | COPY_DST
    expect(bufferCalls[0][0].usage).toBe(0x80 | 0x08);
    // Sim param buffer: UNIFORM | COPY_DST
    expect(bufferCalls[1][0].usage).toBe(0x40 | 0x08);
  });

  it("init creates render bind group layout with VERTEX|FRAGMENT and VERTEX visibility", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    const layoutCalls = (backend.createBindGroupLayout as any).mock.calls;
    const renderLayout = layoutCalls[0][0];
    expect(renderLayout.entries[0].visibility).toBe(1 | 2); // VERTEX | FRAGMENT
    expect(renderLayout.entries[1].visibility).toBe(1); // VERTEX
  });

  it("init writes initial buffer data via backend queue", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    expect((backend.queue as any).writeBuffer).toHaveBeenCalled();
  });

  it("render does not throw on backend", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    const mockPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    };

    expect(() => ps.render(mockPass as any, mockCamera as any, 0, 0.5)).not.toThrow();
  });

  it("render calls setPipeline and draw on backend", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    const mockPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
    };

    ps.render(mockPass as any, mockCamera as any, 0, 0.5);

    expect(mockPass.setPipeline).toHaveBeenCalled();
    expect(mockPass.draw).toHaveBeenCalled();
  });

  it("tick is a no-op on backend (no compute pipeline)", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();

    const mockEncoder = {
      beginComputePass: vi.fn(),
    };

    // Should return early because computePipeline is null
    ps.tick(mockEncoder as any, 0.016, mockCamera as any, 0, 0, 0, null);

    expect(mockEncoder.beginComputePass).not.toHaveBeenCalled();
  });

  it("destroy does not throw on backend", async () => {
    const backend = createMockBackend();
    const ps = new ParticleSystem(null, "bgra8unorm", backend);
    await ps.init();
    expect(() => ps.destroy()).not.toThrow();
  });
});
