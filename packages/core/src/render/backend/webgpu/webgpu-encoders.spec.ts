import { describe, it, expect, vi } from "bun:test";
import {
  WebGPUCommandBuffer,
  WebGPUCommandEncoder,
  WebGPURenderPassEncoder,
  WebGPUComputePassEncoder,
} from "./webgpu-encoders.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMockGPUBuffer() {
  return { } as unknown as GPUBuffer;
}

function makeMockGPUTexture() {
  return { } as unknown as GPUTexture;
}

function makeMockGPUTextureView() {
  return { } as unknown as GPUTextureView;
}

function makeMockBackendBuffer() {
  return { gpuBuffer: makeMockGPUBuffer() } as unknown as import("../types.ts").BackendBuffer;
}

function makeMockBackendTexture() {
  return { gpuTexture: makeMockGPUTexture() } as unknown as import("../types.ts").BackendTexture;
}

function makeMockBackendTextureView() {
  return { gpuView: makeMockGPUTextureView() } as unknown as import("../types.ts").BackendTextureView;
}

function makeMockBackendRenderPipeline() {
  return { gpuPipeline: {} } as unknown as import("../types.ts").BackendRenderPipeline;
}

function makeMockBackendBindGroup() {
  return { gpuGroup: {} } as unknown as import("../types.ts").BackendBindGroup;
}

// ─── WebGPUCommandBuffer ────────────────────────────────────────────────────

describe("WebGPUCommandBuffer", () => {
  it("getNative returns the underlying GPUCommandBuffer", () => {
    const mock = {} as GPUCommandBuffer;
    const cb = new WebGPUCommandBuffer(mock);
    expect(cb.getNative()).toBe(mock);
  });

  it("gpuCommandBuffer getter returns the underlying buffer", () => {
    const mock = {} as GPUCommandBuffer;
    const cb = new WebGPUCommandBuffer(mock);
    expect(cb.gpuCommandBuffer).toBe(mock);
  });
});

// ─── WebGPUCommandEncoder ───────────────────────────────────────────────────

