import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { WebGPUBackend } from "./webgpu-backend.ts";
import { WebGPUCommandEncoder } from "./webgpu-encoders.ts";

// Define GPUTextureUsage constants for test environment
if (typeof globalThis.GPUTextureUsage === "undefined") {
  (globalThis as unknown as { GPUTextureUsage: Record<string, number> }).GPUTextureUsage = {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
}

// ─── Mock helpers ───────────────────────────────────────────────────────────

function makeMockAdapter(features: string[] = []): GPUAdapter {
  return {
    features: {
      has: (f: string) => features.includes(f),
      size: features.length,
      [Symbol.iterator]: function* () { for (const f of features) yield f; },
    },
    requestDevice: vi.fn().mockResolvedValue(makeMockDevice()),
    limits: {},
    isFallbackAdapter: false,
  } as unknown as GPUAdapter;
}

function makeMockDevice(): GPUDevice {
  return {
    queue: {},
    features: {
      has: () => false,
      size: 0,
      [Symbol.iterator]: function* () {},
    },
    limits: {},
    lost: Promise.resolve({ reason: "unknown", message: "test" }),
    createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
    createTexture: vi.fn().mockReturnValue({
      createView: vi.fn().mockReturnValue({}),
      destroy: vi.fn(),
      width: 800,
      height: 600,
      format: "bgra8unorm",
    }),
    createSampler: vi.fn().mockReturnValue({}),
    createShaderModule: vi.fn().mockReturnValue({}),
    createBindGroupLayout: vi.fn().mockReturnValue({}),
    createPipelineLayout: vi.fn().mockReturnValue({}),
    createBindGroup: vi.fn().mockReturnValue({}),
    createRenderPipeline: vi.fn().mockReturnValue({}),
    createCommandEncoder: vi.fn().mockReturnValue({}),
    destroy: vi.fn(),
  } as unknown as GPUDevice;
}

function makeMockCanvas(): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    getContext: vi.fn().mockReturnValue({
      configure: vi.fn(),
      getCurrentTexture: vi.fn().mockReturnValue({
        width: 800,
        height: 600,
        format: "bgra8unorm",
      }),
    }),
  } as unknown as HTMLCanvasElement;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WebGPUBackend", () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("type is 'webgpu'", () => {
    const backend = new WebGPUBackend();
    expect(backend.type).toBe("webgpu");
  });

  it("capabilities throws before init", () => {
    const backend = new WebGPUBackend();
    expect(() => backend.capabilities).toThrow("not initialized");
  });

  it("queue throws before init", () => {
    const backend = new WebGPUBackend();
    expect(() => backend.queue).toThrow("not initialized");
  });

  it("init returns false when navigator.gpu is undefined", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
    const backend = new WebGPUBackend();
    const ok = await backend.init();
    expect(ok).toBe(false);
  });

  it("init returns false when no adapter found", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(null),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    const backend = new WebGPUBackend();
    const ok = await backend.init();
    expect(ok).toBe(false);
  });

  it("init returns true and sets up capabilities and queue on success", async () => {
    const mockDevice = makeMockDevice();
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(makeMockAdapter()),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    const backend = new WebGPUBackend();
    const ok = await backend.init();
    expect(ok).toBe(true);
    expect(() => backend.capabilities).not.toThrow();
    expect(() => backend.queue).not.toThrow();
  });

  it("init passes powerPreference to requestAdapter", async () => {
    const requestAdapter = vi.fn().mockResolvedValue(makeMockAdapter());
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter,
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    const backend = new WebGPUBackend();
    await backend.init({ powerPreference: "low-power" });
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "low-power" });
  });

  it("init filters requiredFeatures by adapter support", async () => {
    const mockAdapter = makeMockAdapter(["depth-clip-control", "timestamp-query"]);
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    const backend = new WebGPUBackend();
    await backend.init({ requiredFeatures: ["depth-clip-control", "nonexistent-feature"] });
    expect(mockAdapter.requestDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredFeatures: ["depth-clip-control"],
      }),
    );
  });

  it("init defaults powerPreference to high-performance", async () => {
    const requestAdapter = vi.fn().mockResolvedValue(makeMockAdapter());
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter,
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    const backend = new WebGPUBackend();
    await backend.init();
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "high-performance" });
  });
});

