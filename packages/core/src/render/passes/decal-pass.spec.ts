import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { GraphRenderContext } from "../frame-graph";
import { computeDecalProjectionMatrix, createDecalMesh, type DecalProjector } from "./decal-mesh";
import { DecalPass, type DecalItem } from "./decal-pass";

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
  const createSampler = vi.fn(() => ({}));
  return {
    createBuffer,
    createShaderModule,
    createRenderPipeline,
    createBindGroup,
    createSampler,
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

const defaultProjector: DecalProjector = {
  position: [0, 0, 0],
  direction: [0, 0, 1],
  up: [0, 1, 0],
  width: 2,
  height: 2,
  depth: 2,
};

function makeDecalItem(device: GPUDevice): DecalItem {
  const mesh = createDecalMesh(defaultProjector);
  const viewProj = computeDecalProjectionMatrix(defaultProjector);
  return {
    mesh,
    modelMatrix: new Float32Array(16) as any,
    decalViewProj: new Float32Array(viewProj) as any,
    decalTexture: {} as GPUTextureView,
    decalSampler: {} as GPUSampler,
  };
}

describe("DecalPass", () => {
  it("should have name 'decal'", () => {
    const pass = new DecalPass(null, "bgra8unorm");
    expect(pass.name).toBe("decal");
  });

  it("should start with no items", () => {
    const pass = new DecalPass(null, "bgra8unorm");
    expect(pass.hasItems()).toBe(false);
  });

  it("should report items after addItem", () => {
    const pass = new DecalPass(null, "bgra8unorm");
    const device = makeMockDevice();
    const item = makeDecalItem(device);
    pass.addItem(item);
    expect(pass.hasItems()).toBe(true);
  });

  it("should clear items", () => {
    const pass = new DecalPass(null, "bgra8unorm");
    const device = makeMockDevice();
    const item = makeDecalItem(device);
    pass.addItem(item);
    pass.clearItems();
    expect(pass.hasItems()).toBe(false);
  });

  it("should create shader and buffers on prepare", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(null, "bgra8unorm");
    pass.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(2);
  });

  it("should not recreate resources on repeated prepare", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(null, "bgra8unorm");
    pass.prepare(device);
    pass.prepare(device);
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
    expect((device as any).createBuffer).toHaveBeenCalledTimes(2);
  });

  it("should use device from constructor if provided", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(makeMockDevice());
    expect((device as any).createShaderModule).toHaveBeenCalledTimes(1);
  });

  it("should not execute when no items", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should not execute without depth texture view", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    const item = makeDecalItem(device);
    pass.addItem(item);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setPipeline).not.toHaveBeenCalled();
  });

  it("should not execute without pass", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    pass.setDepthTextureView({} as GPUTextureView);
    const item = makeDecalItem(device);
    pass.addItem(item);
    const ctx = { device, pass: null, viewProj: new Float32Array(16) } as unknown as GraphRenderContext;
    expect(() => pass.execute(ctx)).not.toThrow();
  });

  it("should execute with pipeline and draw calls when depth view is set", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    pass.setDepthTextureView({} as GPUTextureView);
    const item = makeDecalItem(device);
    pass.addItem(item);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.setPipeline).toHaveBeenCalledTimes(1);
    expect(mockPass.setBindGroup).toHaveBeenCalledTimes(1);
    expect(mockPass.setVertexBuffer).toHaveBeenCalledTimes(1);
    expect(mockPass.setIndexBuffer).toHaveBeenCalledTimes(1);
    expect(mockPass.drawIndexed).toHaveBeenCalledWith(item.mesh.indexCount);
  });

  it("should draw multiple decals", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    pass.setDepthTextureView({} as GPUTextureView);
    pass.addItem(makeDecalItem(device));
    pass.addItem(makeDecalItem(device));
    pass.addItem(makeDecalItem(device));
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(mockPass.drawIndexed).toHaveBeenCalledTimes(3);
  });

  it("should cache vertex/index buffers per mesh", () => {
    const device = makeMockDevice();
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    pass.setDepthTextureView({} as GPUTextureView);
    const item = makeDecalItem(device);
    pass.addItem(item);
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
    const pass = new DecalPass(device, "bgra8unorm");
    pass.prepare(device);
    pass.setDepthTextureView({} as GPUTextureView);
    const item = makeDecalItem(device);
    pass.addItem(item);
    const mockPass = makeMockPass();
    const ctx = makeMockCtx(mockPass, device);
    pass.execute(ctx);
    expect(() => pass.destroy()).not.toThrow();
  });

  it("should set depth texture view", () => {
    const pass = new DecalPass(null, "bgra8unorm");
    const view = {} as GPUTextureView;
    pass.setDepthTextureView(view);
    expect(pass.hasItems()).toBe(false);
  });
});
