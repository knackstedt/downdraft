import { describe, expect, it, vi } from "bun:test";
import type { BackendBuffer, BackendCommandBuffer, BackendTexture } from "../types.ts";
import { WebGPUQueue } from "./webgpu-queue.ts";

function makeMockGPUQueue(): GPUQueue {
  return {
    submit: vi.fn(),
    writeBuffer: vi.fn(),
    writeTexture: vi.fn(),
    copyExternalImageToTexture: vi.fn(),
    onSubmittedWorkDone: vi.fn().mockResolvedValue(undefined),
  } as unknown as GPUQueue;
}

function makeMockBackendBuffer(): BackendBuffer {
  return { gpuBuffer: {} } as unknown as BackendBuffer;
}

function makeMockBackendTexture(): BackendTexture {
  return { gpuTexture: {} } as unknown as BackendTexture;
}

function makeMockCommandBuffer(): BackendCommandBuffer {
  return { gpuCommandBuffer: {} } as unknown as BackendCommandBuffer;
}

describe("WebGPUQueue", () => {
  it("getNative returns the underlying GPUQueue", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    expect(q.getNative()).toBe(mock);
  });

  it("gpuQueue getter returns the underlying queue", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    expect(q.gpuQueue).toBe(mock);
  });

  it("submit maps command buffers to gpuCommandBuffer and calls underlying submit", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const cb1 = makeMockCommandBuffer();
    const cb2 = makeMockCommandBuffer();
    q.submit([cb1, cb2]);
    expect(mock.submit).toHaveBeenCalledWith([{}, {}]);
  });

  it("submit with empty array calls underlying submit with empty array", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    q.submit([]);
    expect(mock.submit).toHaveBeenCalledWith([]);
  });

  it("writeBuffer calls underlying writeBuffer with gpuBuffer", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const buf = makeMockBackendBuffer();
    const data = new ArrayBuffer(64);
    q.writeBuffer(buf, 0, data);
    expect(mock.writeBuffer).toHaveBeenCalledWith({}, 0, data);
  });

  it("writeBuffer passes offset correctly", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const buf = makeMockBackendBuffer();
    const data = new Float32Array([1, 2, 3]);
    q.writeBuffer(buf, 128, data);
    expect(mock.writeBuffer).toHaveBeenCalledWith({}, 128, data);
  });

  it("writeTexture calls underlying writeTexture with gpuTexture", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const tex = makeMockBackendTexture();
    const data = new ArrayBuffer(256);
    q.writeTexture(
      { texture: tex, mipLevel: 0, origin: [0, 0, 0] },
      data,
      { offset: 0, bytesPerRow: 256, rowsPerImage: 256 },
      [16, 16, 1],
    );
    expect(mock.writeTexture).toHaveBeenCalledTimes(1);
    const call = (mock.writeTexture as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].texture).toEqual({});
    expect(call[0].mipLevel).toBe(0);
    expect(call[1]).toBe(data);
    expect(call[2].bytesPerRow).toBe(256);
  });

  it("writeTexture passes 2D origin correctly", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const tex = makeMockBackendTexture();
    q.writeTexture(
      { texture: tex, mipLevel: 1, origin: [4, 4] },
      new ArrayBuffer(64),
      { offset: 0, bytesPerRow: 64 },
      [8, 8],
    );
    expect(mock.writeTexture).toHaveBeenCalledTimes(1);
  });

  it("copyExternalImageToTexture calls underlying method", () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const tex = makeMockBackendTexture();
    const imageSource = {} as CanvasImageSource;
    q.copyExternalImageToTexture(
      { source: imageSource, flipY: true },
      { texture: tex, mipLevel: 0, origin: [0, 0, 0] },
      [32, 32, 1],
    );
    expect(mock.copyExternalImageToTexture).toHaveBeenCalledTimes(1);
  });

  it("onSubmittedWorkDone calls underlying method and returns promise", async () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    await q.onSubmittedWorkDone();
    expect(mock.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
  });

  it("onSubmittedWorkDone resolves to undefined", async () => {
    const mock = makeMockGPUQueue();
    const q = new WebGPUQueue(mock);
    const result = await q.onSubmittedWorkDone();
    expect(result).toBeUndefined();
  });
});
