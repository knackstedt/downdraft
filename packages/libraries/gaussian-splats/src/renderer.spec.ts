import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { GaussianSplatData } from "./parser";
import { GaussianSplatRenderer } from "./renderer";
import type { SortResult } from "./sorter";

const mockGPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80 };
const mockGPUTextureUsage = { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x08 };

beforeAll(() => {
  (globalThis as unknown as { GPUBufferUsage: unknown }).GPUBufferUsage = mockGPUBufferUsage;
  (globalThis as unknown as { GPUTextureUsage: unknown }).GPUTextureUsage = mockGPUTextureUsage;
});

function makeMockDevice() {
  const createBuffer = vi.fn(() => ({ destroy: vi.fn() }));
  const createShaderModule = vi.fn(() => ({}));
  const createRenderPipeline = vi.fn(() => ({ getBindGroupLayout: () => ({}) }));
  const createBindGroup = vi.fn(() => ({}));
  return {
    createBuffer,
    createShaderModule,
    createRenderPipeline,
    createBindGroup,
    queue: { writeBuffer: vi.fn() },
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
  splats: [
    { position: [1, 2, 3], scale: [0.1, 0.2, 0.3], rotation: [0, 0, 0, 1], color: [1, 0, 0, 1], opacity: 0.8 },
    { position: [4, 5, 6], scale: [0.4, 0.5, 0.6], rotation: [0, 0, 0, 1], color: [0, 1, 0, 1], opacity: 1.0 },
  { position: [7, 8, 9], scale: [0.7, 0.8, 0.9], rotation: [0, 0, 0, 1], color: [0, 0, 1, 1], opacity: 0.5 },
  ],
  count: 3,
  shDegree: 0,
  version: 1,
};

describe("GaussianSplatRenderer", () => {
  it("should construct with null device", () => {
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    expect(renderer).toBeDefined();
  });

  it("should prepare by creating shader and camera buffer", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    renderer.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(1);
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(null, "bgra8unorm");
    renderer.prepare(device);
    renderer.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(1);
  });

  it("should use device from constructor", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(makeMockDevice());
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
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
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    const firstBuffer = (device as any).createBuffer.mock.results[1].value;
    renderer.setData(sampleData);
    expect(firstBuffer.destroy).toHaveBeenCalled();
  });

  it("should not render without data", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    const mockPass = makeMockPass();
    expect(() => renderer.render(mockPass as any, new Array(16).fill(0), [0, 0, 0], [800, 600])).not.toThrow();
    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should render with pipeline and draw calls", () => {
    const device = makeMockDevice();
    const renderer = new GaussianSplatRenderer(device, "bgra8unorm");
    renderer.prepare(device);
    renderer.setData(sampleData);
    const mockPass = makeMockPass();
    renderer.render(mockPass as any, new Array(16).fill(0), [0, 0, 0], [800, 600]);
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
    const viewProj = new Array(16).fill(0);
    viewProj[0] = 1;
    renderer.render(mockPass as any, viewProj, [10, 20, 30], [1920, 1080]);
    expect((device as any).queue.writeBuffer).toHaveBeenCalled();
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
    const emptyData: GaussianSplatData = { splats: [], count: 0, shDegree: 0, version: 1 };
    expect(() => renderer.setData(emptyData)).not.toThrow();
  });
});
