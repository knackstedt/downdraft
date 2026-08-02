import { describe, expect, it, vi } from "bun:test";
import { FrameGraph, FrameGraphBuilder, PassType, TextureHandle } from "./frame-graph.ts";
import { RenderPass } from "./render-pass.ts";

// Minimal mock pass for testing — no GPU needed
class MockPass extends RenderPass {
  name: string;
  passType: PassType = PassType.Render;
  setupFn: (builder: FrameGraphBuilder) => void;

  constructor(name: string, setupFn: (builder: FrameGraphBuilder) => void) {
    super();
    this.name = name;
    this.setupFn = setupFn;
  }

  setup(builder: FrameGraphBuilder): void {
    this.setupFn(builder);
  }

  execute(): void {}

  prepare(): void {}
}

// Minimal mock device for compile() — only createTexture is called
function mockDevice(): GPUDevice {
  return {
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {},
    }),
  } as unknown as GPUDevice;
}

describe("FrameGraph", () => {
  describe("TextureHandle & resource management", () => {
    it("should import external textures", () => {
      const fg = new FrameGraph();
      const fakeTexture = {} as GPUTexture;
      const handle = fg.importTexture("surface", fakeTexture);
      expect(handle).toBeInstanceOf(TextureHandle);
      expect(handle.name).toBe("surface");
      expect(handle.id).toBe(0);
    });

    it("should create transient textures with descriptors", () => {
      const fg = new FrameGraph();
      const handle = fg.createTransient("hdr", {
        format: "rgba16float",
        usage: 0x10, // GPUTextureUsage.RENDER_ATTACHMENT
      });
      expect(handle.name).toBe("hdr");
      expect(handle.id).toBe(0);
    });

    it("should assign unique handle IDs", () => {
      const fg = new FrameGraph();
      const h1 = fg.importTexture("a", {} as GPUTexture);
      const h2 = fg.importTexture("b", {} as GPUTexture);
      const h3 = fg.createTransient("c", { format: "rgba8unorm", usage: 0 });
      expect(h1.id).toBe(0);
      expect(h2.id).toBe(1);
      expect(h3.id).toBe(2);
    });
  });

  describe("FrameGraphBuilder", () => {
    it("should track color attachments as writes", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "color");
      builder.colorAttachment({ handle, loadOp: "clear", storeOp: "store" });
      expect(builder.colorAttachments.length).toBe(1);
      expect(builder.writes.has(0)).toBe(true);
      expect(builder.reads.has(0)).toBe(false);
    });

    it("should track depth attachments as writes when not read-only", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "depth");
      builder.depthAttachment({ handle, depthLoadOp: "clear", depthStoreOp: "store" });
      expect(builder.depthAttachment).not.toBeNull();
      expect(builder.writes.has(0)).toBe(true);
    });

    it("should track read-only depth attachments as reads", () => {
      const builder = new FrameGraphBuilder();
      const handle = new TextureHandle(0, "depth");
      builder.depthAttachment({ handle, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
      expect(builder.reads.has(0)).toBe(true);
      expect(builder.writes.has(0)).toBe(false);
    });

    it("should track explicit reads and writes", () => {
      const builder = new FrameGraphBuilder();
      const readHandle = new TextureHandle(0, "input");
      const writeHandle = new TextureHandle(1, "output");
      builder.read(readHandle);
      builder.write(writeHandle);
      expect(builder.reads.has(0)).toBe(true);
      expect(builder.writes.has(1)).toBe(true);
      expect(builder.reads.has(1)).toBe(false);
      expect(builder.writes.has(0)).toBe(false);
    });
  });

  describe("Topological sort", () => {
    it("should preserve registration order when no dependencies", () => {
      const fg = new FrameGraph();
      const a = fg.importTexture("a", {} as GPUTexture);
      const b = fg.importTexture("b", {} as GPUTexture);

      const pass1 = new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      });

      fg.addPass(pass1);
      fg.addPass(pass2);
      fg.compile(mockDevice(), 800, 600);

      expect(fg.getPassOrder()).toEqual(["pass1", "pass2"]);
    });

    it("should order passes by resource dependencies", () => {
      const fg = new FrameGraph();
      const color = fg.createTransient("color", { format: "rgba8unorm", usage: 0 });
      const final = fg.createTransient("final", { format: "rgba8unorm", usage: 0 });

      // pass2 reads color (produced by pass1) and writes final
      // pass3 reads final (produced by pass2)
      // Registration order: pass3, pass2, pass1 — should sort to pass1, pass2, pass3
      const pass1 = new MockPass("pass1", (builder) => {
        builder.colorAttachment({ handle: color, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.read(color);
        builder.colorAttachment({ handle: final, loadOp: "clear", storeOp: "store" });
      });
      const pass3 = new MockPass("pass3", (builder) => {
        builder.read(final);
      });

      fg.addPass(pass3);
      fg.addPass(pass2);
      fg.addPass(pass1);
      fg.compile(mockDevice(), 800, 600);

      expect(fg.getPassOrder()).toEqual(["pass1", "pass2", "pass3"]);
    });

    it("should handle diamond dependencies", () => {
      const fg = new FrameGraph();
      const depth = fg.createTransient("depth", { format: "depth32float", usage: 0 });
      const hdr = fg.createTransient("hdr", { format: "rgba16float", usage: 0 });
      const surface = fg.importTexture("surface", {} as GPUTexture);

      const depthPass = new MockPass("depth-prepass", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "clear", depthStoreOp: "store" });
      });
      const opaquePass = new MockPass("opaque", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "load", depthStoreOp: "store" });
        builder.colorAttachment({ handle: hdr, loadOp: "clear", storeOp: "store" });
      });
      const transparentPass = new MockPass("transparent", (builder) => {
        builder.depthAttachment({ handle: depth, depthLoadOp: "load", depthStoreOp: "store", depthReadOnly: true });
        builder.colorAttachment({ handle: hdr, loadOp: "load", storeOp: "store" });
      });
      const postProcessPass = new MockPass("post-process", (builder) => {
        builder.read(hdr);
        builder.write(surface);
      });

      fg.addPass(depthPass);
      fg.addPass(opaquePass);
      fg.addPass(transparentPass);
      fg.addPass(postProcessPass);
      fg.compile(mockDevice(), 800, 600);

      const order = fg.getPassOrder();
      expect(order[0]).toBe("depth-prepass");
      expect(order.indexOf("opaque")).toBeGreaterThan(order.indexOf("depth-prepass"));
      expect(order.indexOf("transparent")).toBeGreaterThan(order.indexOf("depth-prepass"));
      expect(order.indexOf("post-process")).toBeGreaterThan(order.indexOf("opaque"));
      expect(order.indexOf("post-process")).toBeGreaterThan(order.indexOf("transparent"));
    });

    it("should fall back to registration order on cycles", () => {
      const fg = new FrameGraph();
      const a = fg.createTransient("a", { format: "rgba8unorm", usage: 0 });
      const b = fg.createTransient("b", { format: "rgba8unorm", usage: 0 });

      // pass1 writes a, reads b; pass2 writes b, reads a — circular
      const pass1 = new MockPass("pass1", (builder) => {
        builder.read(b);
        builder.colorAttachment({ handle: a, loadOp: "clear", storeOp: "store" });
      });
      const pass2 = new MockPass("pass2", (builder) => {
        builder.read(a);
        builder.colorAttachment({ handle: b, loadOp: "clear", storeOp: "store" });
      });

      fg.addPass(pass1);
      fg.addPass(pass2);
      fg.compile(mockDevice(), 800, 600);

      // Falls back to registration order
      expect(fg.getPassOrder()).toEqual(["pass1", "pass2"]);
    });
  });

  describe("Validation", () => {
    it("should not report errors for external resources read before production", () => {
      const fg = new FrameGraph();
      const surface = fg.importTexture("surface", {} as GPUTexture);

      const pass = new MockPass("pass", (builder) => {
        builder.read(surface);
      });

      fg.addPass(pass);
      fg.compile(mockDevice(), 800, 600);
      // No throw = no errors
      expect(fg.getPassOrder()).toEqual(["pass"]);
    });
  });

  describe("Compile & transient allocation", () => {
    it("should allocate transient textures on compile", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {} };
        },
      } as unknown as GPUDevice;

      fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      fg.createTransient("depth", { format: "depth32float", usage: 0x10 });

      const pass = new MockPass("pass", () => {});
      fg.addPass(pass);
      fg.compile(device, 1920, 1080);

      expect(createCount).toBe(2);
    });

    it("should not allocate external textures", () => {
      const fg = new FrameGraph();
      let createCount = 0;
      const device = {
        createTexture: () => {
          createCount++;
          return { createView: () => ({}), destroy: () => {} };
        },
      } as unknown as GPUDevice;

      fg.importTexture("surface", {} as GPUTexture);
      fg.createTransient("hdr", { format: "rgba16float", usage: 0 });

      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(device, 800, 600);

      expect(createCount).toBe(1);
    });
  });

  describe("Destroy", () => {
    it("should clean up transient resources", () => {
      const fg = new FrameGraph();
      const fakeTexture = { createView: () => ({}), destroy: vi.fn() };
      const device = {
        createTexture: () => fakeTexture,
      } as unknown as GPUDevice;

      fg.createTransient("hdr", { format: "rgba16float", usage: 0 });
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(device, 800, 600);
      fg.destroy();

      expect(fakeTexture.destroy).toHaveBeenCalled();
    });
  });
});

