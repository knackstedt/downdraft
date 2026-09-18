import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { GaussianSplatData } from "./parser";
import { GaussianSplatRenderer } from "./renderer";
import type { SortResult } from "./sorter";

const mockGPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80, COPY_SRC: 0x04, MAP_WRITE: 0x02, MAP_READ: 0x01 };
const mockGPUTextureUsage = { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x08 };
const mockGPUShaderStage = { COMPUTE: 0x4, VERTEX: 0x1, FRAGMENT: 0x2 };

beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockGPUBufferUsage;
  (globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockGPUTextureUsage;
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
  const createShaderModule = vi.fn(() => ({ destroy: vi.fn() }));
  const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
  const createBindGroup = vi.fn(() => ({}));
  const createBindGroupLayout = vi.fn(() => ({}));
  const createPipelineLayout = vi.fn(() => ({}));
  const createComputePipeline = vi.fn(() => ({}));
  const createCommandEncoder = vi.fn(() => makeMockCommandEncoder());
  return {
    createBuffer,
    createShaderModule,
    createRenderPipeline,
    createBindGroup,
    createBindGroupLayout,
    createPipelineLayout,
    createComputePipeline,
    createCommandEncoder,
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
}

function makeMockPass() {
  return {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
  };
}

const sampleData: GaussianSplatData = {
  count: 3,
  shDegree: 0,
  version: 1,
  position: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  scale: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
  rotation: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  color: new Float32Array([1, 0, 0, 0.8, 0, 1, 0, 1.0, 0, 0, 1, 0.5]),
  shCoeffs: new Float32Array(0),
};

describe("GaussianSplatRenderer", () => {
  it("should construct with null device", () => {
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    expect(renderer).toBeDefined();
  });

  it("should prepare by creating shader, camera buffer, and sorter", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    renderer.prepare(device);
    // Renderer shader + sorter shaders (5 kernels)
    expect((device as any).createShaderModule).toHaveBeenCalled();
    expect((device as any).createBuffer).toHaveBeenCalled();
    expect((device as any).createComputePipeline).toHaveBeenCalled();
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    renderer.prepare(device);
    const shaderCount = (device as any).createShaderModule.mock.calls.length;
    const bufferCount = (device as any).createBuffer.mock.calls.length;
    const pipelineCount = (device as any).createComputePipeline.mock.calls.length;
    renderer.prepare(device);
    expect((device as any).createShaderModule.mock.calls.length).toBe(shaderCount);
    expect((device as any).createBuffer.mock.calls.length).toBe(bufferCount);
    expect((device as any).createComputePipeline.mock.calls.length).toBe(pipelineCount);
  });

  it("should use device from constructor", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(makeMockDevice());
    expect((device as any).createShaderModule).toHaveBeenCalled();
  });

  it("should create splat buffer on setData", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    expect((device as any).createBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ size: sampleData.count * 12 * 4 }),
    );
    expect((device as any).queue.writeBuffer).toHaveBeenCalled();
  });

  it("should destroy old splat buffer when setting new data", () => {
    const device = makeMockDevice();
    const createBufferMock = (device as any).createBuffer;
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    // Record how many buffers prepare() created
    const buffersAfterPrepare = createBufferMock.mock.calls.length;
    renderer.setData(sampleData);
    // The splat buffer is the first createBuffer call after prepare
    const splatBufferResult = createBufferMock.mock.results[buffersAfterPrepare];
    renderer.setData(sampleData);
    // The old splat buffer should have been destroyed
    expect(splatBufferResult.value.destroy).toHaveBeenCalled();
  });

  it("should not render without data", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    const mockPass = makeMockPass();
    expect(() => renderer.render(mockPass as any, Array.from({ length: 16 }, () => 0), [0, 0, 0], [800, 600])).not.toThrow();
    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should render with pipeline and draw calls", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    const mockPass = makeMockPass();
    renderer.render(mockPass as any, Array.from({ length: 16 }, () => 0), [0, 0, 0], [800, 600]);
    expect(mockPass.setPipeline).toHaveBeenCalledTimes(1);
    expect(mockPass.setBindGroup).toHaveBeenCalledTimes(1);
    expect(mockPass.draw).toHaveBeenCalledWith(4, sampleData.count);
  });

  it("should write camera data to buffer on render", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    const mockPass = makeMockPass();
    const viewProj = Array.from({ length: 16 }, () => 0);
    viewProj[0] = 1;
    renderer.render(mockPass as any, viewProj, [10, 20, 30], [1920, 1080]);
    expect((device as any).queue.writeBuffer).toHaveBeenCalled();
  });

  it("should trigger GPU sort on render (compute passes dispatched)", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    const mockPass = makeMockPass();
    renderer.render(mockPass as any, Array.from({ length: 16 }, () => 0), [0, 0, 0], [800, 600]);
    // The sorter should have created command encoders and submitted them
    expect((device as any).createCommandEncoder).toHaveBeenCalled();
    expect((device as any).queue.submit).toHaveBeenCalled();
  });

  it("should accept sort result via updateSort", () => {
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    const sortResult: SortResult = {
      indices: new Uint32Array([2, 1, 0]),
      distances: new Float32Array([100, 50, 25]),
    };
    expect(() => renderer.updateSort(sortResult)).not.toThrow();
  });

  it("should destroy buffers on destroy", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    expect(() => renderer.destroy()).not.toThrow();
  });

  it("should handle empty splat data", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    const emptyData: GaussianSplatData = { count: 0, shDegree: 0, version: 1, position: new Float32Array(0), scale: new Float32Array(0), rotation: new Float32Array(0), color: new Float32Array(0), shCoeffs: new Float32Array(0) };
    expect(() => renderer.setData(emptyData)).not.toThrow();
  });
});
