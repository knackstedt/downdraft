import { describe, it, expect, vi } from "bun:test";
import {
  WebGL2CommandEncoder,
  WebGL2CommandBuffer,
  WebGL2RenderPassEncoder,
  WebGL2ComputePassEncoder,
  type Command,
} from "./webgl2-encoders.ts";
import type {
  RenderPassDescriptor,
  BackendBuffer,
  BackendTexture,
  BackendRenderPipeline,
  BackendBindGroup,
} from "../types.ts";

// ─── Mock resources for testing ────────────────────────────────────────────

function mockBuffer(usage = 32): BackendBuffer {
  return {
    size: 256, usage, label: undefined,
    destroy: vi.fn(), getNative: vi.fn(() => ({})),
  } as unknown as BackendBuffer;
}

function mockTexture(): BackendTexture {
  return {
    width: 64, height: 64, depthOrArrayLayers: 1,
    format: "rgba8unorm", usage: 16, sampleCount: 1, mipLevelCount: 1,
    label: undefined,
    createView: vi.fn(() => ({ label: undefined, getNative: vi.fn() })),
    destroy: vi.fn(), getNative: vi.fn(() => ({})),
  } as unknown as BackendTexture;
}

// ─── WebGL2CommandBuffer ───────────────────────────────────────────────────

describe("WebGL2CommandBuffer", () => {
  it("stores commands array", () => {
    const cmds: Command[] = [
      { type: "setViewport", x: 0, y: 0, w: 800, h: 600, minD: 0, maxD: 1 },
    ];
    const cb = new WebGL2CommandBuffer(cmds);
    expect(cb.commands).toBe(cmds);
  });

  it("getNative() returns the commands array", () => {
    const cb = new WebGL2CommandBuffer([]);
    expect(cb.getNative()).toEqual([]);
  });
});

// ─── WebGL2RenderPassEncoder ───────────────────────────────────────────────

describe("WebGL2RenderPassEncoder", () => {
  function createPass(commands: Command[] = []): WebGL2RenderPassEncoder {
    const desc: RenderPassDescriptor = {
      colorAttachments: [],
    };
    return new WebGL2RenderPassEncoder(commands, desc);
  }

  it("begins render pass on construction", () => {
    const commands: Command[] = [];
    createPass(commands);
    expect(commands.length).toBe(1);
    expect(commands[0].type).toBe("beginRenderPass");
  });

  it("setPipeline records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    const pipeline = { label: "p", getNative: vi.fn() } as unknown as BackendRenderPipeline;
    pass.setPipeline(pipeline);
    expect(commands.some(c => c.type === "setPipeline")).toBe(true);
  });

  it("setBindGroup records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    const bg = { label: "bg", getNative: vi.fn() } as unknown as BackendBindGroup;
    pass.setBindGroup(0, bg, [0]);
    expect(commands.some(c => c.type === "setBindGroup")).toBe(true);
  });

  it("setBindGroup defaults dynamicOffsets to empty array", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    const bg = { label: "bg", getNative: vi.fn() } as unknown as BackendBindGroup;
    pass.setBindGroup(0, bg);
    const cmd = commands.find(c => c.type === "setBindGroup") as Extract<Command, { type: "setBindGroup" }>;
    expect(cmd.dynamicOffsets).toEqual([]);
  });

  it("setVertexBuffer records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.setVertexBuffer(0, mockBuffer());
    expect(commands.some(c => c.type === "setVertexBuffer")).toBe(true);
  });

  it("setVertexBuffer defaults offset to 0", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.setVertexBuffer(0, mockBuffer());
    const cmd = commands.find(c => c.type === "setVertexBuffer") as Extract<Command, { type: "setVertexBuffer" }>;
    expect(cmd.offset).toBe(0);
  });

  it("setIndexBuffer records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.setIndexBuffer(mockBuffer(16), "uint16");
    expect(commands.some(c => c.type === "setIndexBuffer")).toBe(true);
  });

  it("setViewport records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.setViewport(0, 0, 800, 600, 0, 1);
    const cmd = commands.find(c => c.type === "setViewport");
    expect(cmd).toBeDefined();
  });

  it("setScissorRect records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.setScissorRect(0, 0, 100, 100);
    expect(commands.some(c => c.type === "setScissor")).toBe(true);
  });

  it("setBlendColor does not throw", () => {
    const pass = createPass();
    expect(() => pass.setBlendColor(0.5, 0.5, 0.5, 1)).not.toThrow();
  });

  it("setStencilReference does not throw", () => {
    const pass = createPass();
    expect(() => pass.setStencilReference(1)).not.toThrow();
  });

  it("draw records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.draw(6);
    const cmd = commands.find(c => c.type === "draw") as Extract<Command, { type: "draw" }>;
    expect(cmd.vertexCount).toBe(6);
    expect(cmd.instanceCount).toBe(1);
    expect(cmd.firstVertex).toBe(0);
    expect(cmd.firstInstance).toBe(0);
  });

  it("draw with all parameters", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.draw(100, 10, 6, 0);
    const cmd = commands.find(c => c.type === "draw") as Extract<Command, { type: "draw" }>;
    expect(cmd.vertexCount).toBe(100);
    expect(cmd.instanceCount).toBe(10);
    expect(cmd.firstVertex).toBe(6);
  });

  it("drawIndexed records command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.drawIndexed(36);
    const cmd = commands.find(c => c.type === "drawIndexed") as Extract<Command, { type: "drawIndexed" }>;
    expect(cmd.indexCount).toBe(36);
    expect(cmd.instanceCount).toBe(1);
  });

  it("drawIndexed with all parameters", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.drawIndexed(36, 4, 0, 0, 0);
    const cmd = commands.find(c => c.type === "drawIndexed") as Extract<Command, { type: "drawIndexed" }>;
    expect(cmd.indexCount).toBe(36);
    expect(cmd.instanceCount).toBe(4);
  });

  it("drawIndirect does not throw", () => {
    const pass = createPass();
    expect(() => pass.drawIndirect(mockBuffer(), 0)).not.toThrow();
  });

  it("drawIndexedIndirect does not throw", () => {
    const pass = createPass();
    expect(() => pass.drawIndexedIndirect(mockBuffer(), 0)).not.toThrow();
  });

  it("end() records endRenderPass command", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.end();
    expect(commands.some(c => c.type === "endRenderPass")).toBe(true);
  });

  it("methods are no-ops after end()", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.end();
    const countBefore = commands.length;
    pass.draw(6);
    pass.setViewport(0, 0, 1, 1, 0, 1);
    expect(commands.length).toBe(countBefore);
  });

  it("end() is idempotent", () => {
    const commands: Command[] = [];
    const pass = createPass(commands);
    pass.end();
    const countAfterFirstEnd = commands.length;
    pass.end();
    expect(commands.length).toBe(countAfterFirstEnd);
  });

  it("getNative() returns commands array", () => {
    const pass = createPass();
    expect(Array.isArray(pass.getNative())).toBe(true);
  });
});

