import { describe, expect, it, vi } from "bun:test";

(globalThis as any).GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
(globalThis as any).GPUBufferUsage = {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
};

import { createDefaultLightUniform } from "../lighting";
import { TransparentPass } from "./transparent";

interface RecordedWrite { buffer: { size: number }; data: Float32Array }

function createMockDevice() {
  const writes: RecordedWrite[] = [];
  const buffers: { size: number }[] = [];
  const pipelines: unknown[] = [];
  const device = {
    writes,
    buffers,
    pipelines,
    createBuffer: (desc: { size: number }) => {
      const buf = { size: desc.size, destroy: vi.fn() };
      buffers.push(buf);
      return buf;
    },
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: (desc: unknown) => ({ desc }),
    createShaderModule: () => ({}),
    createRenderPipeline: (desc: unknown) => {
      const p = { desc, getBindGroupLayout: () => ({}) };
      pipelines.push(p);
      return p;
    },
    queue: {
      writeBuffer: (buffer: { size: number }, _offset: number, data: Float32Array) => {
        writes.push({ buffer, data });
      },
    },
  };
  return device as unknown as GPUDevice & {
    writes: RecordedWrite[];
    buffers: { size: number }[];
    pipelines: unknown[];
  };
}

function createMockPass() {
  const calls = {
    setPipeline: [] as unknown[],
    setBindGroup: [] as { index: number; offsets: number[] }[],
    drawIndexed: 0,
  };
  const pass = {
    calls,
    setPipeline: (p: unknown) => calls.setPipeline.push(p),
    setBindGroup: (index: number, _group: unknown, offsets?: number[]) =>
      calls.setBindGroup.push({ index, offsets: offsets ?? [] }),
    setVertexBuffer: () => {},
    setIndexBuffer: () => {},
    drawIndexed: () => { calls.drawIndexed++; },
  };
  return pass;
}

function makeCtx(pass: ReturnType<typeof createMockPass>, viewportIdx = 0) {
  return {
    pass,
    viewProj: new Float32Array(16),
    cameraPos: [0, 0, 5] as [number, number, number],
    lightData: createDefaultLightUniform(),
    viewportIdx,
    isFirstViewport: viewportIdx === 0,
  };
}

function makeMesh(stride: number): any {
  return {
    layout: { stride },
    vertices: new Float32Array(stride),
    indices: new Uint16Array(6),
    indexCount: 6,
  };
}

describe("TransparentPass", () => {
  it("batches item matrices into one writeBuffer with per-item dynamic offsets", () => {
    const device = createMockDevice();
    const pass = new TransparentPass(device, "rgba16float");
    pass.prepare(device);

    const m0 = makeMesh(48);
    const m1 = makeMesh(48);
    pass.addItem(m0, new Float32Array(16).fill(1) as any, 10);
    pass.addItem(m1, new Float32Array(16).fill(2) as any, 5);

    const mockPass = createMockPass();
    pass.execute(makeCtx(mockPass) as any);

    // The model buffer is the 64-slot × 256B uniform buffer.
    const modelBuffer = device.buffers.find((b) => b.size === 64 * 256)!;
    const modelWrites = device.writes.filter((w) => w.buffer === modelBuffer);
    expect(modelWrites.length).toBe(1);
    // First item's matrix lands at float 0, second at float 64 (256B slot).
    expect(modelWrites[0].data[0]).toBe(1);
    expect(modelWrites[0].data[64]).toBe(2);

    // One bind group, rebound per item with its dynamic offset.
    const group0 = mockPass.calls.setBindGroup.filter((c) => c.index === 0);
    expect(group0.length).toBe(2);
    expect(group0[0].offsets).toEqual([0]);
    expect(group0[1].offsets).toEqual([256]);
    expect(mockPass.calls.drawIndexed).toBe(2);
  });

  it("selects pipelines per-stride and dedupes consecutive setPipeline calls", () => {
    const device = createMockDevice();
    const pass = new TransparentPass(device, "rgba16float");
    pass.prepare(device);

    const mA = makeMesh(48);
    const mB = makeMesh(64);
    pass.addItem(mA, new Float32Array(16) as any, 10);
    pass.addItem(mB, new Float32Array(16) as any, 5);
    pass.addItem(mA, new Float32Array(16) as any, 1);

    const mockPass = createMockPass();
    pass.execute(makeCtx(mockPass) as any);

    expect(device.pipelines.length).toBe(2);
    // Sorted back-to-front by distance: mA(10), mB(5), mA(1) → pipelines
    // switch A, B, A — no dedup possible across distinct strides, but the
    // same-stride repeats collapse.
    expect(mockPass.calls.setPipeline.length).toBe(3);
  });

  it("writes light buffers only on the first viewport", () => {
    const device = createMockDevice();
    const pass = new TransparentPass(device, "rgba16float");
    pass.prepare(device);

    pass.addItem(makeMesh(48), new Float32Array(16) as any, 1);

    const mockPass = createMockPass();
    pass.execute(makeCtx(mockPass, 1) as any);

    // Second viewport: camera write + batched model write only — no light
    // buffer writes (light=128B, point=32*32B, spot=8*64B).
    const lightWrites = device.writes.filter((w) =>
      w.buffer.size === 128 || w.buffer.size === 32 * 32 || w.buffer.size === 8 * 64,
    );
    expect(lightWrites.length).toBe(0);
  });

  it("grows the model buffer when a frame exceeds capacity", () => {
    const device = createMockDevice();
    const pass = new TransparentPass(device, "rgba16float");
    pass.prepare(device);

    for (let i = 0; i < 70; i++) {
      pass.addItem(makeMesh(48), new Float32Array(16) as any, i);
    }
    const mockPass = createMockPass();
    pass.execute(makeCtx(mockPass) as any);

    // Buffer grew beyond the initial 64-slot capacity.
    expect(device.buffers.some((b) => b.size > 64 * 256)).toBe(true);
    expect(mockPass.calls.drawIndexed).toBe(70);
    expect(mockPass.calls.setBindGroup[69].offsets).toEqual([69 * 256]);
  });
});
