import { describe, expect, it, vi } from "bun:test";
import type { RenderBackend } from "../backend/render-backend.ts";
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
} from "../backend/types.ts";
import { PassType, type GraphRenderContext, type TextureHandle } from "../frame-graph.ts";
import { LUT3DPass } from "./lut3d.ts";
import { MotionBlurPass } from "./motion-blur.ts";
import { PostProcessPass } from "./post-process.ts";
import { ShadowPass } from "./shadow.ts";
import { SSAOPass } from "./ssao.ts";
import { SSRPass } from "./ssr.ts";

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

function makeMockDevice(): unknown {
  return {
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
    createBindGroup: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({
        setPipeline: () => {},
        setBindGroup: () => {},
        setVertexBuffer: () => {},
        setIndexBuffer: () => {},
        draw: () => {},
        drawIndexed: () => {},
        end: () => {},
      }),
      copyTextureToTexture: () => {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: () => {},
      writeTexture: () => {},
      submit: () => {},
    },
  };
}

function makeMockGraphCtx(backend: RenderBackend): GraphRenderContext {
  const mockView = { getNative: () => ({}) } as unknown as BackendTextureView;
  return {
    backend,
    device: null,
    getView: () => ({}) as GPUTextureView,
    getBackendView: () => mockView,
    getBackendTexture: () => ({ getNative: () => ({}) }) as unknown as BackendTexture,
    getTexture: () => ({}) as GPUTexture,
    addDrawCalls: vi.fn(),
    addTriangles: vi.fn(),
  } as unknown as GraphRenderContext;
}

