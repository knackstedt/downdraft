import { afterAll, describe, expect, it } from "bun:test";
import { GPUTimerPool } from "./gpu-timer-pool";

// Stub WebGPU constants (not available in bun test environment)
const _orig_GPUBufferUsage = (globalThis as any).GPUBufferUsage;
afterAll(() => {
  if (_orig_GPUBufferUsage === undefined) delete (globalThis as any).GPUBufferUsage; else (globalThis as any).GPUBufferUsage = _orig_GPUBufferUsage;
});
(globalThis as any).GPUBufferUsage = {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
};

// Mock GPUDevice for testing timestamp query pool logic
function createMockDevice(features: string[]): any {
  return {
    features: {
      has: (f: string) => features.includes(f),
    },
    createQuerySet: (opts: any) => ({ ...opts, destroy: () => {} }),
    createBuffer: (opts: any) => ({
      ...opts,
      destroy: () => {},
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(opts.size),
      unmap: () => {},
    }),
  };
}

describe("GPUTimerPool", () => {
  it("is unsupported when timestamp-query is missing", () => {
    const device = createMockDevice([]);
    const pool = new GPUTimerPool(device, 8);
    expect(pool.isSupported()).toBe(false);
    expect(pool.isEncoderTimestampSupported()).toBe(false);
  });

  it("is supported with timestamp-query + inside-passes", () => {
    const device = createMockDevice(["timestamp-query", "chromium-experimental-timestamp-query-inside-passes"]);
    const pool = new GPUTimerPool(device, 8);
    expect(pool.isSupported()).toBe(true);
    expect(pool.isEncoderTimestampSupported()).toBe(true);
  });

  it("encoder timestamps work with only timestamp-query (no inside-passes)", () => {
    const device = createMockDevice(["timestamp-query"]);
    const pool = new GPUTimerPool(device, 8);
    expect(pool.isSupported()).toBe(false); // inside-pass not supported
    expect(pool.isEncoderTimestampSupported()).toBe(true); // but encoder-level is
  });

  it("timestamps are off on native by default (writeTimestamp/resolve lose the wgpu device)", () => {
    (globalThis as any).__nativeHost = {};
    try {
      const device = createMockDevice(["timestamp-query"]);
      const pool = new GPUTimerPool(device, 8);
      expect(pool.isSupported()).toBe(false);
      expect(pool.isEncoderTimestampSupported()).toBe(false);
    } finally {
      delete (globalThis as any).__nativeHost;
    }
  });

  it("DOWNDRAFT_GPU_TIMESTAMPS opts back in on native", () => {
    (globalThis as any).__nativeHost = {};
    process.env.DOWNDRAFT_GPU_TIMESTAMPS = "1";
    try {
      const device = createMockDevice(["timestamp-query"]);
      const pool = new GPUTimerPool(device, 8);
      expect(pool.isSupported()).toBe(true); // wgpu: inside-pass via timestamp-query
      expect(pool.isEncoderTimestampSupported()).toBe(true);
    } finally {
      delete (globalThis as any).__nativeHost;
      delete process.env.DOWNDRAFT_GPU_TIMESTAMPS;
    }
  });

  it("getMaxPasses returns the configured value", () => {
    const device = createMockDevice(["timestamp-query", "chromium-experimental-timestamp-query-inside-passes"]);
    const pool = new GPUTimerPool(device, 16);
    expect(pool.getMaxPasses()).toBe(16);
  });

  it("begin/end are no-ops when unsupported", () => {
    const device = createMockDevice([]);
    const pool = new GPUTimerPool(device, 8);
    const mockPass = { writeTimestamp: () => {} };
    // Should not throw
    pool.begin(mockPass as any, 0);
    pool.end(mockPass as any, 0);
  });

  it("beginEncoder/endEncoder are no-ops when encoder timestamps unsupported", () => {
    const device = createMockDevice([]);
    const pool = new GPUTimerPool(device, 8);
    const mockEncoder = { writeTimestamp: () => {} };
    // Should not throw
    pool.beginEncoder(mockEncoder as any, 0);
    pool.endEncoder(mockEncoder as any, 0);
  });

  it("destroy cleans up resources", () => {
    const device = createMockDevice(["timestamp-query", "chromium-experimental-timestamp-query-inside-passes"]);
    const pool = new GPUTimerPool(device, 8);
    pool.destroy();
    expect(pool.isSupported()).toBe(false);
  });
});
