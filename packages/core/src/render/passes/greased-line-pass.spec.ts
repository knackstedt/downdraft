import { beforeAll, describe, expect, it, vi } from "bun:test";
import { createGreasedLine } from "../../mesh/greased-line.ts";
import type { GraphRenderContext } from "../frame-graph.ts";
import { GreasedLinePass } from "./greased-line-pass.ts";

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
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    drawIndexed: vi.fn(),
  };
}

function makeMockCtx(pass: any, device: GPUDevice): GraphRenderContext {
  return {
    device,
    pass,
    viewProj: new Float32Array(16) as any,
    width: 800,
    height: 600,
    addDrawCalls: vi.fn(),
    addTriangles: vi.fn(),
  } as unknown as GraphRenderContext;
}

describe("GreasedLinePass", () => {
  it("should have name 'greased-line'", () => {
    const pass = new GreasedLinePass(null, "bgra8unorm");
    expect(pass.name).toBe("greased-line");
  });

  it("should start with no lines", () => {
    const pass = new GreasedLinePass(null, "bgra8unorm");
    expect(pass.hasLines()).toBe(false);
  });

  it("should report lines after addLine", () => {
    const pass = new GreasedLinePass(null, "bgra8unorm");
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    expect(pass.hasLines()).toBe(true);
  });

  it("should clear lines", () => {
    const pass = new GreasedLinePass(null, "bgra8unorm");
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    expect(pass.hasLines()).toBe(true);
    pass.clearLines();
    expect(pass.hasLines()).toBe(false);
  });

  it("should create shader and buffer on prepare", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(null, "bgra8unorm");
    pass.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(1);
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(null, "bgra8unorm");
    pass.prepare(device);
    pass.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(1);
  });

  it("should use device from constructor if provided", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(makeMockDevice());
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
  });

  it("should not execute when no lines", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should not execute without pass", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    const ctx = { device, pass: null, viewProj: new Float32Array(16) } as unknown as GraphRenderContext;
    expect(() => pass.execute(ctx)).not.toThrow();
  });

  it("should execute with pipeline, bind group, and draw calls", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }, { position: [2, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setPipeline).toHaveBeenCalledTimes(1);
    expect(mockPass.setBindGroup).toHaveBeenCalledTimes(1);
    expect(mockPass.setVertexBuffer).toHaveBeenCalledTimes(1);
    expect(mockPass.setIndexBuffer).toHaveBeenCalledTimes(1);
    expect(mockPass.drawIndexed).toHaveBeenCalledWith(line.indexCount);
  });

  it("should draw multiple lines", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const line1 = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    const line2 = createGreasedLine([{ position: [0, 1, 0] }, { position: [1, 1, 0] }]);
    pass.addLine(line1, new Float32Array(16) as any);
    pass.addLine(line2, new Float32Array(16) as any);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.drawIndexed).toHaveBeenCalledTimes(2);
  });

  it("should cache vertex/index buffers per line data", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    const createBufferCallsBefore = (device as any).createBuffer.mock.calls.length;
    pass.execute(ctx);
    const createBufferCallsAfter = (device as any).createBuffer.mock.calls.length;
    expect(createBufferCallsAfter).toBe(createBufferCallsBefore);
  });

  it("should destroy buffers on destroy", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const line = createGreasedLine([{ position: [0, 0, 0] }, { position: [1, 0, 0] }]);
    pass.addLine(line, new Float32Array(16) as any);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(() => pass.destroy()).not.toThrow();
  });

  it("should set camera view-projection without error", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const viewProj = new Float32Array(16);
    viewProj[0] = 1;
    expect(() => pass.setCameraViewProj(viewProj as any, [800, 600])).not.toThrow();
    expect((device as any).queue.writeBuffer).toHaveBeenCalled();
  });

  it("should handle Uint32Array indices", () => {
    const device = makeMockDevice();
    const pass = new GreasedLinePass(device, "bgra8unorm");
    pass.prepare(device);
    const points = Array.from({ length: 20000 }, (_, i) => ({ position: [i, 0, 0] as [number, number, number] }));
    const line = createGreasedLine(points);
    expect(line.indices instanceof Uint32Array).toBe(true);
    pass.addLine(line, new Float32Array(16) as any);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setIndexBuffer).toHaveBeenCalledWith(expect.anything(), "uint32");
  });
});