describe("WebGPUCommandEncoder", () => {
  it("getNative returns the underlying GPUCommandEncoder", () => {
    const mock = {} as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);
    expect(enc.getNative()).toBe(mock);
  });

  it("gpuEncoder getter returns the underlying encoder", () => {
    const mock = {} as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);
    expect(enc.gpuEncoder).toBe(mock);
  });

  it("beginRenderPass calls underlying beginRenderPass and returns wrapper", () => {
    const mockPass = {} as GPURenderPassEncoder;
    const mock = {
      beginRenderPass: vi.fn().mockReturnValue(mockPass),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const view = makeMockBackendTextureView();
    const result = enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: undefined,
    });

    expect(mock.beginRenderPass).toHaveBeenCalledTimes(1);
    expect(result).toBeInstanceOf(WebGPURenderPassEncoder);
  });

  it("beginRenderPass maps depthStencilAttachment correctly", () => {
    const mockPass = {} as GPURenderPassEncoder;
    const mock = {
      beginRenderPass: vi.fn().mockReturnValue(mockPass),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const view = makeMockBackendTextureView();
    enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthLoadOp: "clear",
        depthStoreOp: "store",
        depthClearValue: 1.0,
        depthReadOnly: false,
        stencilLoadOp: "clear",
        stencilStoreOp: "store",
        stencilClearValue: 0,
        stencilReadOnly: false,
      },
    });

    const call = (mock.beginRenderPass as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.depthStencilAttachment).toBeDefined();
    expect(call.depthStencilAttachment.depthClearValue).toBe(1.0);
    expect(call.depthStencilAttachment.stencilClearValue).toBe(0);
  });

  it("beginRenderPass uses default clearValue when not provided", () => {
    const mockPass = {} as GPURenderPassEncoder;
    const mock = {
      beginRenderPass: vi.fn().mockReturnValue(mockPass),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const view = makeMockBackendTextureView();
    enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: undefined,
    });

    const call = (mock.beginRenderPass as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.colorAttachments[0].clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("beginRenderPass uses undefined resolveTarget when not provided", () => {
    const mockPass = {} as GPURenderPassEncoder;
    const mock = {
      beginRenderPass: vi.fn().mockReturnValue(mockPass),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const view = makeMockBackendTextureView();
    enc.beginRenderPass({
      colorAttachments: [
        {
          view,
          loadOp: "load",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: undefined,
    });

    const call = (mock.beginRenderPass as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.colorAttachments[0].resolveTarget).toBeUndefined();
  });

  it("beginComputePass calls underlying method and returns wrapper", () => {
    const mockPass = {} as GPUComputePassEncoder;
    const mock = {
      beginComputePass: vi.fn().mockReturnValue(mockPass),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const result = enc.beginComputePass({ label: "test" });
    expect(mock.beginComputePass).toHaveBeenCalledWith({ label: "test" });
    expect(result).toBeInstanceOf(WebGPUComputePassEncoder);
  });

  it("copyBufferToBuffer calls underlying method with gpuBuffer", () => {
    const mock = {
      copyBufferToBuffer: vi.fn(),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const src = makeMockBackendBuffer();
    const dst = makeMockBackendBuffer();
    enc.copyBufferToBuffer(src, 0, dst, 64, 128);

    expect(mock.copyBufferToBuffer).toHaveBeenCalledWith(
      (src as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer,
      0,
      (dst as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer,
      64,
      128,
    );
  });

  it("copyBufferToTexture calls underlying method with gpu objects", () => {
    const mock = {
      copyBufferToTexture: vi.fn(),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const buf = makeMockBackendBuffer();
    const tex = makeMockBackendTexture();
    enc.copyBufferToTexture(
      { buffer: buf, offset: 0, bytesPerRow: 256 },
      { texture: tex, mipLevel: 0, origin: [0, 0, 0] },
      [64, 64, 1],
    );

    expect(mock.copyBufferToTexture).toHaveBeenCalledTimes(1);
  });

  it("copyTextureToBuffer calls underlying method with gpu objects", () => {
    const mock = {
      copyTextureToBuffer: vi.fn(),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const tex = makeMockBackendTexture();
    const buf = makeMockBackendBuffer();
    enc.copyTextureToBuffer(
      { texture: tex, mipLevel: 0, origin: [0, 0, 0] },
      { buffer: buf, offset: 0, bytesPerRow: 256 },
      [64, 64, 1],
    );

    expect(mock.copyTextureToBuffer).toHaveBeenCalledTimes(1);
  });

  it("copyTextureToTexture calls underlying method with gpu objects", () => {
    const mock = {
      copyTextureToTexture: vi.fn(),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const srcTex = makeMockBackendTexture();
    const dstTex = makeMockBackendTexture();
    enc.copyTextureToTexture(
      { texture: srcTex, mipLevel: 0, origin: [0, 0, 0] },
      { texture: dstTex, mipLevel: 1, origin: [0, 0, 0] },
      [32, 32, 1],
    );

    expect(mock.copyTextureToTexture).toHaveBeenCalledTimes(1);
  });

  it("finish returns a WebGPUCommandBuffer wrapping the result", () => {
    const mockCmd = {} as GPUCommandBuffer;
    const mock = {
      finish: vi.fn().mockReturnValue(mockCmd),
    } as unknown as GPUCommandEncoder;
    const enc = new WebGPUCommandEncoder(mock);

    const result = enc.finish();
    expect(result).toBeInstanceOf(WebGPUCommandBuffer);
    expect(result.getNative()).toBe(mockCmd);
  });
});

// ─── WebGPURenderPassEncoder ────────────────────────────────────────────────

describe("WebGPURenderPassEncoder", () => {
  it("getNative returns the underlying pass", () => {
    const mock = {} as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    expect(pass.getNative()).toBe(mock);
  });

  it("gpuPass getter returns the underlying pass", () => {
    const mock = {} as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    expect(pass.gpuPass).toBe(mock);
  });

  it("setPipeline calls underlying setPipeline with gpuPipeline", () => {
    const mock = { setPipeline: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const pipeline = makeMockBackendRenderPipeline();
    pass.setPipeline(pipeline);
    expect(mock.setPipeline).toHaveBeenCalledWith({});
  });

  it("setBindGroup calls underlying setBindGroup with gpuGroup", () => {
    const mock = { setBindGroup: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const bg = makeMockBackendBindGroup();
    pass.setBindGroup(0, bg, [16, 32]);
    expect(mock.setBindGroup).toHaveBeenCalledWith(0, {}, [16, 32]);
  });

  it("setBindGroup uses empty array when no dynamic offsets", () => {
    const mock = { setBindGroup: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const bg = makeMockBackendBindGroup();
    pass.setBindGroup(1, bg);
    expect(mock.setBindGroup).toHaveBeenCalledWith(1, {}, []);
  });

  it("setVertexBuffer calls underlying method with gpuBuffer", () => {
    const mock = { setVertexBuffer: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.setVertexBuffer(0, buf, 32);
    expect(mock.setVertexBuffer).toHaveBeenCalledWith(0, (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, 32);
  });

  it("setVertexBuffer uses default offset 0", () => {
    const mock = { setVertexBuffer: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.setVertexBuffer(0, buf);
    expect(mock.setVertexBuffer).toHaveBeenCalledWith(0, (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, 0);
  });

  it("setIndexBuffer calls underlying method with gpuBuffer", () => {
    const mock = { setIndexBuffer: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.setIndexBuffer(buf, "uint16", 0);
    expect(mock.setIndexBuffer).toHaveBeenCalledWith(
      (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, "uint16", 0,
    );
  });

  it("setViewport calls underlying method", () => {
    const mock = { setViewport: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.setViewport(0, 0, 800, 600, 0, 1);
    expect(mock.setViewport).toHaveBeenCalledWith(0, 0, 800, 600, 0, 1);
  });

  it("setScissorRect calls underlying method", () => {
    const mock = { setScissorRect: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.setScissorRect(0, 0, 400, 300);
    expect(mock.setScissorRect).toHaveBeenCalledWith(0, 0, 400, 300);
  });

  it("setBlendColor is a no-op (does not throw)", () => {
    const mock = {} as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    expect(() => pass.setBlendColor(0.5, 0.5, 0.5, 1.0)).not.toThrow();
  });

  it("setStencilReference calls underlying method", () => {
    const mock = { setStencilReference: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.setStencilReference(42);
    expect(mock.setStencilReference).toHaveBeenCalledWith(42);
  });

  it("draw calls underlying method with all params", () => {
    const mock = { draw: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.draw(6, 2, 0, 0);
    expect(mock.draw).toHaveBeenCalledWith(6, 2, 0, 0);
  });

  it("draw uses default instanceCount=1, firstVertex=0, firstInstance=0", () => {
    const mock = { draw: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.draw(3);
    expect(mock.draw).toHaveBeenCalledWith(3, 1, 0, 0);
  });

  it("drawIndexed calls underlying method with all params", () => {
    const mock = { drawIndexed: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.drawIndexed(36, 1, 0, 0, 0);
    expect(mock.drawIndexed).toHaveBeenCalledWith(36, 1, 0, 0, 0);
  });

  it("drawIndexed uses defaults for optional params", () => {
    const mock = { drawIndexed: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.drawIndexed(6);
    expect(mock.drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
  });

  it("drawIndirect calls underlying method with gpuBuffer", () => {
    const mock = { drawIndirect: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.drawIndirect(buf, 0);
    expect(mock.drawIndirect).toHaveBeenCalledWith(
      (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, 0,
    );
  });

  it("drawIndexedIndirect calls underlying method with gpuBuffer", () => {
    const mock = { drawIndexedIndirect: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.drawIndexedIndirect(buf, 16);
    expect(mock.drawIndexedIndirect).toHaveBeenCalledWith(
      (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, 16,
    );
  });

  it("end calls underlying method", () => {
    const mock = { end: vi.fn() } as unknown as GPURenderPassEncoder;
    const pass = new WebGPURenderPassEncoder(mock);
    pass.end();
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
});

// ─── WebGPUComputePassEncoder ───────────────────────────────────────────────

describe("WebGPUComputePassEncoder", () => {
  it("getNative returns the underlying pass", () => {
    const mock = {} as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    expect(pass.getNative()).toBe(mock);
  });

  it("gpuPass getter returns the underlying pass", () => {
    const mock = {} as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    expect(pass.gpuPass).toBe(mock);
  });

  it("setPipeline calls underlying setPipeline", () => {
    const mock = { setPipeline: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    const pipeline = {} as GPUComputePipeline;
    pass.setPipeline(pipeline);
    expect(mock.setPipeline).toHaveBeenCalledWith(pipeline);
  });

  it("setBindGroup calls underlying method with gpuGroup", () => {
    const mock = { setBindGroup: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    const bg = makeMockBackendBindGroup();
    pass.setBindGroup(0, bg, [16]);
    expect(mock.setBindGroup).toHaveBeenCalledWith(0, {}, [16]);
  });

  it("setBindGroup uses empty array when no dynamic offsets", () => {
    const mock = { setBindGroup: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    const bg = makeMockBackendBindGroup();
    pass.setBindGroup(0, bg);
    expect(mock.setBindGroup).toHaveBeenCalledWith(0, {}, []);
  });

  it("dispatchWorkgroups calls underlying method with defaults", () => {
    const mock = { dispatchWorkgroups: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    pass.dispatchWorkgroups(64);
    expect(mock.dispatchWorkgroups).toHaveBeenCalledWith(64, 1, 1);
  });

  it("dispatchWorkgroups calls underlying method with all params", () => {
    const mock = { dispatchWorkgroups: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    pass.dispatchWorkgroups(32, 16, 8);
    expect(mock.dispatchWorkgroups).toHaveBeenCalledWith(32, 16, 8);
  });

  it("dispatchWorkgroupsIndirect calls underlying method with gpuBuffer", () => {
    const mock = { dispatchWorkgroupsIndirect: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    const buf = makeMockBackendBuffer();
    pass.dispatchWorkgroupsIndirect(buf, 0);
    expect(mock.dispatchWorkgroupsIndirect).toHaveBeenCalledWith(
      (buf as unknown as { gpuBuffer: GPUBuffer }).gpuBuffer, 0,
    );
  });

  it("end calls underlying method", () => {
    const mock = { end: vi.fn() } as unknown as GPUComputePassEncoder;
    const pass = new WebGPUComputePassEncoder(mock);
    pass.end();
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
});
