import { describe, expect, it, vi } from "bun:test";
import type { RenderBackend } from "./backend/render-backend.ts";
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
} from "./backend/types.ts";
import { IBLSystem } from "./ibl.ts";
import { PBRSystem } from "./pbr.ts";

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

describe("PBRSystem backend-agnostic", () => {
  it("creates resources via backend when device is null", () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    expect(backend.createTexture).toHaveBeenCalled();
    expect(backend.createSampler).toHaveBeenCalled();
    expect(backend.createBindGroupLayout).toHaveBeenCalled();
    expect(backend.createBindGroup).toHaveBeenCalled();
  });

  it("creates texture with rgba16float format and correct usage flags", () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    const texDesc = (backend.createTexture as any).mock.calls[0][0];
    expect(texDesc.format).toBe("rgba16float");
    expect(texDesc.size).toEqual([256, 256]);
  });

  it("creates bind group layout with fragment visibility for texture and sampler", () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    const layoutDesc = (backend.createBindGroupLayout as any).mock.calls[0][0];
    expect(layoutDesc.entries).toHaveLength(2);
    expect(layoutDesc.entries[0].binding).toBe(0);
    expect(layoutDesc.entries[0].visibility).toBe(2); // FRAGMENT
    expect(layoutDesc.entries[0].texture).toBeDefined();
    expect(layoutDesc.entries[1].binding).toBe(1);
    expect(layoutDesc.entries[1].visibility).toBe(2); // FRAGMENT
    expect(layoutDesc.entries[1].sampler).toBeDefined();
  });

  it("getBindGroupLayout returns backend bind group layout", () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    const layout = pbr.getBindGroupLayout();
    expect(layout).not.toBeNull();
  });

  it("getBindGroup returns backend bind group", () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    const bg = pbr.getBindGroup();
    expect(bg).not.toBeNull();
  });

  it("uses backend queue for writeTexture in generateLUTAsync", async () => {
    const backend = createMockBackend();
    const pbr = new PBRSystem(null, backend);
    pbr.init();

    // Wait for the async LUT generation to complete (uses setTimeout internally)
    // Give extra time beyond the default 5s timeout
    await pbr.lutReady;

    expect((backend.queue as any).writeTexture).toHaveBeenCalled();
  }, 15000);

  it("still works with GPUDevice when provided", () => {
    const mockDevice = {
      createTexture: vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() })),
      createSampler: vi.fn(() => ({})),
      createBindGroupLayout: vi.fn(() => ({})),
      createBindGroup: vi.fn(() => ({})),
      queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
    } as unknown as GPUDevice;

    // GPUTextureUsage and GPUShaderStage may not be defined in test env
    // The PBRSystem init() uses them directly — we need to stub them
    (globalThis as any).GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x08 };
    (globalThis as any).GPUShaderStage = { FRAGMENT: 0x10 };

    const pbr = new PBRSystem(mockDevice, null);
    pbr.init();

    expect(mockDevice.createTexture).toHaveBeenCalled();
    expect(mockDevice.createSampler).toHaveBeenCalled();

    // Cleanup
    delete (globalThis as any).GPUTextureUsage;
    delete (globalThis as any).GPUShaderStage;
  });
});

describe("IBLSystem backend-agnostic", () => {
  it("constructs with null device and backend without throwing", () => {
    const backend = createMockBackend();
    expect(() => new IBLSystem(null, {}, backend)).not.toThrow();
  });

  it("init() is a no-op on backend (no compute support)", () => {
    const backend = createMockBackend();
    const ibl = new IBLSystem(null, {}, backend);
    ibl.init();
    // init should not create any resources on backend
    expect(backend.createBuffer).not.toHaveBeenCalled();
    expect(backend.createTexture).not.toHaveBeenCalled();
  });

  it("captureFromSkyDome skips on backend (no compute)", () => {
    const backend = createMockBackend();
    const ibl = new IBLSystem(null, {}, backend);
    ibl.init();

    // Should return early without throwing
    expect(() => ibl.captureFromSkyDome({} as any)).not.toThrow();
  });

  it("isReady returns false when no environment is captured", () => {
    const backend = createMockBackend();
    const ibl = new IBLSystem(null, {}, backend);
    ibl.init();

    expect(ibl.isReady()).toBe(false);
  });

  it("getBindGroupLayout returns null on backend", () => {
    const backend = createMockBackend();
    const ibl = new IBLSystem(null, {}, backend);
    ibl.init();

    expect(ibl.getBindGroupLayout()).toBeNull();
  });

  it("destroy does not throw on backend", () => {
    const backend = createMockBackend();
    const ibl = new IBLSystem(null, {}, backend);
    ibl.init();
    expect(() => ibl.destroy()).not.toThrow();
  });
});
