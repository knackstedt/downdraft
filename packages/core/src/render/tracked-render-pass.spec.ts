import { describe, expect, it, vi } from "bun:test";
import type { BackendRenderPassEncoder } from "./backend/types.ts";
import { BackendTrackedRenderPass, TrackedRenderPass, type ITrackedRenderPass } from "./tracked-render-pass.ts";

function createMockBackendPassEncoder(): BackendRenderPassEncoder {
  return {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    setViewport: vi.fn(),
    setScissorRect: vi.fn(),
    setBlendColor: vi.fn(),
    setStencilReference: vi.fn(),
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    drawIndirect: vi.fn(),
    drawIndexedIndirect: vi.fn(),
    end: vi.fn(),
    getNative: vi.fn(),
  } as unknown as BackendRenderPassEncoder;
}

describe("BackendTrackedRenderPass", () => {
  it("should implement ITrackedRenderPass", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    expect(pass).toBeDefined();
    expect(pass.drawCalls).toBe(0);
    expect(pass.triangles).toBe(0);
    expect(pass.pipelineSwitches).toBe(0);
    expect(pass.bindGroupChanges).toBe(0);
    expect(pass.bufferRebinds).toBe(0);
  });

  it("setPipeline should delegate to encoder and track switches", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const pipeline = {} as any;

    pass.setPipeline(pipeline);
    expect(encoder.setPipeline).toHaveBeenCalledTimes(1);
    expect(pass.pipelineSwitches).toBe(1);

    // Same pipeline — should not increment
    pass.setPipeline(pipeline);
    expect(encoder.setPipeline).toHaveBeenCalledTimes(1);
    expect(pass.pipelineSwitches).toBe(1);

    // Different pipeline — should increment
    const pipeline2 = {} as any;
    pass.setPipeline(pipeline2);
    expect(encoder.setPipeline).toHaveBeenCalledTimes(2);
    expect(pass.pipelineSwitches).toBe(2);
  });

  it("setBindGroup should delegate to encoder and track changes", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const group = {} as any;

    pass.setBindGroup(0, group);
    expect(encoder.setBindGroup).toHaveBeenCalledTimes(1);
    expect(pass.bindGroupChanges).toBe(1);

    // Same group — no increment
    pass.setBindGroup(0, group);
    expect(encoder.setBindGroup).toHaveBeenCalledTimes(1);
    expect(pass.bindGroupChanges).toBe(1);

    // Different group at same index — increment
    const group2 = {} as any;
    pass.setBindGroup(0, group2);
    expect(encoder.setBindGroup).toHaveBeenCalledTimes(2);
    expect(pass.bindGroupChanges).toBe(2);

    // Different index — increment
    pass.setBindGroup(1, group);
    expect(encoder.setBindGroup).toHaveBeenCalledTimes(3);
    expect(pass.bindGroupChanges).toBe(3);
  });

  it("setBindGroup should pass dynamic offsets", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const group = {} as any;

    pass.setBindGroup(0, group, [16, 32]);
    expect(encoder.setBindGroup).toHaveBeenCalledWith(0, group, [16, 32]);
  });

  it("setVertexBuffer should delegate to encoder and track rebinds", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const buf = {} as any;

    pass.setVertexBuffer(0, buf);
    expect(encoder.setVertexBuffer).toHaveBeenCalledTimes(1);
    expect(pass.bufferRebinds).toBe(1);

    // Same buffer — no increment
    pass.setVertexBuffer(0, buf);
    expect(encoder.setVertexBuffer).toHaveBeenCalledTimes(1);
    expect(pass.bufferRebinds).toBe(1);

    // Different buffer — increment
    const buf2 = {} as any;
    pass.setVertexBuffer(0, buf2);
    expect(encoder.setVertexBuffer).toHaveBeenCalledTimes(2);
    expect(pass.bufferRebinds).toBe(2);
  });

  it("setVertexBuffer should pass offset", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const buf = {} as any;

    pass.setVertexBuffer(0, buf, 64);
    expect(encoder.setVertexBuffer).toHaveBeenCalledWith(0, buf, 64);
  });

  it("setIndexBuffer should delegate to encoder and track rebinds", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const buf = {} as any;

    pass.setIndexBuffer(buf, "uint16");
    expect(encoder.setIndexBuffer).toHaveBeenCalledTimes(1);
    expect(pass.bufferRebinds).toBe(1);

    // Same buffer + format — no increment
    pass.setIndexBuffer(buf, "uint16");
    expect(encoder.setIndexBuffer).toHaveBeenCalledTimes(1);
    expect(pass.bufferRebinds).toBe(1);

    // Different format — increment
    pass.setIndexBuffer(buf, "uint32");
    expect(encoder.setIndexBuffer).toHaveBeenCalledTimes(2);
    expect(pass.bufferRebinds).toBe(2);
  });

  it("draw should delegate to encoder and track draw calls + triangles", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);

    pass.draw(6);
    expect(encoder.draw).toHaveBeenCalledWith(6, 1, 0, 0);
    expect(pass.drawCalls).toBe(1);
    expect(pass.triangles).toBe(2); // 6/3 = 2

    pass.draw(3, 2);
    expect(encoder.draw).toHaveBeenCalledWith(3, 2, 0, 0);
    expect(pass.drawCalls).toBe(2);
    expect(pass.triangles).toBe(4); // 2 + (3/3)*2 = 4
  });

  it("drawIndexed should delegate to encoder and track draw calls + triangles", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);

    pass.drawIndexed(6);
    expect(encoder.drawIndexed).toHaveBeenCalledWith(6, 1, 0, 0, 0);
    expect(pass.drawCalls).toBe(1);
    expect(pass.triangles).toBe(2);

    pass.drawIndexed(9, 3, 0, 0, 0);
    expect(pass.drawCalls).toBe(2);
    expect(pass.triangles).toBe(11); // 2 + (9/3)*3 = 11
  });

  it("end should delegate to encoder", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);

    pass.end();
    expect(encoder.end).toHaveBeenCalledTimes(1);
  });

  it("resetStats should zero all counters", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);

    pass.setPipeline({} as any);
    pass.setBindGroup(0, {} as any);
    pass.setVertexBuffer(0, {} as any);
    pass.draw(3);

    expect(pass.drawCalls).toBe(1);
    expect(pass.pipelineSwitches).toBe(1);
    expect(pass.bindGroupChanges).toBe(1);
    expect(pass.bufferRebinds).toBe(1); // only vertex buffer bind
    expect(pass.triangles).toBe(1);

    pass.resetStats();
    expect(pass.drawCalls).toBe(0);
    expect(pass.triangles).toBe(0);
    expect(pass.pipelineSwitches).toBe(0);
    expect(pass.bindGroupChanges).toBe(0);
    expect(pass.bufferRebinds).toBe(0);
  });

  it("getRawPass should return the underlying encoder", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);

    expect(pass.getRawPass()).toBe(encoder);
  });
});