describe("Backend-agnostic pass execution", () => {
  describe("MotionBlurPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createSampler).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createRenderPipeline).toHaveBeenCalled();
    });

    it("execute uses backend path when ctx.backend is set", () => {
      const pass = new MotionBlurPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.colorHandle = 1 as unknown as TextureHandle;
      pass.outputHandle = 2 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });

    it("execute falls back to device path when no backend", () => {
      const device = makeMockDevice() as GPUDevice;
      const pass = new MotionBlurPass(device);
      // Mock GPUBufferUsage globals (not available in bun:test)
      const mockUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, TEXTURE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x80, STORAGE: 0x80 };
      const originalGPUBufferUsage = (globalThis as unknown as { GPUBufferUsage?: unknown }).GPUBufferUsage;
      const originalGPUTextureUsage = (globalThis as unknown as { GPUTextureUsage?: unknown }).GPUTextureUsage;
      (globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockUsage;
      (globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockUsage;
      try {
        pass.prepare(device);
        pass.colorHandle = 1 as unknown as TextureHandle;
        pass.outputHandle = 2 as unknown as TextureHandle;
        const ctx = {
          device,
          backend: null,
          getView: () => ({}),
          addDrawCalls: vi.fn(),
          addTriangles: vi.fn(),
        } as unknown as GraphRenderContext;
        pass.execute(ctx);
      } finally {
        if (originalGPUBufferUsage !== undefined) {
          (globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = originalGPUBufferUsage;
        } else {
          delete (globalThis as unknown as { GPUBufferUsage?: unknown }).GPUBufferUsage;
        }
        if (originalGPUTextureUsage !== undefined) {
          (globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = originalGPUTextureUsage;
        } else {
          delete (globalThis as unknown as { GPUTextureUsage?: unknown }).GPUTextureUsage;
        }
      }
    });
  });

  describe("SSAOPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createSampler).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createRenderPipeline).toHaveBeenCalled();
    });

    it("execute uses backend path when ctx.backend is set", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.depthHandle = 1 as unknown as TextureHandle;
      pass.outputHandle = 2 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });

    it("setProjectionMatrices uses backend queue when available", () => {
      const pass = new SSAOPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.setProjectionMatrices(new Float32Array(16), new Float32Array(16), new Float32Array(16), 800, 600);
      expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });
  });

  describe("SSRPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createSampler).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createRenderPipeline).toHaveBeenCalled();
    });

    it("execute uses backend path when ctx.backend is set", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.colorHandle = 1 as unknown as TextureHandle;
      pass.depthHandle = 2 as unknown as TextureHandle;
      pass.outputHandle = 3 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });

    it("setProjectionMatrices uses backend queue when available", () => {
      const pass = new SSRPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.setProjectionMatrices(new Float32Array(16), new Float32Array(16), new Float32Array(16));
      expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });
  });

  describe("LUT3DPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createSampler).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createRenderPipeline).toHaveBeenCalled();
    });

    it("setLUT uses backend path when backend is set", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      const lutData = new Uint8Array(32 * 32 * 32 * 4);
      pass.setLUT(lutData, 32);
      expect(backend.createTexture).toHaveBeenCalled();
      expect(backend.createTextureView).toHaveBeenCalled();
      expect(backend.queue.writeTexture).toHaveBeenCalled();
    });

    it("execute uses backend path when ctx.backend is set", () => {
      const pass = new LUT3DPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      const lutData = new Uint8Array(32 * 32 * 32 * 4);
      pass.setLUT(lutData, 32);
      pass.inputHandle = 1 as unknown as TextureHandle;
      pass.outputHandle = 2 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });
  });

  describe("ShadowPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createTexture).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createShaderModule).toHaveBeenCalled();
    });

    it("setLightViewProj uses backend queue when available", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      const mat = new Float32Array(16);
      pass.setLightViewProj(mat as unknown as import("wgpu-matrix").Mat4);
      expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });

    it("setModelMatrix uses backend queue when available", () => {
      const pass = new ShadowPass(makeMockDevice() as GPUDevice);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      const mat = new Float32Array(16);
      pass.setModelMatrix(mat as unknown as import("wgpu-matrix").Mat4);
      expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });
  });

  describe("PostProcessPass", () => {
    it("prepareBackend creates backend resources", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(backend.createSampler).toHaveBeenCalled();
      expect(backend.createBuffer).toHaveBeenCalled();
      expect(backend.createBindGroupLayout).toHaveBeenCalled();
      expect(backend.createRenderPipeline).toHaveBeenCalled();
      // Should create intermediate textures
      expect(backend.createTexture).toHaveBeenCalled();
      expect(backend.createTextureView).toHaveBeenCalled();
    });

    it("updateUniforms uses backend queue when available", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.setSettings({ exposure: 2.0 });
      expect(backend.queue.writeBuffer).toHaveBeenCalled();
    });

    it("execute uses backend path when ctx.backend is set", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.hdrHandle = 1 as unknown as TextureHandle;
      pass.surfaceHandle = 2 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      ctx.bloomEnabled = false;
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });

    it("execute with bloom enabled calls backend bloom path", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      pass.hdrHandle = 1 as unknown as TextureHandle;
      pass.surfaceHandle = 2 as unknown as TextureHandle;
      const ctx = makeMockGraphCtx(backend);
      ctx.bloomEnabled = true;
      pass.execute(ctx);
      expect(backend.createCommandEncoder).toHaveBeenCalled();
      expect(backend.queue.submit).toHaveBeenCalled();
    });

    it("resize recreates backend intermediate textures", () => {
      const pass = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      const initialCreateCount = (backend.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;
      pass.resize(1024, 768);
      const finalCreateCount = (backend.createTexture as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(finalCreateCount).toBeGreaterThan(initialCreateCount);
    });
  });

  describe("Pass type consistency", () => {
    it("all passes maintain their passType after backend prepare", () => {
      const backend = createMockBackend();
      const motionBlur = new MotionBlurPass(makeMockDevice() as GPUDevice);
      motionBlur.prepare(null as unknown as GPUDevice, backend);
      expect(motionBlur.passType).toBe(PassType.Custom);

      const ssao = new SSAOPass(makeMockDevice() as GPUDevice);
      ssao.prepare(null as unknown as GPUDevice, backend);
      expect(ssao.passType).toBe(PassType.Custom);

      const ssr = new SSRPass(makeMockDevice() as GPUDevice);
      ssr.prepare(null as unknown as GPUDevice, backend);
      expect(ssr.passType).toBe(PassType.Custom);

      const lut3d = new LUT3DPass(makeMockDevice() as GPUDevice);
      lut3d.prepare(null as unknown as GPUDevice, backend);
      expect(lut3d.passType).toBe(PassType.Custom);

      const shadow = new ShadowPass(makeMockDevice() as GPUDevice);
      shadow.prepare(null as unknown as GPUDevice, backend);
      expect(shadow.passType).toBe(PassType.Custom);

      const postProcess = new PostProcessPass(makeMockDevice() as GPUDevice, "bgra8unorm", 800, 600);
      postProcess.prepare(null as unknown as GPUDevice, backend);
      expect(postProcess.passType).toBe(PassType.Custom);
    });
  });
});
