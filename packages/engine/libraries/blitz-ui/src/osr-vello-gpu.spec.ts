// GPU-raster verification — boots the real wgpu stack headlessly, encodes
// a document into a vello scene inside the OSR cdylib (dd_osr_frame_vello),
// hands the Encoding pointer to the platform lib (wgpu_shim_vello_render),
// and compares the shaded texture against the same doc's vello_cpu raster.
// This is the end-to-end check for the GPU-direct raster path: scene
// encoding, the Encoding ABI transport across cdylibs, and the shared-
// device render all have to work for the readback to match.
//
// Skips when no adapter/lib is available (CPU-only CI leg);
// DD_REQUIRE_GPU=1 turns the skip into a failure.
import { describe, expect, it } from "bun:test";

import type { WgpuDevice } from "@downdraft/platform-native/gpu/wgpu-device";
import { OsrDoc, loadOsrLib } from "./native-osr-ffi";

const W = 320;
const H = 200;

const HTML = `<html><body style="margin:0; background:#18242f; user-select:none;">
  <div style="position:absolute;left:16px;top:16px;width:120px;height:64px;background:#0366d6;border-radius:10px;color:#fff;font-size:16px">VGPU</div>
  <div style="position:absolute;left:48px;top:96px;width:150px;height:56px;background:#dd3355;border:4px solid #22cc88">B</div>
  <div style="position:absolute;left:190px;top:30px;width:80px;height:80px;background:linear-gradient(#ffaa00,#ff0066)"></div>
</body></html>`;

async function tryBootGpu() {
  const { installGPU } = await import("@downdraft/platform-native/gpu/install");
  installGPU();
  const gpu = (globalThis as Record<string, any>).navigator.gpu as GPU;
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const { computeDeviceDescriptor } = await import("@downdraft/platform-native/gpu/device-request");
  const device = await adapter.requestDevice(
    computeDeviceDescriptor(adapter as never),
  );
  return { adapter, device };
}

describe.skipIf(!loadOsrLib())("osr vello gpu raster", () => {
  it("encodes + shades a scene on the shared device, matching the CPU raster", async () => {
    if (!OsrDoc.caps.velloGpu) {
      console.log("  (skip) OSR cdylib lacks dd_osr_frame_vello");
      return;
    }
    const ctx = await tryBootGpu().catch(() => null);
    if (!ctx) {
      if (process.env.DD_REQUIRE_GPU === "1") {
        throw new Error("DD_REQUIRE_GPU=1 but no wgpu adapter was available");
      }
      console.log("  (skip) no wgpu adapter — native lib or GPU driver unavailable");
      return;
    }
    const { device } = ctx;
    const { loadWgpuVello } = await import("@downdraft/platform-native/gpu/wgpu-ffi");
    const shim = loadWgpuVello();
    if (!shim) {
      console.log("  (skip) platform lib lacks wgpu_shim_vello_render");
      return;
    }

    const target = device.createTexture({
      size: { width: W, height: H },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    }) as unknown as GPUTexture & { ptr: number | bigint };

    // Two identical docs — one CPU-rastered for the reference frame, one
    // encoded for the GPU render.
    const cpuDoc = OsrDoc.create(W, H, 1, HTML);
    const gpuDoc = OsrDoc.create(W, H, 1, HTML);
    expect(cpuDoc).not.toBeNull();
    expect(gpuDoc).not.toBeNull();

    const cpu = cpuDoc!.frame();
    expect(cpu).not.toBeNull();
    expect(cpu!.length).toBe(W * H * 4);

    const enc = gpuDoc!.frameVello();
    expect(enc).not.toBe(0);
    expect(enc).not.toBe(0n);
    const abi = gpuDoc!.velloEncAbi();
    expect(abi).not.toBe(0n);

    const rc = shim.wgpu_shim_vello_render(
      (device as unknown as WgpuDevice).ptr,
      target.ptr,
      enc,
      abi,
      W,
      H,
      0,
    );
    expect(rc).toBe(0);

    // Read the shaded texture back.
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
    const readback = device.createBuffer({
      size: bytesPerRow * H,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow },
      { width: W, height: H },
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const gpu = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();

    // CPU (vello_cpu) and GPU (vello) are different rasterizers — AA edge
    // pixels legitimately differ, but the content must match structurally:
    // no pixels may differ by a large delta anywhere.
    let bigDiffs = 0;
    let maxDelta = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ci = (y * W + x) * 4;
        const gi = y * bytesPerRow + x * 4;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(cpu![ci + c] - gpu[gi + c]);
          if (d > maxDelta) maxDelta = d;
        }
        let m = 0;
        for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(cpu![ci + c] - gpu[gi + c]));
        if (m > 32) bigDiffs++;
      }
    }
    // Flat fills dominate the scene — they must be exact or nearly so;
    // large deltas only legitimately appear on AA fringes.
    expect(bigDiffs).toBeLessThan(W * H * 0.005);

    // Sanity anchors: flat bg, the blue div's center, the red div's center.
    const bg = (y: number, x: number) => gpu.slice(y * bytesPerRow + x * 4, y * bytesPerRow + x * 4 + 4);
    expect(bg(190, 300)[2]).toBeGreaterThan(bg(190, 300)[0]); // dark-blue-ish page bg
    expect(bg(40, 60)[2]).toBeGreaterThan(150); // #0366d6 → strong blue
    expect(bg(120, 90)[0]).toBeGreaterThan(150); // #dd3355 → strong red

    // The doc stays deliverable: a follow-up CPU frame after GPU rasters
    // heals the stale-reference bookkeeping (sab_valid/damage reset).
    const cpu2 = cpuDoc!.frame();
    expect(cpu2 === null || cpu2.length === W * H * 4).toBe(true);

    cpuDoc!.destroy();
    gpuDoc!.destroy();
  });
});
