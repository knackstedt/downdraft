import { beforeAll, describe, expect, it, vi } from "bun:test";
import { DEFAULT_MAX_SPLATS_PER_TILE, DEFAULT_TILE_SIZE, TileRasterPipeline } from "./tile-raster";

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
  const createComputePipeline = vi.fn(() => ({ destroy: vi.fn() }));
  const createRenderPipeline = vi.fn(() => ({ destroy: vi.fn() }));
  const createBindGroup = vi.fn(() => ({}));
  const createCommandEncoder = vi.fn(() => makeMockCommandEncoder());
  return {
    createBuffer,
    createShaderModule,
    createBindGroupLayout,
    createPipelineLayout,
    createComputePipeline,
    createRenderPipeline,
    createBindGroup,
    createCommandEncoder,
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  } as unknown as GPUDevice;
}

describe("TileRasterPipeline constants", () => {
  it("DEFAULT_TILE_SIZE should be 16", () => {
    expect(DEFAULT_TILE_SIZE).toBe(16);
  });

  it("DEFAULT_MAX_SPLATS_PER_TILE should be 256", () => {
    expect(DEFAULT_MAX_SPLATS_PER_TILE).toBe(256);
  });
});

describe("TileRasterPipeline", () => {
  it("should construct with null device", () => {
    const pipeline = new TileRasterPipeline(null);
    expect(pipeline).toBeDefined();
  });

  it("should prepare by creating pipelines and buffers", () => {
    const device = makeMockDevice();
    const pipeline = new TileRasterPipeline(null);
    pipeline.prepare(device);
    // 1 compute pipeline (bin) + 1 render pipeline (raster)
    expect((device as any).createComputePipeline).toHaveBeenCalledTimes(1);
    expect((device as any).createRenderPipeline).toHaveBeenCalledTimes(1);
    // 2 shader modules (bin + raster)
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(2);
    // Buffers: bin uniforms, raster uniforms, zero = 3
    expect((device as any).createBuffer.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const pipeline = new TileRasterPipeline(null);
    pipeline.prepare(device);
    const pipelineCount = (device as any).createComputePipeline.mock.calls.length;
    const bufferCount = (device as any).createBuffer.mock.calls.length;
    pipeline.prepare(device);
    expect((device as any).createComputePipeline.mock.calls.length).toBe(pipelineCount);
    expect((device as any).createBuffer.mock.calls.length).toBe(bufferCount);
  });

  it("should use custom tileSize and maxSplatsPerTile", () => {
    const device = makeMockDevice();
    const pipeline = new TileRasterPipeline(null, { tileSize: 32, maxSplatsPerTile: 128 });
    expect(pipeline.tileSize).toBe(32);
    expect(pipeline.maxSplatsPerTile).toBe(128);
  });

  it("should use default tileSize and maxSplatsPerTile", () => {
    const pipeline = new TileRasterPipeline(null);
    expect(pipeline.tileSize).toBe(DEFAULT_TILE_SIZE);
    expect(pipeline.maxSplatsPerTile).toBe(DEFAULT_MAX_SPLATS_PER_TILE);
  });

  it("should create tile buffers on binSplats with correct sizes", () => {
    const device = makeMockDevice();
    const createBufferMock = (device as any).createBuffer;
    const pipeline = new TileRasterPipeline(device, { tileSize: 16, maxSplatsPerTile: 64 });
    pipeline.prepare(device);
    // Clear mock to track new buffer creations
    const buffersBeforeBin = createBufferMock.mock.calls.length;

    const splatBuffer = { destroy: vi.fn() } as any;
    const viewProj = Array.from({ length: 16 }, () => 0);
    pipeline.binSplats(splatBuffer, 100, viewProj, 1920, 1080);

    // Tile counts buffer: ceil(1920/16) * ceil(1080/16) * 4 = 120 * 68 * 4
    const tileCountX = Math.ceil(1920 / 16);
    const tileCountY = Math.ceil(1080 / 16);
    const expectedCountsSize = tileCountX * tileCountY * 4;
    const expectedIndicesSize = tileCountX * tileCountY * 64 * 4;

    const newBufferCalls = createBufferMock.mock.calls.slice(buffersBeforeBin);
    const countsCall = newBufferCalls.find((c: any[]) => c[0].label === "tile-counts");
    const indicesCall = newBufferCalls.find((c: any[]) => c[0].label === "tile-indices");
    expect(countsCall).toBeDefined();
    expect(countsCall[0].size).toBe(expectedCountsSize);
    expect(indicesCall).toBeDefined();
    expect(indicesCall[0].size).toBe(expectedIndicesSize);
  });

  it("should reuse tile buffers for same resolution", () => {
    const device = makeMockDevice();
    const createBufferMock = (device as any).createBuffer;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    const splatBuffer = { destroy: vi.fn() } as any;
    const viewProj = Array.from({ length: 16 }, () => 0);

    pipeline.binSplats(splatBuffer, 100, viewProj, 800, 600);
    const buffersAfterFirst = createBufferMock.mock.calls.length;
    pipeline.binSplats(splatBuffer, 100, viewProj, 800, 600);
    // No new tile buffers should be created for same resolution
    expect(createBufferMock.mock.calls.length).toBe(buffersAfterFirst);
  });

  it("should recreate tile buffers when resolution changes", () => {
    const device = makeMockDevice();
    const createBufferMock = (device as any).createBuffer;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    const splatBuffer = { destroy: vi.fn() } as any;
    const viewProj = Array.from({ length: 16 }, () => 0);

    pipeline.binSplats(splatBuffer, 100, viewProj, 800, 600);
    const buffersAfterFirst = createBufferMock.mock.calls.length;
    pipeline.binSplats(splatBuffer, 100, viewProj, 1920, 1080);
    // New tile buffers should be created for different resolution
    expect(createBufferMock.mock.calls.length).toBeGreaterThan(buffersAfterFirst);
  });

  it("should submit compute commands on binSplats", () => {
    const device = makeMockDevice();
    const submitMock = (device as any).queue.submit;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    const submitsAfterPrepare = submitMock.mock.calls.length;

    const splatBuffer = { destroy: vi.fn() } as any;
    const viewProj = Array.from({ length: 16 }, () => 0);
    pipeline.binSplats(splatBuffer, 100, viewProj, 800, 600);

    // At least 1 submit (the bin compute pass)
    expect(submitMock.mock.calls.length - submitsAfterPrepare).toBeGreaterThanOrEqual(1);
  });

  it("should return raster pipeline and bind group layout", () => {
    const device = makeMockDevice();
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    expect(pipeline.getRasterPipeline()).toBeDefined();
    expect(pipeline.getRasterBindGroupLayout()).toBeDefined();
  });

  it("should create raster bind group with correct bindings", () => {
    const device = makeMockDevice();
    const createBindGroupMock = (device as any).createBindGroup;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);

    const splatBuffer = { destroy: vi.fn() } as any;
    const tileCounts = { destroy: vi.fn() } as any;
    const tileIndices = { destroy: vi.fn() } as any;
    const bg = pipeline.createRasterBindGroup(splatBuffer, tileCounts, tileIndices);
    expect(bg).toBeDefined();
    expect(createBindGroupMock).toHaveBeenCalled();
  });

  it("should write raster uniforms", () => {
    const device = makeMockDevice();
    const writeBufferMock = (device as any).queue.writeBuffer;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    const writesBefore = writeBufferMock.mock.calls.length;
    pipeline.writeRasterUniforms(1920, 1080);
    expect(writeBufferMock.mock.calls.length).toBeGreaterThan(writesBefore);
  });

  it("should destroy all buffers on destroy", () => {
    const device = makeMockDevice();
    const createBufferMock = (device as any).createBuffer;
    const pipeline = new TileRasterPipeline(device);
    pipeline.prepare(device);
    // Trigger tile buffer creation
    const splatBuffer = { destroy: vi.fn() } as any;
    const viewProj = Array.from({ length: 16 }, () => 0);
    pipeline.binSplats(splatBuffer, 100, viewProj, 800, 600);

    const buffersCreated = createBufferMock.mock.results;
    expect(() => pipeline.destroy()).not.toThrow();
    for (const result of buffersCreated) {
      expect(result.value.destroy).toHaveBeenCalled();
    }
  });
});
