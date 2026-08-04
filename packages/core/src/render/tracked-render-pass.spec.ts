import { describe, expect, it, vi } from "bun:test";
import { TrackedRenderPass } from "./tracked-render-pass";

describe("TrackedRenderPass", () => {
  it("should initialize with zero stats", () => {
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

describe("TrackedRenderPass — setIndexBuffer with different buffer", () => {
  it("should track rebind when buffer changes but format stays same", () => {
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
    const buf1 = {} as GPUBuffer;
    const buf2 = {} as GPUBuffer;

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