describe("WebGPUBackend — surface configuration", () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(makeMockAdapter()),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("configureSurface stores canvas and context", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    const canvas = makeMockCanvas();
    backend.configureSurface(canvas, { usage: 8 });
    expect(backend.getSurfaceFormat()).toBe("bgra8unorm");
  });

  it("configureSurface does not throw when device is initialized", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    const canvas = makeMockCanvas();
    expect(() => backend.configureSurface(canvas, { usage: 8 })).not.toThrow();
  });

  it("getSurfaceFormat returns default bgra8unorm before configure", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(backend.getSurfaceFormat()).toBe("bgra8unorm");
  });

  it("getCurrentSurfaceTexture returns null before configure", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(backend.getCurrentSurfaceTexture()).toBeNull();
  });

  it("getCurrentSurfaceTexture returns a texture after configure", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    const canvas = makeMockCanvas();
    backend.configureSurface(canvas, { usage: 8 });
    const tex = backend.getCurrentSurfaceTexture();
    expect(tex).not.toBeNull();
  });

  it("reconfigureSurface updates width and height", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    const canvas = makeMockCanvas();
    backend.configureSurface(canvas, { width: 800, height: 600, usage: 8 });
    backend.reconfigureSurface(1920, 1080);
    expect(backend.getSurfaceFormat()).toBe("bgra8unorm");
  });
});

describe("WebGPUBackend — resource creation", () => {
  let backend: WebGPUBackend;
  let originalGpu: unknown;

  beforeEach(async () => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(makeMockAdapter()),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
    backend = new WebGPUBackend();
    await backend.init();
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
    backend.destroy();
  });

  it("createBuffer returns a WebGPUBuffer wrapper", () => {
    const buf = backend.createBuffer({
      size: 1024,
      usage: 64,
      label: "test-buf",
    });
    expect(buf).toBeDefined();
    expect(buf.size).toBe(1024);
    expect(buf.usage).toBe(64);
    expect(buf.label).toBe("test-buf");
  });

  it("createTexture returns a texture wrapper with correct dimensions", () => {
    const tex = backend.createTexture({
      size: [800, 600, 1],
      format: "rgba8unorm",
      usage: 8,
      label: "test-tex",
    });
    expect(tex).toBeDefined();
    expect(tex.width).toBe(800);
    expect(tex.height).toBe(600);
    expect(tex.depthOrArrayLayers).toBe(1);
    expect(tex.format).toBe("rgba8unorm");
  });

  it("createTexture handles scalar size", () => {
    const tex = backend.createTexture({
      size: 256,
      format: "rgba8unorm",
      usage: 8,
    });
    expect(tex.width).toBe(256);
    expect(tex.height).toBe(1);
    expect(tex.depthOrArrayLayers).toBe(1);
  });

  it("createSampler returns a sampler wrapper", () => {
    const s = backend.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    expect(s).toBeDefined();
  });

  it("createShaderModule throws for non-WGSL language", () => {
    expect(() =>
      backend.createShaderModule({ wgsl: "", label: "test" }, "glsl" as never),
    ).toThrow("only supports WGSL");
  });

  it("createShaderModule throws when wgsl is empty", () => {
    expect(() =>
      backend.createShaderModule({ wgsl: "", label: "test" }, "wgsl"),
    ).toThrow("only supports WGSL");
  });

  it("createShaderModule returns a shader module wrapper for valid WGSL", () => {
    const mod = backend.createShaderModule(
      { wgsl: "@vertex fn main() {}", label: "test-shader" },
      "wgsl",
    );
    expect(mod).toBeDefined();
  });

  it("createBindGroupLayout returns a layout wrapper", () => {
    const layout = backend.createBindGroupLayout({
      label: "test-layout",
      entries: [
        {
          binding: 0,
          visibility: 2,
          buffer: { type: "uniform", hasDynamicOffset: false },
        },
      ],
    });
    expect(layout).toBeDefined();
  });

  it("createPipelineLayout returns a layout wrapper", () => {
    const bgLayout = {
      gpuLayout: {},
    } as unknown as import("../types.ts").BackendBindGroupLayout;
    const layout = backend.createPipelineLayout({
      label: "test-pipeline-layout",
      bindGroupLayouts: [bgLayout],
    });
    expect(layout).toBeDefined();
  });

  it("createBindGroup returns a bind group wrapper", () => {
    const bgLayout = {
      gpuLayout: {},
    } as unknown as import("../types.ts").BackendBindGroupLayout;
    const buf = backend.createBuffer({ size: 256, usage: 64 });
    const bg = backend.createBindGroup({
      label: "test-bg",
      layout: bgLayout,
      entries: [
        { binding: 0, resource: { buffer: buf } },
      ],
    });
    expect(bg).toBeDefined();
  });

  it("createRenderPipeline returns a pipeline wrapper", () => {
    const shaderMod = {
      gpuModule: {},
    } as unknown as import("../types.ts").BackendShaderModule;
    const pipeline = backend.createRenderPipeline({
      label: "test-pipeline",
      vertex: {
        module: shaderMod,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderMod,
        entryPoint: "fs_main",
        targets: [{ format: "bgra8unorm" }],
      },
    });
    expect(pipeline).toBeDefined();
  });

  it("createCommandEncoder returns a WebGPUCommandEncoder", () => {
    const enc = backend.createCommandEncoder("test-encoder");
    expect(enc).toBeInstanceOf(WebGPUCommandEncoder);
  });

  it("createTextureView delegates to texture.createView", () => {
    const mockView = {};
    const tex = {
      createView: vi.fn().mockReturnValue(mockView),
    } as unknown as import("../types.ts").BackendTexture;
    const view = backend.createTextureView(tex);
    expect(view).toBe(mockView);
    expect(tex.createView).toHaveBeenCalledTimes(1);
  });
});

