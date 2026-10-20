// resolution-scale.ts — measures the offscreen resolution-scaling path.
//
// Renders a fill-bound scene (N fullscreen overdraw quads) into the scaled
// offscreen target, then blits it onto a canvas-sized texture via
// ResolutionScaleOffscreen.applyPostprocess — the same path
// GameRenderer.setResolutionScale uses on the native runtime.
//
// Run: DOWNDRAFT_GPU=swiftshader bun run packages/engine/bench/resolution-scale.ts
// (DOWNDRAFT_GPU picks the adapter; swiftshader/lavapipe is deterministic and
// available in CI. On a hardware GPU the scaling win is much larger.)

import { computeDeviceDescriptor } from "../../platform-native/src/gpu/device-request";
import { queryNativeFeatures, serializeRequiredFeatures, serializeRequiredLimits } from "../../platform-native/src/gpu/limits";
import { WgpuDevice } from "../../platform-native/src/gpu/wgpu-device";
import { wgpu } from "../../platform-native/src/gpu/wgpu-ffi";
import { ResolutionScaleOffscreen } from "../core/src/render/offscreen-scale";

const W = 1280;
const H = 720;
const OVERDRAW = 4; // fullscreen quads per frame
const WARMUP = 8;
const FRAMES = 30;
const SCALES = [1.0, 0.75, 0.5, 0.25];

(globalThis as Record<string, unknown>).GPUTextureUsage ??= {
  COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10,
};
(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80,
};
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

function createDevice(): WgpuDevice | null {
  const inst = wgpu.wgpu_shim_create_instance() as unknown as number;
  const adapterPtr = wgpu.wgpu_shim_request_adapter(inst, 0) as unknown as number;
  if (!adapterPtr) return null;
  const features = queryNativeFeatures(adapterPtr, false);
  const has = (f: string) => (features as unknown as { has(f: string): boolean }).has(f);
  const desc = computeDeviceDescriptor({ features: { has }, limits: {} } as GPUAdapter);
  const wireFeatures = serializeRequiredFeatures(desc.requiredFeatures as unknown as string[]);
  const wireLimits = serializeRequiredLimits(desc.requiredLimits as Record<string, number>);
  const devicePtr = wgpu.wgpu_shim_request_device(
    adapterPtr,
    wireLimits as unknown as number,
    wireLimits.length / 3,
    wireFeatures as unknown as number,
    wireFeatures.length,
  ) as unknown as number;
  return devicePtr ? new WgpuDevice(devicePtr, inst) : null;
}

const FILL_WGSL = /* wgsl */ `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let x = f32(vi & 1u) * 4.0 - 1.0;
  let y = f32((vi >> 1u) & 1u) * 4.0 - 1.0;
  return vec4<f32>(x, y, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  // ~32 sin() ops per pixel — per-pixel ALU scales with rasterized area, so
  // lower render scales must reduce total work even on a CPU rasterizer.
  var acc = vec4<f32>(p.xy * 0.001, 0.5, 1.0);
  for (var i = 0; i < 32; i++) {
    acc = sin(acc * 1.01 + f32(i) * 0.173);
  }
  return acc * 0.5 + 0.5;
}
`;

const device = createDevice();
if (!device) {
  console.error("no GPU adapter — set DOWNDRAFT_GPU=swiftshader or run on a machine with a GPU");
  process.exit(1);
}

const fillModule = device.createShaderModule({ code: FILL_WGSL });
const fillPipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: fillModule, entryPoint: "vs_main" },
  fragment: { module: fillModule, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});

// "Canvas" — a full-size texture standing in for the swapchain view.
const canvasTex = device.createTexture({
  size: { width: W, height: H },
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});
const canvasView = canvasTex.createView();

function encodeScene(view: GPUTextureView, w: number, h: number): GPUCommandBuffer {
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(fillPipeline);
  for (let i = 0; i < OVERDRAW; i++) pass.draw(3);
  pass.end();
  void w; void h;
  return enc.finish();
}

async function frame(work: () => GPUCommandBuffer[]): Promise<number> {
  const t0 = performance.now();
  device.queue.submit(work());
  await (device.queue as unknown as { onSubmittedWorkDone(): Promise<undefined> }).onSubmittedWorkDone();
  return performance.now() - t0;
}

async function run(scale: number): Promise<{ ms: number }> {
  const mode = new ResolutionScaleOffscreen({ device: device as unknown as GPUDevice, surfaceFormat: "rgba8unorm", scale });
  mode.ensureTargets(W, H);
  const target = mode.getTargetSize();
  const direct = scale === 1;

  const doFrame = () => {
    const scene = encodeScene(direct ? canvasView : mode.getColorView(), target.width, target.height);
    if (direct) return [scene];
    const blit = device.createCommandEncoder();
    mode.applyPostprocess!(blit, canvasView, W, H);
    return [scene, blit.finish() as GPUCommandBuffer];
  };

  for (let i = 0; i < WARMUP; i++) await frame(doFrame);
  let total = 0;
  for (let i = 0; i < FRAMES; i++) total += await frame(doFrame);
  mode.destroy();
  return { ms: total / FRAMES };
}

console.log(`resolution-scale bench — ${W}x${H}, ${OVERDRAW}x overdraw, ${FRAMES} frames/scale`);
console.log(`${"scale".padStart(6)} ${"target".padStart(11)} ${"ms/frame".padStart(9)} ${"vs 1.0".padStart(8)}`);
let baseline = 0;
for (let i = 0; i < SCALES.length; i++) {
  const s = SCALES[i];
  const r = await run(s);
  if (s === 1) baseline = r.ms;
  const t = { w: Math.round(W * s), h: Math.round(H * s) };
  const speedup = baseline > 0 ? `-${((1 - r.ms / baseline) * 100).toFixed(0)}%` : "—";
  console.log(
    `${s.toFixed(2).padStart(6)} ${`${t.w}x${t.h}`.padStart(11)} ${r.ms.toFixed(2).padStart(9)} ${speedup.padStart(8)}`
  );
}
process.exit(0);