// ─── WebGL2ComputePassEncoder ──────────────────────────────────────────────

describe("WebGL2ComputePassEncoder", () => {
  it("all methods are no-ops without throwing", () => {
    const pass = new WebGL2ComputePassEncoder();
    expect(() => pass.setPipeline({})).not.toThrow();
    expect(() => pass.setBindGroup(0, {} as BackendBindGroup)).not.toThrow();
    expect(() => pass.dispatchWorkgroups(1)).not.toThrow();
    expect(() => pass.dispatchWorkgroupsIndirect(mockBuffer(), 0)).not.toThrow();
    expect(() => pass.end()).not.toThrow();
  });

  it("getNative() returns null", () => {
    const pass = new WebGL2ComputePassEncoder();
    expect(pass.getNative()).toBeNull();
  });
});

// ─── WebGL2CommandEncoder ──────────────────────────────────────────────────

describe("WebGL2CommandEncoder", () => {
  it("beginRenderPass returns a WebGL2RenderPassEncoder", () => {
    const encoder = new WebGL2CommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [] });
    expect(pass).toBeInstanceOf(WebGL2RenderPassEncoder);
  });

  it("beginComputePass returns a WebGL2ComputePassEncoder", () => {
    const encoder = new WebGL2CommandEncoder();
    const pass = encoder.beginComputePass();
    expect(pass).toBeInstanceOf(WebGL2ComputePassEncoder);
  });

  it("finish() returns a WebGL2CommandBuffer with recorded commands", () => {
    const encoder = new WebGL2CommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [] });
    pass.draw(6);
    pass.end();
    const cb = encoder.finish();
    expect(cb).toBeInstanceOf(WebGL2CommandBuffer);
    expect(cb.commands.length).toBeGreaterThan(0);
  });

  it("finish() clears the internal command list", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.beginRenderPass({ colorAttachments: [] }).end();
    encoder.finish();
    const cb2 = encoder.finish();
    expect(cb2.commands.length).toBe(0);
  });

  it("copyBufferToBuffer records command", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.copyBufferToBuffer(mockBuffer(), 0, mockBuffer(), 0, 256);
    const cb = encoder.finish();
    expect(cb.commands.some(c => c.type === "copyBufferToBuffer")).toBe(true);
  });

  it("copyBufferToTexture records command", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.copyBufferToTexture(
      { buffer: mockBuffer(), offset: 0, bytesPerRow: 256 },
      { texture: mockTexture(), mipLevel: 0, origin: [0, 0] },
      [64, 64],
    );
    const cb = encoder.finish();
    expect(cb.commands.some(c => c.type === "copyBufferToTexture")).toBe(true);
  });

  it("copyTextureToBuffer records command", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: mockTexture(), mipLevel: 0, origin: [0, 0] },
      { buffer: mockBuffer(), offset: 0, bytesPerRow: 256 },
      [64, 64],
    );
    const cb = encoder.finish();
    expect(cb.commands.some(c => c.type === "copyTextureToBuffer")).toBe(true);
  });

  it("copyTextureToTexture records command", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.copyTextureToTexture(
      { texture: mockTexture(), mipLevel: 0, origin: [0, 0] },
      { texture: mockTexture(), mipLevel: 0, origin: [0, 0] },
      [64, 64],
    );
    const cb = encoder.finish();
    expect(cb.commands.some(c => c.type === "copyTextureToTexture")).toBe(true);
  });

  it("handles scalar origin and copySize in copy operations", () => {
    const encoder = new WebGL2CommandEncoder();
    encoder.copyBufferToTexture(
      { buffer: mockBuffer(), offset: 0, bytesPerRow: 256 },
      { texture: mockTexture(), mipLevel: 0, origin: 0 },
      64,
    );
    const cb = encoder.finish();
    const cmd = cb.commands.find(c => c.type === "copyBufferToTexture") as Extract<Command, { type: "copyBufferToTexture" }>;
    expect(cmd.origin).toEqual([0, 0, 0]);
    expect(cmd.copySize).toEqual([64, 1, 1]);
  });

  it("getNative() returns the commands array", () => {
    const encoder = new WebGL2CommandEncoder();
    expect(Array.isArray(encoder.getNative())).toBe(true);
  });
});
