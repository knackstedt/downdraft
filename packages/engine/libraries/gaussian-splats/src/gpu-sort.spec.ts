import { beforeAll, describe, expect, it, vi } from "bun:test";
import { GpuSplatSorter } from "./gpu-sort";

const mockGPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08, STORAGE: 0x80, COPY_SRC: 0x04, MAP_WRITE: 0x02, MAP_READ: 0x01 };
const mockGPUShaderStage = { COMPUTE: 0x4, VERTEX: 0x1, FRAGMENT: 0x2 };

beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockGPUBufferUsage;
  (globalThis as unknown as { GPUShaderStage: unknown }).GPUShaderStage = mockGPUShaderStage;
});

function makeMockComputePass() {
  return {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
}

function makeMockCommandEncoder() {
  return {
    beginComputePass: vi.fn(() => makeMockComputePass()),
    copyBufferToBuffer: vi.fn(),
    finish: vi.fn(() => ({})),
  };
}

function makeMockDevice() {
  const createBuffer = vi.fn(() => ({ destroy: vi.fn() }));
  const createShaderModule = vi.fn(() => ({}));
  const createBindGroupLayout = vi.fn(() => ({}));
  const createPipelineLayout = vi.fn(() => ({}));
  const createComputePipeline = vi.fn(() => ({}));
  const createBindGroup = vi.fn(() => ({}));
  const createCommandEncoder = vi.fn(() => makeMockCommandEncoder());
  return {
    createBuffer,
    createShaderModule,
    createBindGroupLayout,
    createPipelineLayout,
    createComputePipeline,
    createBindGroup,
    createCommandEncoder,
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
}

describe("GpuSplatSorter", () => {
  it("should construct with null device", () => {
    const sorter = new GpuSplatSorter(null);
    expect(sorter).toBeDefined();
  });

  it("should prepare by creating pipelines and buffers", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(null);
    sorter.prepare(device);
    // 5 compute pipelines (distances, histogram, prefix_sum, scatter, compact)
    expect((device as any).createComputePipeline).toHaveBeenCalledTimes(5);
    // 5 shader modules for the 5 kernels
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(5);
    // Buffers: sort uniforms, compact uniforms, 2 key, 2 index, histogram, prefixSum, scatterCounter, zero, compacted = 11
    expect((device as any).createBuffer.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(null);
    sorter.prepare(device);
    const pipelineCount = (device as any).createComputePipeline.mock.calls.length;
    const bufferCount = (device as any).createBuffer.mock.calls.length;
    sorter.prepare(device);
    expect((device as any).createComputePipeline.mock.calls.length).toBe(pipelineCount);
    expect((device as any).createBuffer.mock.calls.length).toBe(bufferCount);
  });

  it("should use custom maxSplats for buffer sizing", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(null, { maxSplats: 100_000 });
    sorter.prepare(device);
    // Key/index buffers should be sized for 100k splats (4 bytes each)
    const keyBufferCalls = (device as any).createBuffer.mock.calls.filter(
      (c: any[]) => c[0].label?.includes("keys"),
    );
    expect(keyBufferCalls.length).toBe(2);
    keyBufferCalls.forEach((call: any) => {
      expect(call[0].size).toBe(100_000 * 4);
    });
    // Compacted buffer: 100k * 48 bytes
    const compactedCalls = (device as any).createBuffer.mock.calls.filter(
      (c: any[]) => c[0].label?.includes("compacted"),
    );
    expect(compactedCalls.length).toBe(1);
    expect(compactedCalls[0][0].size).toBe(100_000 * 48);
  });

  it("should use default maxSplats of 1_000_000", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(null);
    sorter.prepare(device);
    const keyBufferCalls = (device as any).createBuffer.mock.calls.filter(
      (c: any[]) => c[0].label?.includes("keys"),
    );
    expect(keyBufferCalls[0][0].size).toBe(1_000_000 * 4);
  });

  it("should return null for zero count in sortAndCompact", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(device);
    sorter.prepare(device);
    const result = sorter.sortAndCompact([0, 0, 0], { destroy: vi.fn() } as any, null, 0);
    expect(result).toBeNull();
  });

  it("should use CPU fallback below threshold", () => {
    const device = makeMockDevice();
    const submitMock = (device as any).queue.submit;
    const sorter = new GpuSplatSorter(device, { threshold: 100 });
    sorter.prepare(device);
    // Record submit count after prepare (prepare writes zero buffer but doesn't submit)
    const submitsAfterPrepare = submitMock.mock.calls.length;

    const splatData = {
      count: 3,
      shDegree: 0,
      version: 1,
      position: new Float32Array([1, 0, 0, 5, 0, 0, 10, 0, 0]),
      scale: new Float32Array(9),
      rotation: new Float32Array(12),
      color: new Float32Array(12),
      shCoeffs: new Float32Array(0),
    };
    const result = sorter.sortAndCompact([0, 0, 0], { destroy: vi.fn() } as any, splatData, 3);
    // CPU fallback: only 1 submit (compact pass), no GPU sort submits
    expect(result).toBeDefined();
    expect(submitMock.mock.calls.length - submitsAfterPrepare).toBe(1);
  });

  it("should use GPU sort at or above threshold", () => {
    const device = makeMockDevice();
    const submitMock = (device as any).queue.submit;
    const sorter = new GpuSplatSorter(device, { threshold: 3 });
    sorter.prepare(device);
    const submitsAfterPrepare = submitMock.mock.calls.length;

    const splatData = {
      count: 3,
      shDegree: 0,
      version: 1,
      position: new Float32Array([1, 0, 0, 5, 0, 0, 10, 0, 0]),
      scale: new Float32Array(9),
      rotation: new Float32Array(12),
      color: new Float32Array(12),
      shCoeffs: new Float32Array(0),
    };
    const result = sorter.sortAndCompact([0, 0, 0], { destroy: vi.fn() } as any, splatData, 3);
    expect(result).toBeDefined();
    // GPU sort: 1 (distances) + 8 (radix passes) + 1 (compact) = 10 submits
    const sortSubmits = submitMock.mock.calls.length - submitsAfterPrepare;
    expect(sortSubmits).toBeGreaterThanOrEqual(9);
  });

  it("should destroy all buffers on destroy", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(device);
    sorter.prepare(device);
    const buffersCreated = (device as any).createBuffer.mock.results;
    expect(() => sorter.destroy()).not.toThrow();
    // All created buffers should have destroy called
    buffersCreated.forEach((result: any) => {
      expect(result.value.destroy).toHaveBeenCalled();
    });
  });

  it("should handle null splatData in CPU fallback gracefully", () => {
    const device = makeMockDevice();
    const sorter = new GpuSplatSorter(device, { threshold: 100 });
    sorter.prepare(device);
    // count < threshold but splatData is null → should fall through to GPU path
    const result = sorter.sortAndCompact([0, 0, 0], { destroy: vi.fn() } as any, null, 3);
    // GPU path runs (splatData null → can't use CPU fallback)
    expect(result).toBeDefined();
  });
});
