import { describe, expect, it, vi } from "bun:test";
import type { RenderBackend } from "./backend/render-backend.ts";
import type {
    BackendCommandEncoder,
    BackendRenderPassEncoder,
    BackendTextureView,
    TextureFormat,
} from "./backend/types.ts";
import { RenderPipeline, type RenderContext } from "./render-pipeline.ts";

function createMockBackend(): RenderBackend {
  const mockEncoder: BackendCommandEncoder = {
    beginRenderPass: vi.fn(() => ({} as BackendRenderPassEncoder)),
    beginComputePass: vi.fn(),
    copyBufferToBuffer: vi.fn(),
    copyBufferToTexture: vi.fn(),
    copyTextureToBuffer: vi.fn(),
    copyTextureToTexture: vi.fn(),
    finish: vi.fn(() => ({ getNative: () => null })),
    getNative: vi.fn(),
  };

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
    createTexture: vi.fn(),
    createSampler: vi.fn(),
    createShaderModule: vi.fn(),
    createBindGroupLayout: vi.fn(),
    createPipelineLayout: vi.fn(),
    createBindGroup: vi.fn(),
    createRenderPipeline: vi.fn(),
    createCommandEncoder: vi.fn(() => mockEncoder),
    createTextureView: vi.fn(),
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

function createMockContext(backend: RenderBackend): RenderContext {
  return {
    backend,
    backendEncoder: backend.createCommandEncoder(),
    backendPassEncoder: {} as BackendRenderPassEncoder,
    surfaceView: {} as BackendTextureView,
    depthView: {} as BackendTextureView,
    surfaceFormat: "rgba8unorm" as TextureFormat,
    depthFormat: "depth24plus" as TextureFormat,
    device: null,
    encoder: null,
    passEncoder: null,
    camera: {
      position: [0, 0, 0],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 60,
      near: 0.1,
      far: 1000,
      aspect: 1,
    },
    viewport: { x: 0, y: 0, w: 800, h: 600 },
    viewportIdx: 0,
    viewportCount: 1,
    dt: 0.016,
    elapsedTime: 0,
    isFirstViewport: true,
    isLastViewport: true,
  };
}

describe("RenderContext", () => {
  it("includes backend-agnostic fields", () => {
    const backend = createMockBackend();
    const ctx = createMockContext(backend);
    expect(ctx.backend).toBeDefined();
    expect(ctx.backend.type).toBe("webgl2");
    expect(ctx.backendEncoder).toBeDefined();
    expect(ctx.backendPassEncoder).toBeDefined();
    expect(ctx.surfaceView).toBeDefined();
    expect(ctx.depthView).toBeDefined();
    expect(ctx.surfaceFormat).toBe("rgba8unorm");
    expect(ctx.depthFormat).toBe("depth24plus");
  });

  it("allows null for native WebGPU fields when using WebGL2", () => {
    const backend = createMockBackend();
    const ctx = createMockContext(backend);
    expect(ctx.device).toBeNull();
    expect(ctx.encoder).toBeNull();
    expect(ctx.passEncoder).toBeNull();
  });
});

describe("RenderContext — WebGPU backend", () => {
  it("populates native WebGPU fields when device is provided", () => {
    const mockDevice = { label: "mock-device" } as unknown as GPUDevice;
    const mockEncoder = { label: "mock-encoder" } as unknown as GPUCommandEncoder;
    const mockPassEncoder = { label: "mock-pass" } as unknown as GPURenderPassEncoder;

    const backend = createMockBackend();
    (backend as any).type = "webgpu";

    const ctx: RenderContext = {
      backend,
      backendEncoder: backend.createCommandEncoder(),
      backendPassEncoder: {} as BackendRenderPassEncoder,
      surfaceView: {} as BackendTextureView,
      depthView: {} as BackendTextureView,
      surfaceFormat: "bgra8unorm" as TextureFormat,
      depthFormat: "depth32float" as TextureFormat,
      device: mockDevice,
      encoder: mockEncoder,
      passEncoder: mockPassEncoder,
      camera: {
        position: [0, 0, 0],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: 60,
        near: 0.1,
        far: 1000,
        aspect: 1,
      },
      viewport: { x: 0, y: 0, w: 800, h: 600 },
      viewportIdx: 0,
      viewportCount: 1,
      dt: 0.016,
      elapsedTime: 0,
      isFirstViewport: true,
      isLastViewport: true,
    };

    expect(ctx.device).toBe(mockDevice);
    expect(ctx.encoder).toBe(mockEncoder);
    expect(ctx.passEncoder).toBe(mockPassEncoder);
    expect(ctx.backend.type).toBe("webgpu");
    expect(ctx.surfaceFormat).toBe("bgra8unorm");
    expect(ctx.depthFormat).toBe("depth32float");
  });

  it("supports both backend and native fields simultaneously (WebGPU)", () => {
    const backend = createMockBackend();
    (backend as any).type = "webgpu";
    const ctx = createMockContext(backend);
    // When using WebGPU, both sets of fields should be usable
    expect(ctx.backend).toBeDefined();
    expect(ctx.backendEncoder).toBeDefined();
    expect(ctx.surfaceFormat).toBeDefined();
    // Native fields can also be populated by GameRenderer
    ctx.device = { label: "gpu" } as unknown as GPUDevice;
    expect(ctx.device).not.toBeNull();
    expect(ctx.backend).not.toBeNull();
  });
});

describe("RenderPipeline", () => {
  it("executes registered passes with backend-agnostic context", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque", "transparent", "ui"]);

    const renderFn = vi.fn();
    pipeline.registerPass("opaque", "opaque-pass", renderFn);

    const backend = createMockBackend();
    const ctx = createMockContext(backend);
    pipeline.render(ctx);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledWith(ctx);
  });

  it("passes backend field through to render callbacks", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    let capturedBackend: RenderBackend | null = null;
    pipeline.registerPass("opaque", "test-pass", (ctx) => {
      capturedBackend = ctx.backend;
    });

    const backend = createMockBackend();
    const ctx = createMockContext(backend);
    pipeline.render(ctx);

    expect(capturedBackend).toBe(backend);
  });

  it("maintains slot ordering with backend context", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b", "c"]);

    const order: string[] = [];
    pipeline.registerPass("c", "pass-c", () => order.push("c"));
    pipeline.registerPass("a", "pass-a", () => order.push("a"));
    pipeline.registerPass("b", "pass-b", () => order.push("b"));

    const backend = createMockBackend();
    const ctx = createMockContext(backend);
    pipeline.render(ctx);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("unregisterPass removes passes", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn1);
    pipeline.registerPass("opaque", "pass2", fn2);
    pipeline.unregisterPass("pass1");

    const backend = createMockBackend();
    pipeline.render(createMockContext(backend));

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("clear removes all passes", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn);
    pipeline.clear();

    const backend = createMockBackend();
    pipeline.render(createMockContext(backend));

    expect(fn).not.toHaveBeenCalled();
  });

  it("getEntries returns sorted entries", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b", "c"]);

    pipeline.registerPass("c", "pass-c", vi.fn());
    pipeline.registerPass("a", "pass-a", vi.fn());
    pipeline.registerPass("b", "pass-b", vi.fn());

    const entries = pipeline.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].slot).toBe("a");
    expect(entries[1].slot).toBe("b");
    expect(entries[2].slot).toBe("c");
  });

  it("getEntries caches sorted order until dirty", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b"]);

    pipeline.registerPass("a", "pass-a", vi.fn());
    const entries1 = pipeline.getEntries();
    const entries2 = pipeline.getEntries();
    expect(entries1).toBe(entries2); // Same reference (cached)
  });

  it("supports multiple passes in the same slot", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    pipeline.registerPass("opaque", "pass1", fn1);
    pipeline.registerPass("opaque", "pass2", fn2);

    const backend = createMockBackend();
    pipeline.render(createMockContext(backend));

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("passes with unknown slots get order after known slots", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["a", "b"]);

    const order: string[] = [];
    pipeline.registerPass("b", "pass-b", () => order.push("b"));
    pipeline.registerPass("unknown", "pass-unknown", () => order.push("unknown"));
    pipeline.registerPass("a", "pass-a", () => order.push("a"));

    const backend = createMockBackend();
    pipeline.render(createMockContext(backend));

    expect(order).toEqual(["a", "b", "unknown"]);
  });

  it("RenderPassEntry has correct structure", () => {
    const pipeline = new RenderPipeline();
    pipeline.setSlotOrder(["opaque"]);

    const renderFn = vi.fn();
    pipeline.registerPass("opaque", "my-pass", renderFn);

    const entries = pipeline.getEntries();
    expect(entries[0].slot).toBe("opaque");
    expect(entries[0].name).toBe("my-pass");
    expect(entries[0].render).toBe(renderFn);
    expect(typeof entries[0].order).toBe("number");
  });
});
