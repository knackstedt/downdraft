// Frame-pacing smoke test — verifies:
//   1. the native rAF pump dispatches at ~display refresh (not free-running
//      at event-loop speed, and not under-shooting via coarse wait rounding);
//   2. an acquired-but-unwritten surface texture is retained across frames
//      (present() skips it so the swapchain keeps showing the last real
//      frame — dropping it would starve the swapchain: wgpuTextureRelease
//      does not return the image, only present does);
//   3. a real acquire→draw→present loop tracks refresh.
//
// Run: bun run test/frame-pacing-smoke.ts   (needs a display)
import { createNativeHost } from "../src/native-host";

const host = await createNativeHost({
  window: { title: "frame-pacing-smoke", width: 320, height: 200 },
  appId: "dd-frame-pacing-smoke",
});
const { surface, device, window } = host as any;
const ctx = surface.getContext("webgpu")!;

const refresh = window.getDisplayInfo().refreshRate || 60;
console.log(`[info] display refresh: ${refresh}Hz`);

const fail = (msg: string): never => { console.error(`[FAIL] ${msg}`); process.exit(1); };

// ── Phase 1: no-op rAF loop — measures pure dispatch rate ──
let noOpFrames = 0;
const t0 = performance.now();
await new Promise<void>((resolve) => {
  const tick = () => {
    noOpFrames++;
    if (performance.now() - t0 >= 2000) resolve();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const noOpRate = noOpFrames / 2;
console.log(`[phase1] no-op rAF rate: ${noOpRate}/s`);
if (noOpRate > refresh * 1.15) fail(`rAF dispatch free-ran at ${noOpRate}/s (refresh ${refresh})`);
if (noOpRate < refresh * 0.8) fail(`rAF dispatch under-paced at ${noOpRate}/s (refresh ${refresh})`);

// ── Phase 2: acquire-but-never-write → texture retained across frames ──
// present() must skip it (a blank present would flash), but it must NOT be
// destroyed (wgpuTextureRelease does not return the swapchain image → the
// next acquire starves for ~1s). The same texture object must come back.
let texA: any = null;
await new Promise<void>((r) => { requestAnimationFrame(() => { texA = ctx.getCurrentTexture(); r(); }); });
if (!texA) fail("acquire returned null");
// Let the end-of-frame auto-present microtask run — present() must skip it.
await new Promise((r) => setTimeout(r, 20));
let texB: any = null;
await new Promise<void>((r) => { requestAnimationFrame(() => { texB = ctx.getCurrentTexture(); r(); }); });
if (texB !== texA) fail("unwritten texture was not retained across frames");
console.log("[phase2] unwritten texture retained — next getCurrentTexture returns the same image");

// ── Phase 3: write + present — real frame cadence tracks refresh ──
let realPresents = 0;
const origPresent = ctx.present.bind(ctx);
(ctx as any).present = () => {
  const had = !!(ctx as any).currentTexture;
  origPresent();
  if (had && !(ctx as any).currentTexture) realPresents++; // texture consumed → presented
};

let draws = 0;
let maxAcquire = 0;
setTimeout(() => fail(`phase 3 watchdog — draws=${draws} presents=${realPresents}`), 8000).unref();
const t3 = performance.now();
const draw = () => {
  try {
    const ta = performance.now();
    const tex = ctx.getCurrentTexture();
    const acq = performance.now() - ta;
    if (acq > maxAcquire) maxAcquire = acq;
    if (!tex) { requestAnimationFrame(draw); return; }
    const view = tex.createView({ dimension: "2d", format: ctx.getFormat() ?? undefined });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0, g: 0.4, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
    });
    pass.end();
    device.queue.submit([enc.finish()]);
    draws++;
    if (performance.now() - t3 < 1000) requestAnimationFrame(draw);
    else finish();
  } catch (e) {
    console.error("[FAIL] draw threw:", e);
    process.exit(1);
  }
};
const finish = () => {
  console.log(`[phase3] draws=${draws} presents=${realPresents} maxAcquire=${maxAcquire.toFixed(1)}ms`);
  if (draws < refresh * 0.8) fail(`draw loop under-paced at ${draws}/s (refresh ${refresh})`);
  if (draws > refresh * 1.15) fail(`draw loop free-ran at ${draws}/s (refresh ${refresh})`);
  if (realPresents < 3) fail("present path broken");
  host.destroy();
  console.log("PACING SMOKE PASS");
  process.exit(0);
};
requestAnimationFrame(draw);
