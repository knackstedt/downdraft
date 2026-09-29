// shared-device.spec.ts — cross-worker wgpu device sharing
//
// Proves the Phase 5 mechanism: a Bun worker attaches to the main thread's
// device via a raw handle + SAB state cell, creates resources, encodes a
// render pass, submits on the shared queue, and the owner reads the result
// back from the same texture — zero-copy across threads.
import { describe, expect, it } from "bun:test";
import { ptr } from "../ffi/ffi-adapter";
import {
    attachSharedDevice,
    createDeviceStateCells,
    markDeviceLost,
    shareDevice,
    sharedDeviceAlive,
} from "./shared-device";
import { WgpuDevice } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";
import { WgpuTexture } from "./wgpu-resources";

const MAP_READ = 0x0001, COPY_DST = 0x0008;

function makeDevice() {
  const instance = wgpu.wgpu_shim_create_instance() as unknown as number;
  const adapter = wgpu.wgpu_shim_request_adapter(instance, 0) as unknown as number;
  const devicePtr = wgpu.wgpu_shim_request_device(adapter, 0, 0, 0, 0) as unknown as number;
  if (!devicePtr) throw new Error("device creation failed");
  return { instance, device: new WgpuDevice(devicePtr, instance) };
}

describe("shared GPU device across workers", () => {
  it("attachSharedDevice rejects a dead handle", () => {
    const cells = createDeviceStateCells();
    markDeviceLost(cells);
    const handle = { devicePtr: 1, instancePtr: 1, queuePtr: 1, generation: 1 };
    expect(() => attachSharedDevice(handle, cells.sab)).toThrow(/stale|dead|empty|invalid/i);
  });

  it("worker renders into a texture on the shared device; owner reads it back", async () => {
    const { instance, device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    expect(handle.generation).toBeGreaterThan(0);

    const worker = new Worker(new URL("./spec-fixtures/shared-device-worker.ts", import.meta.url).href);
    const result = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("worker timeout")), 60_000);
      worker.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
      worker.onerror = (e) => { clearTimeout(t); reject(e); };
      worker.postMessage({ gpu: handle, cells: cells.sab, clear: [0.1, 0.9, 0.2, 1.0] });
    });
    worker.terminate();
    expect(result.ok).toBe(true);
    expect(result.texturePtr).toBeGreaterThan(0);

    // Owner-side readback of the worker-rendered texture.
    const tex = new WgpuTexture(result.texturePtr, { size: [64, 64, 1], format: "rgba8unorm", usage: 0x10 | 0x01 } as any);
    const readback = device.createBuffer({ size: 64 * 64 * 4, usage: MAP_READ | COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex as any },
      { buffer: readback as any, bytesPerRow: 64 * 4 },
      [64, 64, 1],
    );
    device.queue.submit([enc.finish()]);

    // map_async blocks in the shim's pump_until — self-contained.
    const state = wgpu.wgpu_shim_buffer_map_async(readback.ptr as unknown as ptr, 1, 0n, BigInt(64 * 64 * 4));
    expect(state).toBe(3);
    const out = new Uint8Array(64 * 64 * 4);
    wgpu.wgpu_shim_buffer_read_mapped(readback.ptr as unknown as ptr, 0n, BigInt(out.byteLength), ptr(out) as unknown as ptr, out.byteLength);
    wgpu.wgpu_shim_buffer_unmap(readback.ptr as unknown as ptr);

    // Every pixel should be the clear color (rgba ≈ 26, 230, 51, 255).
    const px = [out[0], out[1], out[2], out[3]];
    expect(Math.abs(px[0] - 26)).toBeLessThanOrEqual(2);
    expect(Math.abs(px[1] - 230)).toBeLessThanOrEqual(2);
    expect(Math.abs(px[2] - 51)).toBeLessThanOrEqual(2);
    expect(px[3]).toBe(255);
    // Spot-check a corner pixel too — the whole texture, not just texel 0.
    const last = (64 * 63 + 63) * 4;
    expect(Math.abs(out[last + 1] - 230)).toBeLessThanOrEqual(2);

    for (let i = 0; i < 5; i++) wgpu.wgpu_shim_process_events(instance);
    device.destroy();
  }, 60_000);

  it("state cell marks the device dead for attached workers", () => {
    const { device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    expect(sharedDeviceAlive(cells)).toBe(true);
    expect(sharedDeviceAlive(cells.sab)).toBe(true);
    markDeviceLost(cells);
    expect(sharedDeviceAlive(cells)).toBe(false);
    device.destroy();
  });

  it("owner destroy() marks the cell dead — workers don't touch a freed device", () => {
    const { device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    expect(sharedDeviceAlive(cells)).toBe(true);
    device.destroy();
    expect(sharedDeviceAlive(cells)).toBe(false);
    // A stale attach attempt after owner death rejects via liveness.
    expect(() => attachSharedDevice(handle, cells.sab)).toThrow(/stale|dead|empty|invalid/i);
  });
});
