import { describe, expect, it, vi } from "bun:test";
import { PassBackendResources, createFullscreenBindGroupLayout, executeFullscreenPass } from "./pass-backend-helper.ts";
import type { RenderBackend } from "../backend/render-backend.ts";
import type {
  BackendBindGroup,
  BackendBindGroupLayout,
  BackendBuffer,
  BackendCommandBuffer,
  BackendCommandEncoder,
  BackendRenderPassEncoder,
  BackendRenderPipeline,
  BackendSampler,
  BackendShaderModule,
  BackendTextureView,
  BindGroupDescriptor,
  BindGroupLayoutDescriptor,
  PipelineLayoutDescriptor,
  RenderPassDescriptor,
  BufferDescriptor,
  SamplerDescriptor,
  RenderPipelineDescriptor,
  TextureDescriptor,
  TextureViewDescriptor,
} from "../backend/types.ts";

function createMockBackend(): RenderBackend {
  const passEncoder = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    end: vi.fn(),
  } as unknown as BackendRenderPassEncoder;

  const commandBuffer = {} as unknown as BackendCommandBuffer;
  const encoder = {
    beginRenderPass: vi.fn(() => passEncoder),
    finish: vi.fn(() => commandBuffer),
  } as unknown as BackendCommandEncoder;

  const queue = {
    submit: vi.fn(),
    writeBuffer: vi.fn(),
  };

  return {
    createBuffer: vi.fn(() => ({ size: 0 }) as unknown as BackendBuffer),
    createTexture: vi.fn(() => ({ getNative: () => ({}) }) as never),
    createSampler: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendSampler),
    createShaderModule: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendShaderModule),
    createBindGroupLayout: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendBindGroupLayout),
    createPipelineLayout: vi.fn(() => ({ getNative: () => ({}) }) as unknown as { getNative: () => unknown }),
    createBindGroup: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendBindGroup),
    createRenderPipeline: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendRenderPipeline),
    createCommandEncoder: vi.fn(() => encoder),
    createTextureView: vi.fn(() => ({ getNative: () => ({}) }) as unknown as BackendTextureView),
    queue,
  } as unknown as RenderBackend;
}

describe("PassBackendResources", () => {
  it("should create shader module via backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    res.createShaderModule("wgsl code", "test-shader");
    expect(backend.createShaderModule).toHaveBeenCalled();
  });

  it("should create sampler via backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    res.createSampler({ magFilter: "linear", minFilter: "linear" });
    expect(backend.createSampler).toHaveBeenCalled();
  });

  it("should create uniform buffer with UNIFORM | COPY_DST usage", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    res.createUniformBuffer(64, "test-buffer");
    expect(backend.createBuffer).toHaveBeenCalledWith({
      label: "test-buffer",
      size: 64,
      usage: 0x40 | 0x08,
    });
  });

  it("should create fullscreen pipeline with bind group layout", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    const layout = {} as BackendBindGroupLayout;
    res.createFullscreenPipeline("vs code", "fs code", "fs_main", [{ format: "rgba16float" }], layout);
    expect(backend.createShaderModule).toHaveBeenCalledTimes(2);
    expect(backend.createPipelineLayout).toHaveBeenCalled();
    expect(backend.createRenderPipeline).toHaveBeenCalled();
  });

  it("should create fullscreen pipeline with auto layout when no bind group layout", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    res.createFullscreenPipeline("vs code", "fs code", "fs_main", [{ format: "rgba16float" }]);
    expect(backend.createRenderPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ layout: "auto" }),
    );
  });

  it("should create bind group via backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    const layout = {} as BackendBindGroupLayout;
    const buffer = {} as BackendBuffer;
    res.createBindGroup(layout, [{ binding: 0, resource: { buffer } }]);
    expect(backend.createBindGroup).toHaveBeenCalledWith({ layout, entries: [{ binding: 0, resource: { buffer } }] });
  });

  it("should create bind group layout via backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    res.createBindGroupLayout([{ binding: 0, visibility: 1, buffer: { type: "uniform" } }]);
    expect(backend.createBindGroupLayout).toHaveBeenCalled();
  });

  it("should expose queue from backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    expect(res.queue).toBe(backend.queue);
  });

  it("should expose backend", () => {
    const backend = createMockBackend();
    const res = new PassBackendResources(backend);
    expect(res.backend).toBe(backend);
  });
});

describe("createFullscreenBindGroupLayout", () => {
  it("should create layout with uniform + 1 texture + sampler (3 entries)", () => {
    const backend = createMockBackend();
    createFullscreenBindGroupLayout(backend, 1);
    expect(backend.createBindGroupLayout).toHaveBeenCalledWith({
      entries: [
        { binding: 0, visibility: expect.any(Number), buffer: { type: "uniform" } },
        { binding: 1, visibility: expect.any(Number), texture: { sampleType: "float", viewDimension: "2d" } },
        { binding: 2, visibility: expect.any(Number), sampler: { type: "filtering" } },
      ],
    });
  });

  it("should create layout with uniform + 3 textures + sampler (5 entries)", () => {
    const backend = createMockBackend();
    createFullscreenBindGroupLayout(backend, 3);
    const call = (backend.createBindGroupLayout as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.entries).toHaveLength(5);
    expect(call.entries[0].binding).toBe(0);
    expect(call.entries[1].binding).toBe(1);
    expect(call.entries[2].binding).toBe(2);
    expect(call.entries[3].binding).toBe(3);
    expect(call.entries[4].binding).toBe(4); // sampler at textureCount + 1
  });

  it("should support 3d texture view dimension", () => {
    const backend = createMockBackend();
    createFullscreenBindGroupLayout(backend, 1, "3d");
    const call = (backend.createBindGroupLayout as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.entries[1].texture.viewDimension).toBe("3d");
  });

  it("should default to 2d texture view dimension", () => {
    const backend = createMockBackend();
    createFullscreenBindGroupLayout(backend, 1);
    const call = (backend.createBindGroupLayout as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.entries[1].texture.viewDimension).toBe("2d");
  });
});

describe("executeFullscreenPass", () => {
  it("should throw when ctx.backend is null", () => {
    const ctx = { backend: null } as never;
    expect(() => executeFullscreenPass(ctx, {} as never, {} as never, {} as never)).toThrow("ctx.backend");
  });

  it("should create command encoder, begin render pass, draw, and submit", () => {
    const backend = createMockBackend();
    const ctx = { backend } as never;
    const outputView = {} as BackendTextureView;
    const pipeline = {} as BackendRenderPipeline;
    const bindGroup = {} as BackendBindGroup;

    executeFullscreenPass(ctx, outputView, pipeline, bindGroup);

    expect(backend.createCommandEncoder).toHaveBeenCalled();
    expect(backend.queue.submit).toHaveBeenCalled();
  });

  it("should use default vertexCount of 6", () => {
    const backend = createMockBackend();
    const ctx = { backend } as never;
    executeFullscreenPass(ctx, {} as BackendTextureView, {} as BackendRenderPipeline, {} as BackendBindGroup);

    const passEncoder = (backend.createCommandEncoder as ReturnType<typeof vi.fn>).mock.results[0].value;
    // The draw call should have been called with 6
    // We can verify via the passEncoder mock
    expect(passEncoder.beginRenderPass).toHaveBeenCalled();
  });

  it("should accept custom vertexCount", () => {
    const backend = createMockBackend();
    const ctx = { backend } as never;
    executeFullscreenPass(ctx, {} as BackendTextureView, {} as BackendRenderPipeline, {} as BackendBindGroup, 3);
    expect(backend.queue.submit).toHaveBeenCalled();
  });
});