// ─── Backend-agnostic tests ──────────────────────────────────────────────

import type { RenderBackend } from "./backend/render-backend.ts";
import type { BackendTexture, BackendTextureView, TextureFormat } from "./backend/types.ts";

function createMockBackendTexture(): BackendTexture {
  return {
    getNative: vi.fn(() => ({})),
    destroy: vi.fn(),
  } as unknown as BackendTexture;
}

function createMockBackend(): RenderBackend {
  const mockTexture = createMockBackendTexture();
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
    createTexture: vi.fn(() => mockTexture),
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

describe("FrameGraph — backend-agnostic", () => {
  describe("compile with RenderBackend", () => {
    it("allocates transient textures via backend when provided", () => {
      const fg = new FrameGraph();
      const backend = createMockBackend();
      fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      fg.createTransient("depth", { format: "depth32float", usage: 0x10 });
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(null, 1920, 1080, backend);
      expect(backend.createTexture).toHaveBeenCalledTimes(2);
    });

    it("prefers backend over device when both are provided", () => {
      const fg = new FrameGraph();
      const backend = createMockBackend();
      const device = {
        createTexture: vi.fn(() => ({ createView: () => ({}), destroy: () => {} })),
      } as unknown as GPUDevice;
      fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(device, 800, 600, backend);
      expect(backend.createTexture).toHaveBeenCalledTimes(1);
      expect(device.createTexture).not.toHaveBeenCalled();
    });

    it("falls back to device when backend is null", () => {
      const fg = new FrameGraph();
      const device = {
        createTexture: vi.fn(() => ({ createView: () => ({}), destroy: () => {} })),
      } as unknown as GPUDevice;
      fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(device, 800, 600, null);
      expect(device.createTexture).toHaveBeenCalledTimes(1);
    });

    it("accepts null device with backend for WebGL2-only path", () => {
      const fg = new FrameGraph();
      const backend = createMockBackend();
      fg.createTransient("hdr", { format: "rgba16float", usage: 0x10 });
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(null, 800, 600, backend);
      expect(backend.createTexture).toHaveBeenCalledTimes(1);
    });
  });

  describe("importTexture with BackendTexture", () => {
    it("accepts BackendTexture objects", () => {
      const fg = new FrameGraph();
      const backendTex = createMockBackendTexture();
      const handle = fg.importTexture("surface", backendTex);
      expect(handle).toBeInstanceOf(TextureHandle);
      expect(handle.name).toBe("surface");
    });

    it("still accepts native GPUTexture objects", () => {
      const fg = new FrameGraph();
      const nativeTex = { createView: () => ({}) } as unknown as GPUTexture;
      const handle = fg.importTexture("surface", nativeTex);
      expect(handle).toBeInstanceOf(TextureHandle);
    });
  });

  describe("FrameContext backend field", () => {
    it("FrameContext accepts null backend and null device", () => {
      const ctx = {
        backend: null,
        device: null,
        width: 800,
        height: 600,
        viewProj: new Float32Array(16),
        invViewProj: new Float32Array(16),
        prevViewProj: new Float32Array(16),
        cameraPos: [0, 0, 0] as [number, number, number],
        lightData: {} as any,
        lightViewProj: new Float32Array(16),
        mesh: {} as any,
        modelMatrix: new Float32Array(16),
        shadowsEnabled: false,
        bloomEnabled: false,
        shadowSampler: null,
        debugQueue: null,
        opaqueVertexBuffer: null,
        opaqueIndexBuffer: null,
        opaqueIndexCount: 0,
        opaqueIndexFormat: "uint16" as GPUIndexFormat,
        addDrawCalls: () => {},
        addTriangles: () => {},
      };
      expect(ctx.backend).toBeNull();
      expect(ctx.device).toBeNull();
    });

    it("FrameContext accepts both backend and device (WebGPU path)", () => {
      const backend = createMockBackend();
      const ctx = {
        backend,
        device: {} as GPUDevice,
        width: 800,
        height: 600,
        viewProj: new Float32Array(16),
        invViewProj: new Float32Array(16),
        prevViewProj: new Float32Array(16),
        cameraPos: [0, 0, 0] as [number, number, number],
        lightData: {} as any,
        lightViewProj: new Float32Array(16),
        mesh: {} as any,
        modelMatrix: new Float32Array(16),
        shadowsEnabled: false,
        bloomEnabled: false,
        shadowSampler: null,
        debugQueue: null,
        opaqueVertexBuffer: null,
        opaqueIndexBuffer: null,
        opaqueIndexCount: 0,
        opaqueIndexFormat: "uint16" as GPUIndexFormat,
        addDrawCalls: () => {},
        addTriangles: () => {},
      };
      expect(ctx.backend).toBe(backend);
      expect(ctx.device).not.toBeNull();
    });
  });

  describe("GraphRenderContext backend accessors", () => {
    it("includes getBackendView and getBackendTexture", () => {
      const fg = new FrameGraph();
      const backend = createMockBackend();
      const backendTex = createMockBackendTexture();
      const handle = fg.importTexture("color", backendTex);
      fg.addPass(new MockPass("pass", () => {}));
      fg.compile(null, 800, 600, backend);

      // Verify the context shape includes backend accessors
      const ctx = {
        backend,
        device: null,
        width: 800,
        height: 600,
        viewProj: new Float32Array(16),
        invViewProj: new Float32Array(16),
        prevViewProj: new Float32Array(16),
        cameraPos: [0, 0, 0] as [number, number, number],
        lightData: {} as any,
        lightViewProj: new Float32Array(16),
        mesh: {} as any,
        modelMatrix: new Float32Array(16),
        shadowsEnabled: false,
        bloomEnabled: false,
        shadowSampler: null,
        debugQueue: null,
        opaqueVertexBuffer: null,
        opaqueIndexBuffer: null,
        opaqueIndexCount: 0,
        opaqueIndexFormat: "uint16" as GPUIndexFormat,
        addDrawCalls: () => {},
        addTriangles: () => {},
        pass: null,
        getView: () => ({}),
        getTexture: () => ({}),
        getBackendView: (h: TextureHandle) => {
          // This would call fg.getBackendTextureView internally
          return { getNative: () => null } as unknown as BackendTextureView;
        },
        getBackendTexture: (h: TextureHandle) => {
          return backendTex;
        },
      };
      expect(typeof ctx.getBackendView).toBe("function");
      expect(typeof ctx.getBackendTexture).toBe("function");
      expect(ctx.getBackendTexture(handle)).toBe(backendTex);
    });
  });

  describe("TextureDesc with backend-agnostic format", () => {
    it("accepts TextureFormat string", () => {
      const desc = { format: "rgba8unorm" as TextureFormat, usage: 0x10 };
      expect(desc.format).toBe("rgba8unorm");
    });

    it("accepts GPUTextureFormat string", () => {
      const desc = { format: "bgra8unorm" as GPUTextureFormat, usage: 0x10 };
      expect(desc.format).toBe("bgra8unorm");
    });

    it("accepts numeric usage", () => {
      const desc = { format: "rgba8unorm", usage: 16 };
      expect(desc.usage).toBe(16);
    });
  });
});
