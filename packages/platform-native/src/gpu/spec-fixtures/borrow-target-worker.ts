// Spec fixture — attach to the shared device, borrow an OWNER-created
// texture by ptr, and queue.writeTexture into it from this worker thread.
// The owner keeps lifetime; our wrapper is non-owning (borrowGpuTexture).
import { borrowGpuTexture } from "../borrow";
import type { GpuDeviceHandle } from "../shared-device";
import { attachSharedDevice } from "../shared-device";

declare const self: Worker;

self.onmessage = (ev: MessageEvent) => {
  const { gpu, cells, texPtr, w, h } = ev.data as {
    gpu: GpuDeviceHandle;
    cells: SharedArrayBuffer;
    texPtr: number;
    w: number;
    h: number;
  };
  let view: ReturnType<typeof attachSharedDevice> | null = null;
  try {
    view = attachSharedDevice(gpu, cells);
    const { queue, isValid } = view;
    if (!isValid()) throw new Error("device invalid at attach");

    // Non-owning wrap of the owner's texture — our destroy() frees nothing.
    const tex = borrowGpuTexture(texPtr, {
      width: w, height: h, format: "rgba8unorm",
    });

    // Solid red fill — one writeTexture = one atomic queue op.
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      px[i * 4] = 255;
      px[i * 4 + 3] = 255;
    }
    queue.writeTexture(
      { texture: tex as unknown as GPUTexture },
      px,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );

    view.detach();
    view = null;
    self.postMessage({ ok: true });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e) });
  } finally {
    view?.detach();
  }
};
