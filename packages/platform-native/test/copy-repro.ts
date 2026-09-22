// Minimal repro: render a clear pass to the surface, copy it inside
// a pre-present hook, present. Isolates the surface-texture copy.
import { createNativeHost } from "../src/native-host";
import { captureScreenshotPixels } from "../src/screenshot/screenshot";

const host = await createNativeHost({
  window: { title: "copy-repro", width: 320, height: 200 },
});
const { surface, device } = host;
const ctx = surface.getContext("webgpu")!;

let frames = 0;
const frame = () => {
  const tex = ctx.getCurrentTexture();
  if (!tex) { console.log("no tex"); return; }
  const view = tex.createView({ dimension: "2d", format: ctx.getFormat() ?? undefined });

  // Clear to red
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view,
      clearValue: { r: 1, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.end();
  device.queue.submit([enc.finish()]);

  if (frames === 2) {
    // Frame 3: copy inside pre-present hook
    (ctx as any).onBeforePresent(() => {
      console.log("[repro] copying surface texture pre-present");
      const t = ctx.getCurrentTexture();
      try {
        if (!t) { console.log("[repro] no texture"); return; }
        const px = captureScreenshotPixels(device, t, 320, 200, ctx.getFormat() ?? undefined);
        console.log("[repro] readback ok, first px:", px?.slice(0, 4));
      } catch (e) {
        console.log("[repro] readback threw:", e);
      }
    });
  }

  ctx.present();
  frames++;
  if (frames < 6) requestAnimationFrame(frame);
  else { console.log("[repro] DONE"); host.destroy(); process.exit(0); }
};
requestAnimationFrame(frame);