describe("TrackedRenderPass (WebGPU) implements ITrackedRenderPass", () => {
  it("should be assignable to ITrackedRenderPass", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass: ITrackedRenderPass = new TrackedRenderPass(mockGpuPass);
    expect(pass).toBeDefined();
    expect(pass.drawCalls).toBe(0);
  });

  it("setPipeline should delegate to GPU pass and track switches", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass = new TrackedRenderPass(mockGpuPass);
    const pipeline = {} as GPURenderPipeline;

    pass.setPipeline(pipeline);
    expect(mockGpuPass.setPipeline).toHaveBeenCalledTimes(1);
    expect(pass.pipelineSwitches).toBe(1);

    // Same pipeline — no increment
    pass.setPipeline(pipeline);
    expect(pass.pipelineSwitches).toBe(1);
  });

  it("setBindGroup should delegate to GPU pass and track changes", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass = new TrackedRenderPass(mockGpuPass);
    const group = {} as GPUBindGroup;

    pass.setBindGroup(0, group);
    expect(mockGpuPass.setBindGroup).toHaveBeenCalledTimes(1);
    expect(pass.bindGroupChanges).toBe(1);

    // Same group — no increment
    pass.setBindGroup(0, group);
    expect(pass.bindGroupChanges).toBe(1);
  });

  it("draw and drawIndexed should track draw calls + triangles", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass = new TrackedRenderPass(mockGpuPass);

    pass.draw(6);
    expect(pass.drawCalls).toBe(1);
    expect(pass.triangles).toBe(2);

    pass.drawIndexed(9, 2);
    expect(pass.drawCalls).toBe(2);
    expect(pass.triangles).toBe(8); // 2 + (9/3)*2 = 8
  });

  it("end should delegate to GPU pass", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass = new TrackedRenderPass(mockGpuPass);

    pass.end();
    expect(mockGpuPass.end).toHaveBeenCalledTimes(1);
  });

  it("getRawPass should return the underlying GPU pass encoder", () => {
    const mockGpuPass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      end: vi.fn(),
    } as unknown as GPURenderPassEncoder;
    const pass = new TrackedRenderPass(mockGpuPass);

    expect(pass.getRawPass()).toBe(mockGpuPass);
  });
});

describe("BackendTrackedRenderPass — setIndexBuffer with different buffer", () => {
  it("should track rebind when buffer changes but format stays same", () => {
    const encoder = createMockBackendPassEncoder();
    const pass = new BackendTrackedRenderPass(encoder);
    const buf1 = {} as any;
    const buf2 = {} as any;

    pass.setIndexBuffer(buf1, "uint16");
    expect(pass.bufferRebinds).toBe(1);

    // Same buffer + format — no increment
    pass.setIndexBuffer(buf1, "uint16");
    expect(pass.bufferRebinds).toBe(1);

    // Different buffer, same format — increment
    pass.setIndexBuffer(buf2, "uint16");
    expect(pass.bufferRebinds).toBe(2);
  });
});