describe("WebGPUBackend — lifecycle", () => {
  let originalGpu: unknown;

  beforeEach(() => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(makeMockAdapter()),
      getPreferredCanvasFormat: vi.fn().mockReturnValue("bgra8unorm"),
    };
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("destroy clears state and capabilities throws after destroy", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(() => backend.capabilities).not.toThrow();
    backend.destroy();
    expect(() => backend.capabilities).toThrow("not initialized");
  });

  it("destroy clears queue", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(() => backend.queue).not.toThrow();
    backend.destroy();
    expect(() => backend.queue).toThrow("not initialized");
  });

  it("onDeviceLost registers a handler without throwing", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(() => backend.onDeviceLost(() => {})).not.toThrow();
  });

  it("getNativeDevice returns the device after init", async () => {
    const backend = new WebGPUBackend();
    await backend.init();
    expect(backend.getNativeDevice()).not.toBeNull();
  });

  it("getNativeDevice returns null before init", () => {
    const backend = new WebGPUBackend();
    expect(backend.getNativeDevice()).toBeNull();
  });

  it("resource creation throws before init", () => {
    const backend = new WebGPUBackend();
    expect(() => backend.createBuffer({ size: 64, usage: 64 })).toThrow("not initialized");
    expect(() => backend.createTexture({ size: 64, format: "rgba8unorm", usage: 8 })).toThrow("not initialized");
    expect(() => backend.createSampler({})).toThrow("not initialized");
    expect(() => backend.createShaderModule({ wgsl: "x", label: "" }, "wgsl")).toThrow("not initialized");
    expect(() => backend.createBindGroupLayout({ entries: [] })).toThrow("not initialized");
    expect(() => backend.createPipelineLayout({ bindGroupLayouts: [] })).toThrow("not initialized");
    expect(() => backend.createBindGroup({ layout: {} as never, entries: [] })).toThrow("not initialized");
    expect(() => backend.createRenderPipeline({
      vertex: { module: {} as never, entryPoint: "" },
    })).toThrow("not initialized");
    expect(() => backend.createCommandEncoder()).toThrow("not initialized");
  });
});
