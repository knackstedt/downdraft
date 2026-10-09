import { describe, expect, it } from "bun:test";
import type { KernelThis } from "./kernel";
import { createKernel } from "./kernel";

// CPU-path tests — no GPUDevice needed: dispatch/read are exercised only via
// cpu()/cpuInto(), which run the kernel function per-element in plain JS.

const fakeDevice = null as unknown as GPUDevice;

describe("GpuKernel cpu() fallback", () => {
  it("runs an elementwise kernel deterministically", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [4],
      fn: function (this: KernelThis, a: Float32Array, scale: number) {
        return a[this.thread.x] * scale;
      },
    });
    const out = k.cpu(new Float32Array([1, 2, 3, 4]), 2.5);
    expect(Array.from(out)).toEqual([2.5, 5, 7.5, 10]);
  });

  it("maps 2D thread ids to row-major output", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [3, 2],
      fn: function (this: KernelThis) {
        return this.thread.y * this.output.x + this.thread.x;
      },
    });
    expect(Array.from(k.cpu())).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("supports loop + arg.length reductions", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [1],
      fn: function (this: KernelThis, a: Float32Array) {
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
          sum += a[i];
        }
        return sum;
      },
    });
    expect(k.cpu(new Float32Array([1, 2, 3, 4]))[0]).toBe(10);
  });

  it("handles strided (vector) returns", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [3],
      outputStride: 2,
      fn: function (this: KernelThis, a: Float32Array) {
        const v = a[this.thread.x];
        return [v, -v];
      },
    });
    const out = k.cpu(new Float32Array([1, 2, 3]));
    expect(Array.from(out)).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("cpuInto writes into a caller view — including SAB-backed views", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [4],
      fn: function (this: KernelThis) {
        return this.thread.x * 10;
      },
    });
    const sab = new SharedArrayBuffer(4 * 4);
    const view = new Float32Array(sab);
    k.cpuInto(view);
    expect(Array.from(view)).toEqual([0, 10, 20, 30]);
  });

  it("exposes this.constants on the CPU path", () => {
    const k = createKernel({
      device: fakeDevice,
      output: [2],
      constants: { BOOST: 100 },
      fn: function (this: KernelThis) {
        return this.constants.BOOST + this.thread.x;
      },
    });
    expect(Array.from(k.cpu())).toEqual([100, 101]);
  });

  it("rejects unknown access strings and out-of-range outputStride", () => {
    const base = { device: fakeDevice, output: [4] as [number], fn: `function (a) { return a[0]; }` };
    expect(() =>
      createKernel({ ...base, access: ["WRITE" as never] }),
    ).toThrow(/access/);
    expect(() =>
      createKernel({ ...base, outputStride: 5 as never }),
    ).toThrow(/outputStride/);
    expect(() =>
      createKernel({ ...base, outputStride: 0 as never }),
    ).toThrow(/outputStride/);
  });
});
