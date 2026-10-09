// shared-device.spec.ts — cross-worker wgpu device sharing
//
// Proves the Phase 5 mechanism: a Bun worker attaches to the main thread's
// device via a raw handle + SAB state cell, creates resources, encodes a
// render pass, submits on the shared queue, and the owner reads the result
// back from the same texture — zero-copy across threads.
import { describe, expect, it } from "bun:test";
import { ptr } from "../ffi/ffi-adapter";
import {
    borrowGpuBuffer,
    borrowGpuTexture,
    importGpuTexture,
} from "./borrow";
import { GpuPassMailbox } from "./pass-channel";
import { GpuShareBroker } from "./share-broker";
import {
    attachSharedDevice,
    createDeviceStateCells,
    exportCommandBuffer,
    importCommandBuffer,
    markDeviceLost,
    retireSharedDevice,
    shareDevice,
    sharedDeviceAlive,
    sharedDeviceAttachedCount,
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

// These specs need libdowndraft_platform + a real adapter. Neither exists on
// a fresh checkout before the native-* optional dep lands on npm (or on
// GPU-less CI runners), so probe once and skip like the other native-gated
// specs (ffi-spike, osr-spike).
const GPU_OK = (() => {
  try {
    const { device } = makeDevice();
    device.destroy();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!GPU_OK)("shared GPU device across workers", () => {
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

    // Worker detached before posting — the attached count must be back to 0.
    expect(sharedDeviceAttachedCount(cells)).toBe(0);

    tex.destroy();
    readback.destroy();
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

  it("guarded view rejects FFI calls after owner destroy", () => {
    const { device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    // Same-thread attach — the guard path is identical for real workers.
    const view = attachSharedDevice(handle, cells.sab);
    expect(view.isValid()).toBe(true);
    expect(sharedDeviceAttachedCount(cells)).toBe(1);
    device.destroy();
    expect(view.isValid()).toBe(false);
    expect(() =>
      view.device.createTexture({ size: [8, 8, 1], format: "rgba8unorm", usage: 0x10 })
    ).toThrow(/no longer valid/);
    expect(() => view.queue.submit([])).toThrow(/no longer valid/);
    // device.queue must hand out the guarded queue, not the raw wrapper.
    expect(() => view.device.queue.submit([])).toThrow(/no longer valid/);
    view.detach();
    expect(sharedDeviceAttachedCount(cells)).toBe(0);
  });

  it("retireSharedDevice raises detachReq and waits for views to detach", async () => {
    const { device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    const view = attachSharedDevice(handle, cells.sab);
    const retired = retireSharedDevice(cells, 5_000);
    // The retire request is immediately visible to the view.
    expect(view.isValid()).toBe(false);
    view.detach();
    expect(await retired).toBe(true);
    device.destroy();
  });

  it("retireSharedDevice times out when a view never detaches", async () => {
    const { device } = makeDevice();
    const cells = createDeviceStateCells();
    const handle = shareDevice(device, cells);
    const view = attachSharedDevice(handle, cells.sab);
    expect(await retireSharedDevice(cells, 100)).toBe(false);
    view.detach();
    device.destroy();
  });

  it("exportCommandBuffer/importCommandBuffer transfer ownership to the submitter", () => {
    const { device } = makeDevice();
    const enc = device.createCommandEncoder();
    const cmd = enc.finish();
    // After export the source wrapper's dispose()/finalizer are inert —
    // the imported wrapper owns the handle and submit() releases it once.
    const ref = exportCommandBuffer(cmd);
    cmd.dispose(); // no-op post-transfer
    const imported = importCommandBuffer(ref);
    device.queue.submit([imported]);
    device.destroy();
  });
});

describe.skipIf(!GPU_OK)("GpuShareBroker", () => {
  it("issues one attach payload per device and tracks views globally", async () => {
    const { device } = makeDevice();
    const broker = new GpuShareBroker(device);
    const p1 = broker.payload();
    const p2 = broker.payload();
    // Same cells + same generation — every consumer attaches through the
    // broker so one death signal reaches all of them.
    expect(p1.cells).toBe(p2.cells);
    expect(p1.gpu.generation).toBe(p2.gpu.generation);
    expect(broker.isAlive()).toBe(true);

    const v1 = attachSharedDevice(p1.gpu, p1.cells);
    const v2 = attachSharedDevice(p2.gpu, p2.cells);
    expect(broker.attached()).toBe(2);

    const retired = broker.retire(5_000);
    expect(v1.isValid()).toBe(false);
    expect(v2.isValid()).toBe(false);
    v1.detach();
    v2.detach();
    expect(await retired).toBe(true);
    expect(broker.attached()).toBe(0);
    device.destroy();
  });

  it("one death signal reaches every consumer — device.destroy kills all views", () => {
    const { device } = makeDevice();
    const broker = new GpuShareBroker(device);
    const v1 = attachSharedDevice(broker.payload().gpu, broker.payload().cells);
    const v2 = attachSharedDevice(broker.payload().gpu, broker.payload().cells);
    expect(v1.isValid()).toBe(true);
    device.destroy();
    expect(broker.isAlive()).toBe(false);
    expect(v1.isValid()).toBe(false);
    expect(v2.isValid()).toBe(false);
  });
});

describe.skipIf(!GPU_OK)("borrow/import GPU resources", () => {
  it("borrowed wrappers never release the owner's handle", () => {
    const { device } = makeDevice();
    const tex = device.createTexture({
      size: [32, 32, 1], format: "rgba8unorm", usage: 0x02 | 0x04, // COPY_DST | TEXTURE_BINDING
    });
    const buf = device.createBuffer({ size: 256, usage: 0x0004 | 0x0008 }); // STORAGE|COPY_DST-ish metadata

    // Worker-side wraps — destroy() is a local no-op, and GC won't release
    // the native handle either (markTransferred unregistered the finalizer).
    const bTex = borrowGpuTexture(tex.ptr, { width: 32, height: 32, format: "rgba8unorm" });
    const bBuf = borrowGpuBuffer(buf.ptr, 256, device.queue);
    expect(bTex.width).toBe(32);
    expect(bBuf.size).toBe(256);
    bTex.destroy();
    bBuf.destroy();

    // Owner writes still land — the handle was never released.
    device.queue.writeTexture(
      { texture: tex as any },
      new Uint8Array(32 * 32 * 4),
      { bytesPerRow: 32 * 4, rowsPerImage: 32 },
      { width: 32, height: 32, depthOrArrayLayers: 1 },
    );
    tex.destroy();
    buf.destroy();
    device.destroy();
  });

  it("worker writeTexture through a borrowed target lands in the owner's texture", async () => {
    const { instance, device } = makeDevice();
    const broker = new GpuShareBroker(device);
    // Owner creates the upload target (RGBA8, COPY_SRC|COPY_DST|TEXTURE_BINDING
    // — the writeTexture destination plus the readback source).
    const tex = device.createTexture({
      size: [16, 16, 1], format: "rgba8unorm", usage: 0x01 | 0x02 | 0x04,
    });
    const payload = broker.payload();

    const worker = new Worker(new URL("./spec-fixtures/borrow-target-worker.ts", import.meta.url).href);
    const result = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("worker timeout")), 60_000);
      worker.onmessage = (ev) => { clearTimeout(t); resolve(ev.data); };
      worker.onerror = (e) => { clearTimeout(t); reject(e); };
      worker.postMessage({
        gpu: payload.gpu, cells: payload.cells,
        texPtr: tex.ptr, w: 16, h: 16,
      });
    });
    worker.terminate();
    expect(result.ok).toBe(true);

    // Read back — the worker's writeTexture should have filled it red.
    // copyTextureToBuffer enforces COPY_BYTES_PER_ROW_ALIGNMENT (256), so
    // the readback rows are padded even though the texture is 16 wide.
    const readback = device.createBuffer({ size: 16 * 256, usage: MAP_READ | COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex as any },
      { buffer: readback as any, bytesPerRow: 256 },
      [16, 16, 1],
    );
    device.queue.submit([enc.finish()]);
    const state = wgpu.wgpu_shim_buffer_map_async(readback.ptr as unknown as ptr, 1, 0n, BigInt(16 * 256));
    expect(state).toBe(3);
    const out = new Uint8Array(16 * 256);
    wgpu.wgpu_shim_buffer_read_mapped(readback.ptr as unknown as ptr, 0n, BigInt(out.byteLength), ptr(out) as unknown as ptr, out.byteLength);
    wgpu.wgpu_shim_buffer_unmap(readback.ptr as unknown as ptr);
    expect(out[0]).toBe(255);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(255);

    readback.destroy();
    tex.destroy();
    for (let i = 0; i < 5; i++) wgpu.wgpu_shim_process_events(instance);
    device.destroy();
  }, 60_000);

  it("importGpuTexture creates an owning wrapper (finalizer + destroy release)", () => {
    const { device } = makeDevice();
    const enc = device.createCommandEncoder();
    const cmd = enc.finish();
    // Simulate the worker-created + exported resource path at the same
    // level a real worker would produce — a texture whose ptr the owner
    // wraps owning. (Same-thread stand-in for the cross-thread flow.)
    const src = device.createTexture({
      size: [8, 8, 1], format: "rgba8unorm", usage: 0x10,
    });
    // Pretend the worker exported it — disarm the source wrapper's release.
    const { markTransferred } = require("./registry") as typeof import("./registry");
    markTransferred(src);
    const imported = importGpuTexture(src.ptr, { width: 8, height: 8, format: "rgba8unorm" });
    imported.destroy(); // releases the handle exactly once
    device.queue.submit([cmd]);
    device.destroy();
  });
});

describe.skipIf(!GPU_OK)("GpuPassMailbox", () => {
  it("drains posted worker command buffers into submit-ready wrappers", () => {
    const { device } = makeDevice();
    const mailbox = new GpuPassMailbox();
    const posted: { slot: string; ref: unknown }[] = [];
    // Worker-side emit: finish → postPass equivalent (export + post).
    const enc = device.createCommandEncoder();
    const ref = exportCommandBuffer(enc.finish());
    // Simulate the postMessage arriving — feed() is the manual path for
    // message streams owned by an RPC layer.
    expect(mailbox.feed({ type: "gpuPass", slot: "preSubmit", ref })).toBe(true);
    expect(mailbox.feed({ type: "frame" })).toBe(false);
    const cbs = mailbox.drain("preSubmit");
    expect(cbs.length).toBe(1);
    device.queue.submit(cbs);
    expect(mailbox.drain("preSubmit").length).toBe(0);
    device.destroy();
  });

  it("skips invalid worker buffers without submitting them", () => {
    const { device } = makeDevice();
    const mailbox = new GpuPassMailbox();
    // An invalid ref carries {ptr, invalid:true} — submit() releases it
    // without executing (submitting an errored buffer aborts the process).
    const enc = device.createCommandEncoder();
    const cb = enc.finish();
    cb.invalid = true;
    mailbox.feed({ type: "gpuPass", slot: "preUi", ref: exportCommandBuffer(cb) });
    const cbs = mailbox.drain("preUi");
    expect(cbs.length).toBe(1);
    // queue.submit() drops + releases invalid buffers — no crash.
    device.queue.submit(cbs);
    device.destroy();
  });
});
