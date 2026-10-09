import { beforeAll, describe, expect, it } from "bun:test";
import type { KernelThis } from "./kernel";
import { createKernel, GpuKernel } from "./kernel";

// End-to-end GPU tests via the native wgpu shim. Soft-skip when the native
// library or a GPU adapter isn't available (plain `bun test` on a GPU-less
// box, CI without a device, etc.).

let device: GPUDevice | null = null;

beforeAll(async () => {
  try {
    const pn = await import("@downdraft/platform-native");
    const install = (pn as any).installGPU ?? (pn as any).default?.installGPU;
    if (!install) return;
    install();
    const adapter = await navigator.gpu!.requestAdapter();
    if (adapter) device = (await adapter.requestDevice()) as GPUDevice;
  } catch (e) {
    console.log(`gpu-kernels GPU tests skipped: ${(e as Error).message}`);
  }
});

const skip = () => !device && console.log("  (skipped: no GPU adapter)");

describe("GpuKernel on the shared device", () => {
  it("doubles an array elementwise and reads back", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [64],
      fn: function (this: KernelThis, a: Float32Array) {
        return a[this.thread.x] * 2.0;
      },
    });
    const out = await k.read(new Float32Array(64).map((_, i) => i));
    expect(out[0]).toBe(0);
    expect(out[33]).toBe(66);
    expect(out[63]).toBe(126);
    k.destroy();
  });

  it("matches cpu() output on a matmul-style kernel", async () => {
    if (!device) return skip();
    const N = 8;
    const a = new Float32Array(N * N).map((_, i) => (i % 7) * 0.25);
    const b = new Float32Array(N * N).map((_, i) => (i % 5) * 0.5);
    const fn = function (this: KernelThis, a: Float32Array, b: Float32Array) {
      let sum = 0.0;
      for (let i = 0; i < this.output.x; i++) {
        sum += a[this.thread.y * this.output.x + i] * b[i * this.output.y + this.thread.x];
      }
      return sum;
    };
    const k = createKernel({ device, output: [N, N], fn });
    const gpu = await k.read(a, b);
    const cpu = k.cpu(a, b);
    for (let i = 0; i < N * N; i++) {
      expect(gpu[i]).toBeCloseTo(cpu[i], 5);
    }
    k.destroy();
  });

  it("readInto lands results in a SharedArrayBuffer view", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [16],
      fn: function (this: KernelThis) {
        return this.thread.x + 1;
      },
    });
    const view = new Float32Array(new SharedArrayBuffer(16 * 4));
    await k.readInto(view);
    expect(view[15]).toBe(16);
    k.destroy();
  });

  it("writes directly into a caller GPUBuffer (zero-copy output)", async () => {
    if (!device) return skip();
    const target = device.createBuffer({
      size: 8 * 4,
      usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */,
    });
    const k = createKernel({
      device,
      output: [8],
      fn: function (this: KernelThis) {
        return this.thread.x * 3;
      },
    });
    k.dispatchInto(target);
    // read `target` back manually
    const stage = device.createBuffer({ size: 8 * 4, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(target, 0, stage, 0, 8 * 4);
    device.queue.submit([enc.finish()]);
    await stage.mapAsync(1);
    const out = new Float32Array(stage.getMappedRange().slice(0));
    stage.unmap();
    expect(out[7]).toBe(21);
    target.destroy();
    stage.destroy();
    k.destroy();
  });

  it("accepts a GPUBuffer arg bound directly (kernel → kernel chaining)", async () => {
    if (!device) return skip();
    const first = createKernel({
      device,
      output: [8],
      fn: function (this: KernelThis) {
        return this.thread.x;
      },
    });
    await first.read(); // populate first.resultBuffer
    const second = createKernel({
      device,
      output: [8],
      fn: function (this: KernelThis, src: Float32Array) {
        return src[this.thread.x] + 100.0;
      },
    });
    const out = await second.read(first.resultBuffer);
    expect(out[5]).toBe(105);
    first.destroy();
    second.destroy();
  });

  it("honors read_write input access for in-place kernels", async () => {
    if (!device) return skip();
    const k: GpuKernel = createKernel({
      device,
      output: [4],
      access: ["read_write"],
      fn: function (this: KernelThis, a: Float32Array) {
        a[this.thread.x] = a[this.thread.x] + 1.0;
        return a[this.thread.x];
      },
    });
    const data = new Float32Array([1, 2, 3, 4]);
    const out = await k.read(data);
    expect(Array.from(out)).toEqual([2, 3, 4, 5]);
    k.destroy();
  });

  // ── Review-hardened paths ──────────────────────────────────────────────

  it("terminates countdown loops over arg.length (i32 unify)", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [1],
      fn: `function (a) {
        let s = 0;
        for (let i = a.length - 1; i >= 0; i--) { s += a[i]; }
        return s;
      }`,
    });
    const out = await k.read(new Float32Array([1, 2, 3, 4]));
    expect(out[0]).toBe(10);
  });

  it("exits do..while loops that only advance via continue", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [8],
      fn: `function () {
        let i = this.thread.x;
        do {
          if (i >= 10) { continue; }
          i += 1;
        } while (i < 10);
        return i;
      }`,
    });
    const out = await k.read();
    expect(Array.from(out)).toEqual([10, 10, 10, 10, 10, 10, 10, 10]);
  });

  it("matches cpu() on float division, logical values, and bool returns", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [16],
      fn: `function (a) {
        const h = this.thread.x / 2;
        const v = a[this.thread.x] || 7.0;
        const b = a[this.thread.x] > 0.5;
        return h + v + b;
      }`,
    });
    const a = new Float32Array(16).map((_, i) => (i % 3 === 0 ? 0 : i * 0.4));
    const gpu = await k.read(a);
    const cpu = k.cpu(a);
    for (let i = 0; i < 16; i++) expect(gpu[i]).toBeCloseTo(cpu[i], 4);
  });

  it("handles variable shifts and **= on vars", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [8],
      fn: `function () {
        let i = this.thread.x % 4;
        let v = 1;
        v <<= i;
        v **= 2;
        return v;
      }`,
    });
    const out = await k.read();
    expect(Array.from(out)).toEqual([1, 4, 16, 64, 1, 4, 16, 64]);
  });

  it("serializes concurrent read() calls on the staging buffer", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [64],
      fn: function (this: KernelThis, a: Float32Array) { return a[this.thread.x] * 2.0; },
    });
    const a = new Float32Array(64).map((_, i) => i);
    const b = new Float32Array(64).map((_, i) => i + 100);
    const [r1, r2] = await Promise.all([k.read(a), k.read(b)]);
    expect(r1[10]).toBe(20);
    expect(r2[10]).toBe(220);
  });

  it("readResult() fetches the last dispatch without re-running", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [4],
      access: ["read_write"],
      fn: `function (a) { a[this.thread.x] += 1.0; return a[this.thread.x]; }`,
    });
    const data = new Float32Array([0, 0, 0, 0]);
    k.dispatch(data);
    const r1 = await k.readResult();
    const r2 = await k.readResult();
    // both reads see the single dispatch's output — no re-run
    expect(Array.from(r1)).toEqual([1, 1, 1, 1]);
    expect(Array.from(r2)).toEqual([1, 1, 1, 1]);
  });

  it("converts non-f32 TypedArrays by value, not by bits", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [4],
      fn: function (this: KernelThis, a: Float32Array) { return a[this.thread.x]; },
    });
    const out = await k.read(new Uint32Array([10, 20, 30, 40]) as unknown as Float32Array);
    expect(Array.from(out)).toEqual([10, 20, 30, 40]);
  });

  it("arg.length reflects the current call's array, not buffer capacity", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [1],
      fn: `function (a) { return a.length; }`,
    });
    await k.read(new Float32Array(128));
    const out = await k.read(new Float32Array(64));
    expect(out[0]).toBe(64); // not 128 — the grown buffer's capacity
  });

  it("rejects undersized dispatchInto targets and post-destroy access", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [16],
      fn: function (this: KernelThis) { return this.thread.x; },
    });
    const tiny = device.createBuffer({ size: 8, usage: 0x80 });
    expect(() => k.dispatchInto(tiny)).toThrow(/needs|size/i);
    tiny.destroy();
    k.destroy();
    expect(() => k.dispatch()).toThrow(/destroyed/);
    expect(() => k.resultBuffer).toThrow(/destroyed/);
  });

  it("evaluates vec-typed ternaries into strided output", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [4],
      outputStride: 2,
      fn: `function (a) { return a[this.thread.x] > 0.5 ? [1.0, 2.0] : [3.0, 4.0]; }`,
    });
    const out = await k.read(new Float32Array([0.1, 0.9, 0.4, 0.8]));
    expect(Array.from(out)).toEqual([3, 4, 1, 2, 3, 4, 1, 2]);
    k.destroy();
  });

  it("clears lastError after a clean dispatch", async () => {
    if (!device) return skip();
    const k = createKernel({
      device,
      output: [4],
      fn: `function (a) { return a[this.thread.x]; }`,
    });
    // A synchronous rejection doesn't touch lastError — force a submit-time
    // failure instead by dispatching an undersized caller buffer.
    const tiny = device.createBuffer({ size: 8, usage: 0x80 });
    expect(() => k.dispatchInto(tiny, new Float32Array(4))).toThrow();
    tiny.destroy();
    k.lastError = "stale";
    k.dispatch(new Float32Array([1, 2, 3, 4]));
    await k.readResult();
    // give the error-scope promise a turn, then a successful submit must clear it
    await k.read(new Float32Array([1, 2, 3, 4]));
    expect(k.lastError).toBeNull();
    k.destroy();
  });

  it("rejects workgroup sizes beyond device limits at construction", () => {
    if (!device) { skip(); return; }
    const lim = (device.limits as { maxComputeInvocationsPerWorkgroup?: number })
      .maxComputeInvocationsPerWorkgroup;
    if (!lim) return;
    expect(() =>
      createKernel({
        device: device!,
        output: [4],
        workgroupSize: [lim + 1, 1, 1],
        fn: `function () { return 0; }`,
      }),
    ).toThrow(/limits/);
  });

  it("reports storage-buffer count and binding-size limits with clear errors", async () => {
    if (!device) { skip(); return; }
    // Cap the live device's reported limits at Adreno-class values — the
    // checks must fire before submit, not surface as a validation failure.
    const dev = device as unknown as { _limits: Record<string, number> };
    const real = dev._limits;
    try {
      dev._limits = { ...(device.limits as unknown as Record<string, number>), maxStorageBuffersPerShaderStage: 4 };
      const k = createKernel({
        device,
        output: [4],
        fn: `function (a, b, c, d, e, f) { return a[this.thread.x]; }`,
      });
      const args = Array.from({ length: 6 }, () => new Float32Array(4));
      await expect(k.read(...(args as never[]))).rejects.toThrow(/storage buffers/);
      k.destroy();

      dev._limits = { ...(device.limits as unknown as Record<string, number>), maxStorageBufferBindingSize: 64 };
      const k2 = createKernel({ device, output: [4], fn: `function (a) { return a[0]; }` });
      await expect(k2.read(new Float32Array(256))).rejects.toThrow(/maxStorageBufferBindingSize/);
      k2.destroy();
    } finally {
      dev._limits = real;
    }
  });

  it("readResult before any dispatch returns zeroed output", async () => {
    if (!device) return skip();
    const k = createKernel({ device, output: [8], fn: `function () { return 9.0; }` });
    const out = await k.readResult();
    expect(out[0]).toBe(0);
    expect(out[7]).toBe(0);
    k.destroy();
  });

  it("enforces memoryBudget on kernel-owned buffers", async () => {
    if (!device) return skip();
    // result(64*4=256B) + staging(256B) + upload(1KB) — budget 1KB is enough.
    const k = createKernel({
      device, output: [64], memoryBudget: 2048,
      fn: `function (a) { return a[this.thread.x] * 2.0; }`,
    });
    const out = await k.read(new Float32Array(64).fill(1));
    expect(out[5]).toBe(2);
    expect(k.allocatedBytes).toBeGreaterThan(0);
    expect(k.allocatedBytes).toBeLessThanOrEqual(2048);
    // Growing the arg past the budget throws instead of allocating.
    await expect(k.read(new Float32Array(4096))).rejects.toThrow(/memoryBudget/);
    k.destroy();
    expect(k.allocatedBytes).toBe(0);
  });
});
