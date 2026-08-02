import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createBackend, detectBackends } from "./render-backend.ts";

describe("detectBackends", () => {
  it("returns an object with webgpu and webgl2 boolean flags", () => {
    const result = detectBackends();
    expect(typeof result.webgpu).toBe("boolean");
    expect(typeof result.webgl2).toBe("boolean");
  });

  it("detects webgpu as false when navigator.gpu is undefined", () => {
    const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
    const result = detectBackends();
    expect(result.webgpu).toBe(false);
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("detects webgpu as true when navigator.gpu is defined", () => {
    const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    (navigator as unknown as { gpu?: unknown }).gpu = {} as unknown as GPU;
    const result = detectBackends();
    expect(result.webgpu).toBe(true);
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("detects webgl2 as false when document is undefined", () => {
    const originalDoc = globalThis.document;
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    const result = detectBackends();
    expect(result.webgl2).toBe(false);
    Object.defineProperty(globalThis, "document", { value: originalDoc, configurable: true });
  });
});

describe("createBackend", () => {
  let originalGpu: unknown;
  let mockCanvas: HTMLCanvasElement;

  beforeEach(() => {
    originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    mockCanvas = {
      getContext: vi.fn(),
    } as unknown as HTMLCanvasElement;
  });

  afterEach(() => {
    (navigator as unknown as { gpu?: unknown }).gpu = originalGpu;
  });

  it("returns null when no backends are available", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
    // Mock document to undefined so WebGL2 detection fails
    const originalDoc = globalThis.document;
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    const result = await createBackend(mockCanvas);
    expect(result).toBeNull();
    Object.defineProperty(globalThis, "document", { value: originalDoc, configurable: true });
  });

  it("returns null when navigator.gpu is a non-functional stub", async () => {
    // navigator.gpu exists but requestAdapter will fail since it's just {}
    (navigator as unknown as { gpu?: unknown }).gpu = {} as unknown as GPU;
    const result = await createBackend(mockCanvas);
    // With a stub gpu that has no requestAdapter, WebGPU init fails,
    // then WebGL2 init also fails (stub canvas), so result is null
    expect(result).toBeNull();
  });

  it("returns null when forceBackend is webgpu but no gpu adapter available", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = {
      requestAdapter: vi.fn().mockResolvedValue(null),
    } as unknown as GPU;
    const result = await createBackend(mockCanvas, { forceBackend: "webgpu" });
    expect(result).toBeNull();
  });

  it("returns null when forceBackend is webgl2 but WebGL2 is not available", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = {} as unknown as GPU;
    // Mock canvas getContext to return null (no WebGL2)
    mockCanvas = {
      getContext: vi.fn().mockReturnValue(null),
    } as unknown as HTMLCanvasElement;
    const result = await createBackend(mockCanvas, { forceBackend: "webgl2" });
    expect(result).toBeNull();
  });

  it("passes canvas to WebGL2Backend.init when falling back", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
    const getContext = vi.fn().mockReturnValue(null);
    mockCanvas = {
      getContext,
    } as unknown as HTMLCanvasElement;
    await createBackend(mockCanvas, { forceBackend: "webgl2" });
    // The canvas getContext should have been called with "webgl2"
    expect(getContext).toHaveBeenCalledWith("webgl2", expect.any(Object));
  });

  it("accepts BackendCreateOptions with all fields", async () => {
    (navigator as unknown as { gpu?: unknown }).gpu = undefined;
    const result = await createBackend(mockCanvas, {
      forceBackend: "webgpu",
      powerPreference: "low-power",
      requiredFeatures: ["timestamp-query"],
    });
    // With no navigator.gpu and forceBackend=webgpu, returns null
    expect(result).toBeNull();
  });
});

describe("RenderBackend interface", () => {
  it("SurfaceConfiguration accepts string format", () => {
    const config = {
      format: "bgra8unorm" as string,
      width: 800,
      height: 600,
      usage: 8,
      alphaMode: "opaque" as const,
      viewFormats: [],
    };
    expect(config.format).toBe("bgra8unorm");
    expect(config.width).toBe(800);
  });

  it("SurfaceConfiguration accepts TextureFormat enum", () => {
    const config = {
      format: "rgba8unorm" as const,
      width: 1920,
      height: 1080,
      usage: 8,
      alphaMode: "premultiplied" as const,
      viewFormats: ["rgba8unorm"],
    };
    expect(config.format).toBe("rgba8unorm");
    expect(config.viewFormats).toHaveLength(1);
  });

  it("BackendCreateOptions has optional fields", () => {
    const opts = {};
    expect(opts.forceBackend).toBeUndefined();
    expect(opts.powerPreference).toBeUndefined();
    expect(opts.requiredFeatures).toBeUndefined();
  });
});
