import { describe, expect, it, vi } from "bun:test";
import { RenderPass, type RenderPassContext } from "./render-pass.ts";
import { PassType, type FrameGraphBuilder, type GraphRenderContext } from "./frame-graph.ts";
import type { RenderBackend } from "./backend/render-backend.ts";
import type { BackendTexture, BackendTextureView, TextureFormat } from "./backend/types.ts";

function createMockBackend(): RenderBackend {
  return {
    type: "webgl2",
    capabilities: {
      backend: "webgl2",
      computeShaders: false,
      storageBuffers: false,
      timestampQueries: false,
      floatRenderTargets: false,
      halfFloatRenderTargets: false,
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
    getSurfaceFormat: vi.fn(() => "rgba8unorm" as TextureFormat),
    reconfigureSurface: vi.fn(),
    createBuffer: vi.fn(),
    createTexture: vi.fn(() => ({ getNative: vi.fn(), destroy: vi.fn() }) as unknown as BackendTexture),
    createSampler: vi.fn(),
    createShaderModule: vi.fn(),
    createBindGroupLayout: vi.fn(),
    createPipelineLayout: vi.fn(),
    createBindGroup: vi.fn(),
    createRenderPipeline: vi.fn(),
    createCommandEncoder: vi.fn(),
    createTextureView: vi.fn(() => ({ getNative: vi.fn() }) as unknown as BackendTextureView),
    queue: {
      submit: vi.fn(),
      writeBuffer: vi.fn(),
      writeTexture: vi.fn(),
      copyExternalImageToTexture: vi.fn(),
      onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
      getNative: vi.fn(),
    },
    destroy: vi.fn(),
    onDeviceLost: vi.fn(),
    getNativeDevice: vi.fn(() => null),
  } as unknown as RenderBackend;
}

class TestPass extends RenderPass {
  name = "test-pass";
  passType: PassType = PassType.Render;
  prepareFn = vi.fn();
  executeFn = vi.fn();
  setupFn = vi.fn();
  destroyFn = vi.fn();

  prepare(device: GPUDevice, backend?: RenderBackend | null): void {
    this.prepareFn(device, backend);
  }

  setup(builder: FrameGraphBuilder): void {
    this.setupFn(builder);
  }

  execute(ctx: GraphRenderContext): void {
    this.executeFn(ctx);
  }

  destroy(): void {
    this.destroyFn();
  }
}

class TestCustomPass extends TestPass {
  passType: PassType = PassType.Custom;
}

describe("RenderPass", () => {
  describe("prepare()", () => {
    it("receives device as first argument", () => {
      const pass = new TestPass();
      const device = {} as GPUDevice;
      pass.prepare(device);
      expect(pass.prepareFn).toHaveBeenCalledWith(device, undefined);
    });

    it("receives backend as optional second argument", () => {
      const pass = new TestPass();
      const device = {} as GPUDevice;
      const backend = createMockBackend();
      pass.prepare(device, backend);
      expect(pass.prepareFn).toHaveBeenCalledWith(device, backend);
    });

    it("accepts null backend", () => {
      const pass = new TestPass();
      const device = {} as GPUDevice;
      pass.prepare(device, null);
      expect(pass.prepareFn).toHaveBeenCalledWith(device, null);
    });

    it("accepts null device with backend (WebGL2 path)", () => {
      const pass = new TestPass();
      const backend = createMockBackend();
      pass.prepare(null as unknown as GPUDevice, backend);
      expect(pass.prepareFn).toHaveBeenCalledWith(null, backend);
    });
  });

  describe("setup()", () => {
    it("default setup is a no-op that does not throw", () => {
      const pass = new TestPass();
      const builder = {
        colorAttachments: [],
        depthAttachmentDesc: null,
        colorAttachment: vi.fn(),
        depthAttachment: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        reads: new Set<number>(),
        writes: new Set<number>(),
      };
      expect(() => pass.setup(builder as unknown as FrameGraphBuilder)).not.toThrow();
    });

    it("calls custom setup function", () => {
      const pass = new TestPass();
      const builder = {
        colorAttachments: [],
        depthAttachmentDesc: null,
        colorAttachment: vi.fn(),
        depthAttachment: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        reads: new Set<number>(),
        writes: new Set<number>(),
      };
      pass.setup(builder as unknown as FrameGraphBuilder);
      expect(pass.setupFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("execute()", () => {
    it("calls custom execute function with context", () => {
      const pass = new TestPass();
      const ctx = {} as GraphRenderContext;
      pass.execute(ctx);
      expect(pass.executeFn).toHaveBeenCalledWith(ctx);
    });
  });

  describe("destroy()", () => {
    it("default destroy is a no-op", () => {
      const pass = new TestPass();
      expect(() => pass.destroy()).not.toThrow();
    });

    it("calls custom destroy function", () => {
      const pass = new TestPass();
      pass.destroy();
      expect(pass.destroyFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("passType", () => {
    it("defaults to Render type", () => {
      const pass = new TestPass();
      expect(pass.passType).toBe(PassType.Render);
    });

    it("can be set to Custom type", () => {
      const pass = new TestCustomPass();
      expect(pass.passType).toBe(PassType.Custom);
    });
  });
});

describe("RenderPassContext", () => {
  it("accepts nullable device field", () => {
    const ctx: RenderPassContext = {
      device: null,
      backend: null,
      pass: {} as GPURenderPassEncoder,
    };
    expect(ctx.device).toBeNull();
  });

  it("accepts nullable backend field", () => {
    const ctx: RenderPassContext = {
      device: null,
      backend: null,
      pass: {} as GPURenderPassEncoder,
    };
    expect(ctx.backend).toBeNull();
  });

  it("accepts both device and backend (WebGPU path)", () => {
    const backend = createMockBackend();
    const device = {} as GPUDevice;
    const ctx: RenderPassContext = {
      device,
      backend,
      pass: {} as GPURenderPassEncoder,
    };
    expect(ctx.device).toBe(device);
    expect(ctx.backend).toBe(backend);
  });

  it("accepts backend only (WebGL2 path)", () => {
    const backend = createMockBackend();
    const ctx: RenderPassContext = {
      device: null,
      backend,
      pass: {} as GPURenderPassEncoder,
    };
    expect(ctx.device).toBeNull();
    expect(ctx.backend).toBe(backend);
  });
});
