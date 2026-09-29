// Spec fixture — attach to a shared wgpu device handle and render a solid
// clear-color pass into a worker-created texture, entirely on this thread.
import type { GpuDeviceHandle } from "../shared-device";
import { attachSharedDevice } from "../shared-device";

declare const self: Worker;

// Wrappers handed to the owner by raw ptr must stay reachable — if GC
// collects them, the FinalizationRegistry releases the native handles
// while the owner still reads them.
const keepAlive: unknown[] = [];

self.onmessage = (ev: MessageEvent) => {
  const { gpu, cells, clear } = ev.data as {
    gpu: GpuDeviceHandle;
    cells: SharedArrayBuffer;
    clear: [number, number, number, number];
  };
  try {
    const { device, queue, isValid } = attachSharedDevice(gpu, cells);
    if (!isValid()) throw new Error("device invalid at attach");

    // RENDER_ATTACHMENT | COPY_SRC (GPUTextureUsage 0x10 | 0x01)
    const tex = device.createTexture({
      size: [64, 64, 1],
      format: "rgba8unorm",
      usage: 0x10 | 0x01,
    });
    const view = tex.createView();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: view as any,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
      }],
    });
    pass.end();
    const cmd = enc.finish();
    queue.submit([cmd]);
    keepAlive.push(tex, view);

    // Hand the texture back — the owner reads it to verify the render.
    self.postMessage({ ok: true, texturePtr: (tex as any).ptr });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e) });
  }
};
