// write-flags.spec.ts — __ddWritten marks at submit time, not encode time
//
// The surface context skips presenting an acquired-but-unwritten swapchain
// texture (frame retention for dirty-tracking games). If the flag were set
// while recording commands, a buffer that is dropped as invalid, abandoned
// by a callback exception, or simply never submitted would still present —
// a blank swapchain image (black frame).
import { describe, expect, it } from "bun:test";
import { WgpuDevice } from "./wgpu-device";
import { wgpu } from "./wgpu-ffi";
import type { WgpuTexture } from "./wgpu-resources";

const RENDER_ATTACHMENT = 0x0010;

function makeDevice() {
  const instance = wgpu.wgpu_shim_create_instance() as unknown as number;
  const adapter = wgpu.wgpu_shim_request_adapter(instance, 0) as unknown as number;
  if (!adapter) throw new Error("no adapter");
  const devicePtr = wgpu.wgpu_shim_request_device(adapter, 0, 0, 0, 0) as unknown as number;
  if (!devicePtr) throw new Error("device creation failed");
  return { instance, device: new WgpuDevice(devicePtr, instance) };
}


const GPU_OK = (() => {
  try {
    const { device } = makeDevice();
    device.destroy();
    return true;
  } catch {
    return false;
  }
})();

function makeTarget(device: WgpuDevice): WgpuTexture {
  return device.createTexture({
    size: [8, 8, 1],
    format: "rgba8unorm",
    usage: RENDER_ATTACHMENT,
  }) as unknown as WgpuTexture;
}

describe.skipIf(!GPU_OK)("__ddWritten defers to queue.submit", () => {
  it("a recorded render pass does not mark until its buffer is submitted", () => {
    const { device } = makeDevice();
    const tex = makeTarget(device);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView() as any,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 1, g: 0, b: 0, a: 1 },
      }],
    });
    pass.end();
    expect(tex.__ddWritten).toBe(false);

    const cb = enc.finish();
    expect(tex.__ddWritten).toBe(false);

    device.queue.submit([cb as any]);
    expect(tex.__ddWritten).toBe(true);

    tex.destroy();
    device.destroy();
  });

  it("an invalid buffer dropped by submit() never marks its targets", () => {
    const { device } = makeDevice();
    const tex = makeTarget(device);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView() as any,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 1, b: 0, a: 1 },
      }],
    });
    pass.end();
    const cb = enc.finish() as any;
    cb.invalid = true;
    device.queue.submit([cb]);
    expect(tex.__ddWritten).toBe(false);

    tex.destroy();
    device.destroy();
  });

  it("storeOp=discard attachments never mark even after submit", () => {
    const { device } = makeDevice();
    const tex = makeTarget(device);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView() as any,
        loadOp: "clear",
        storeOp: "discard",
        clearValue: { r: 0, g: 0, b: 1, a: 1 },
      }],
    });
    pass.end();
    device.queue.submit([enc.finish() as any]);
    expect(tex.__ddWritten).toBe(false);

    tex.destroy();
    device.destroy();
  });

  it("queue.writeTexture still marks immediately (the write is enqueued now)", () => {
    const { device } = makeDevice();
    const tex = device.createTexture({
      size: [8, 8, 1],
      format: "rgba8unorm",
      usage: 0x0002, // COPY_DST
    }) as unknown as WgpuTexture;

    device.queue.writeTexture(
      { texture: tex as any },
      new Uint8Array(8 * 8 * 4),
      { bytesPerRow: 8 * 4, rowsPerImage: 8 },
      { width: 8, height: 8, depthOrArrayLayers: 1 },
    );
    expect(tex.__ddWritten).toBe(true);

    tex.destroy();
    device.destroy();
  });
});
