// Spec fixture — attach to a shared wgpu device handle and render a solid
// clear-color pass into a worker-created texture, entirely on this thread.
import type { GpuDeviceHandle } from "../shared-device";
import { attachSharedDevice, exportGpuResource } from "../shared-device";

declare const self: Worker;

self.onmessage = (ev: MessageEvent) => {
  const { gpu, cells, clear } = ev.data as {
    gpu: GpuDeviceHandle;
    cells: SharedArrayBuffer;
    clear: [number, number, number, number];
  };
  let view: ReturnType<typeof attachSharedDevice> | null = null;
  try {
    view = attachSharedDevice(gpu, cells);
    const { device, queue, isValid } = view;
    if (!isValid()) throw new Error("device invalid at attach");

    // RENDER_ATTACHMENT | COPY_SRC (GPUTextureUsage 0x10 | 0x01)
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "rgba8unorm",
      usage: 0x10 | 0x01,
    });
    const texView = tex.createView();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: texView as any,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
      }],
    });
    pass.end();
    const cmd = enc.finish();
    queue.submit([cmd]);

    // Transfer the texture to the owner — clears this thread's finalizer
    // claim so the owner is the sole owner of the native handle.
    const texturePtr = exportGpuResource(tex);

    // Release this thread's queue clone + decrement the attached count
    // BEFORE posting — the owner asserts the retire handshake sees zero
    // live views once the message lands.
    view.detach();
    view = null;
    self.postMessage({ ok: true, texturePtr });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e) });
  } finally {
    view?.detach(); // idempotent — covers the error path
  }
};
