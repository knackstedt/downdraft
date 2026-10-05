// ============================================================================
// artifact-atlas/render.ts — doc-image generator for the visual-debugging guide.
//
// Renders one intentionally-broken scene per classic rendering artifact and
// captures each as a PNG under docs/site/src/assets/artifacts/. Raw wgpu on
// the native host — no game module, no sim worker, no MCP.
//
// Usage:
//   bun examples/artifact-atlas/render.ts              # all artifacts
//   bun examples/artifact-atlas/render.ts z-fighting   # one artifact
//   bun examples/artifact-atlas/render.ts all <outdir> # custom output dir
//
// Headless by default (DOWNDRAFT_GPU=swiftshader recommended for reproducible
// pixels); DOWNDRAFT_HEADED=1 shows the window.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native";
import { captureScreenshotPixels, encodePNG } from "@downdraft/platform-native/screenshot/screenshot";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mat4 } from "wgpu-matrix";

const log = createLogger("info");

const W = 960;
const H = 640;
const OUT_DIR = process.argv[3] ?? join(import.meta.dir, "../../docs/site/src/assets/artifacts");
const ONLY = process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;

const host = await createNativeHost({
  window: { title: "artifact-atlas", width: W, height: H },
  splash: false,
});
const { device, surface } = host;
const ctx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat();

mkdirSync(OUT_DIR, { recursive: true });

// ── Geometry helpers (pos xyz + normal xyz interleaved, u16 indices) ──

interface Geo { vb: GPUBuffer; ib: GPUBuffer; count: number }

function uploadGeo(posNrm: number[], idx: number[]): Geo {
  const vdata = new Float32Array(posNrm);
  const idata = new Uint16Array(idx);
  const vb = device.createBuffer({ size: vdata.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ib = device.createBuffer({ size: idata.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, vdata);
  device.queue.writeBuffer(ib, 0, idata);
  return { vb, ib, count: idx.length };
}

function cubeGeo(s = 1, reverse = false): Geo {
  const h = s / 2;
  const faces: [number[], number[]][] = [
    [[0, 0, 1], [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] as any],
    [[0, 0, -1], [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] as any],
    [[1, 0, 0], [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]] as any],
    [[-1, 0, 0], [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]] as any],
    [[0, 1, 0], [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]] as any],
    [[0, -1, 0], [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]] as any],
  ];
  const v: number[] = [];
  const idx: number[] = [];
  faces.forEach(([n, corners]) => {
    const base = v.length / 6;
    (corners as number[][]).forEach((c) => v.push(...c, ...n));
    const quad = [base, base + 1, base + 2, base, base + 2, base + 3];
    idx.push(...(reverse ? quad.reverse() : quad));
  });
  return uploadGeo(v, idx);
}

function planeGeo(w: number, d: number, y = 0): Geo {
  const hw = w / 2, hd = d / 2;
  return uploadGeo([
    -hw, y, -hd, 0, 1, 0,  hw, y, -hd, 0, 1, 0,
    hw, y, hd, 0, 1, 0,  -hw, y, hd, 0, 1, 0,
  ], [0, 2, 1, 0, 3, 2]); // CCW from +Y so the floor is front-facing
}

// Subdivided floor with tiny deterministic y-perturbation — for z-fighting,
// where the surface must weave ±1 depth quantum around a coplanar surface.
function noisyFloor(w: number, d: number, cells: number, amp: number): Geo {
  const v: number[] = [];
  const idx: number[] = [];
  const hash = (i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return (((h ^ (h >> 16)) >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const x = (i / cells - 0.5) * w;
      const z = (j / cells - 0.5) * d;
      v.push(x, hash(i, j) * amp, z, 0, 1, 0);
    }
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * (cells + 1) + i, b = a + cells + 1;
      idx.push(a, b + 1, a + 1, a, b, b + 1); // CCW from +Y
    }
  }
  return uploadGeo(v, idx);
}

function quadXY(w: number, h: number, z = 0): Geo {
  const hw = w / 2, hh = h / 2;
  return uploadGeo([
    -hw, -hh, z, 0, 0, 1,  hw, -hh, z, 0, 0, 1,
    hw, hh, z, 0, 0, 1,  -hw, hh, z, 0, 0, 1,
  ], [0, 1, 2, 0, 2, 3]);
}

function sphereGeo(r: number, seg = 32, rings = 20, zeroNormals = false): Geo {
  const v: number[] = [];
  const idx: number[] = [];
  for (let ri = 0; ri <= rings; ri++) {
    const phi = (ri / rings) * Math.PI;
    for (let si = 0; si <= seg; si++) {
      const th = (si / seg) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(th);
      v.push(r * x, r * y, r * z, ...(zeroNormals ? [0, 0, 0] : [x, y, z]));
    }
  }
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < seg; si++) {
      const a = ri * (seg + 1) + si;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return uploadGeo(v, idx);
}

// ── Uniform plumbing ──
// struct U { mvp: mat4, model: mat4, color: vec4, params: vec4 } — 160 bytes.

const UBO_SIZE = 160;
function ubo(vpm: Float32Array, model: Float32Array, color: number[], params = [0, 0, 0, 0]): GPUBuffer {
  const buf = device.createBuffer({ size: UBO_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, vpm as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 64, model as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 128, new Float32Array(color));
  device.queue.writeBuffer(buf, 144, new Float32Array(params));
  return buf;
}

const V_ATTRS: GPUVertexBufferLayout[] = [{
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
  ],
}];

const LIT_WGSL = /* wgsl */ `
struct U { mvp: mat4x4f, model: mat4x4f, color: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4f, @location(0) nrm: vec3f, @location(1) wp: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  let world = u.model * vec4f(p, 1.0);
  o.wp = world.xyz;
  o.pos = u.mvp * world;
  o.nrm = normalize((u.model * vec4f(n, 0.0)).xyz);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let l = normalize(vec3f(0.55, 0.75, 0.45));
  let diff = max(dot(normalize(v.nrm), l), 0.0);
  var rgb = u.color.rgb * (0.22 + 0.78 * diff);
  if (u.params.x > 0.5) { rgb = pow(rgb, vec3f(2.2)); } // double-gamma crush
  return vec4f(rgb, u.color.a);
}`;

interface PipeOpts {
  blend?: boolean;
  depthWrite?: boolean;
  depthCompare?: GPUCompareFunction;
  cullMode?: GPUCullMode;
  topology?: GPUPrimitiveTopology;
  arrayStride?: number;
  samples?: number;
}

function litPipe(o: PipeOpts = {}): GPURenderPipeline {
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: device.createShaderModule({ code: LIT_WGSL }), entryPoint: "vs", buffers: [{ ...V_ATTRS[0], arrayStride: o.arrayStride ?? 24 }] },
    fragment: { module: device.createShaderModule({ code: LIT_WGSL }), entryPoint: "fs", targets: [{ format, ...(o.blend ? { blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } } : {}) }] },
    primitive: { topology: o.topology ?? "triangle-list", cullMode: o.cullMode ?? "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: o.depthWrite ?? true, depthCompare: o.depthCompare ?? "less" },
    multisample: { count: o.samples ?? 1 },
  });
}

// pos+uv vertex format for procedural-texture pipelines (20-byte stride).
const UV_ATTRS: GPUVertexBufferLayout[] = [{
  arrayStride: 20,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x2" },
  ],
}];

function uvGeo(w: number, d: number, y = 0, uScale = 1, vScale = 1): Geo {
  const hw = w / 2, hd = d / 2;
  const data = new Float32Array([
    -hw, y, -hd, 0, 0,  hw, y, -hd, uScale, 0,
    hw, y, hd, uScale, vScale,  -hw, y, hd, 0, vScale,
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vb = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ib = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, data);
  device.queue.writeBuffer(ib, 0, idx);
  return { vb, ib, count: 6 };
}

// Vertical XY quad with uvs (for missing-texture / screen-space demos).
function uvQuadXY(w: number, h: number): Geo {
  const hw = w / 2, hh = h / 2;
  const data = new Float32Array([
    -hw, -hh, 0, 0, 1,  hw, -hh, 0, 1, 1,
    hw, hh, 0, 1, 0,  -hw, hh, 0, 0, 0,
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const vb = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ib = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, data);
  device.queue.writeBuffer(ib, 0, idx);
  return { vb, ib, count: 6 };
}

// ── Camera ──
const BG = { r: 0.11, g: 0.12, b: 0.16, a: 1 };

function cam(eye: number[], target: number[], near = 0.1, far = 300, fovDeg = 55, aspect = W / H): Float32Array {
  const proj = mat4.perspective((fovDeg * Math.PI) / 180, aspect, near, far);
  const view = mat4.lookAt(eye, target, [0, 1, 0]);
  return mat4.multiply(proj, view) as Float32Array;
}

// The surface may not come up at the requested size (headless clamping, DPI)
// — derive the depth attachment from each acquired texture's real extent.
function texSize(tex: GPUTexture): [number, number] {
  const t = tex as unknown as { width: number; height: number };
  return [t.width, t.height];
}

let _depthTex: GPUTexture | null = null;
let _depthView: GPUTextureView | null = null;
let _msaaColor: GPUTexture | null = null;
let _msaaDepth: GPUTexture | null = null;

function depthViewFor(tex: GPUTexture, samples = 1): GPUTextureView {
  const [w, h] = texSize(tex);
  if (samples > 1) {
    if (!_msaaDepth || _msaaDepth.width !== w || _msaaDepth.height !== h) {
      _msaaDepth?.destroy();
      _msaaDepth = device.createTexture({ size: [w, h], format: "depth24plus", sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return _msaaDepth.createView();
  }
  if (!_depthTex || _depthTex.width !== w || _depthTex.height !== h) {
    _depthTex?.destroy();
    _depthTex = device.createTexture({ size: [w, h], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    _depthView = _depthTex.createView();
  }
  return _depthView!;
}

function msaaColorViewFor(tex: GPUTexture, samples: number): GPUTextureView {
  const [w, h] = texSize(tex);
  if (!_msaaColor || _msaaColor.width !== w || _msaaColor.height !== h) {
    _msaaColor?.destroy();
    _msaaColor = device.createTexture({ size: [w, h], format, sampleCount: samples, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }
  return _msaaColor.createView();
}

interface DrawJob { pipe: GPURenderPipeline; geo: Geo; model?: Float32Array; color: number[]; params?: number[] }
interface Captured { px: Uint8Array; w: number; h: number }

function encodeJobsPass(enc: GPUCommandEncoder, tex: GPUTexture, vp: Float32Array, jobs: DrawJob[], msaa: boolean): void {
  const colorAtt: GPURenderPassColorAttachment = msaa
    ? { view: msaaColorViewFor(tex, 4), resolveTarget: tex.createView(), clearValue: BG, loadOp: "clear", storeOp: "discard" }
    : { view: tex.createView(), clearValue: BG, loadOp: "clear", storeOp: "store" };
  const pass = enc.beginRenderPass({
    colorAttachments: [colorAtt],
    depthStencilAttachment: { view: depthViewFor(tex, msaa ? 4 : 1), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
  });
  jobs.forEach((j) => {
    pass.setPipeline(j.pipe);
    pass.setBindGroup(0, device.createBindGroup({
      layout: j.pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubo(vp, j.model ?? mat4.identity() as Float32Array, j.color, j.params) } }],
    }));
    pass.setVertexBuffer(0, j.geo.vb);
    pass.setIndexBuffer(j.geo.ib, "uint16");
    pass.drawIndexed(j.geo.count);
  });
  pass.end();
}

// Encode one frame, read back the swapchain pixels, present.
async function drawAndReadback(encode: (enc: GPUCommandEncoder, tex: GPUTexture) => void): Promise<Captured> {
  const tex = ctx.getCurrentTexture();
  const enc = device.createCommandEncoder();
  encode(enc, tex);
  device.queue.submit([enc.finish()]);
  const [w, h] = texSize(tex);
  const px = captureScreenshotPixels(device as never, tex as never, w, h, format);
  ctx.present();
  await new Promise((r) => setTimeout(r, 30));
  return { px, w, h };
}

function writePng(name: string, px: Uint8Array, w: number, h: number): void {
  writeFileSync(join(OUT_DIR, `${name}.png`), encodePNG(w, h, px));
  log.info("atlas", `wrote ${name}.png`);
}

// Splice left half of `a` with right half of `b`, separated by a divider —
// "correct | broken" comparisons read instantly in the docs.
function spliceHalves(a: Captured, b: Captured): Captured {
  const { w, h } = a;
  const out = new Uint8Array(w * h * 4);
  const half = w / 2;
  for (let y = 0; y < h; y++) {
    out.set(a.px.subarray(y * w * 4, y * w * 4 + half * 4), y * w * 4);
    out.set(b.px.subarray(y * w * 4 + half * 4, (y + 1) * w * 4), y * w * 4 + half * 4);
    [half - 1, half].forEach((dx) => out.set([255, 255, 255, 255], (y * w + dx) * 4));
  }
  return { px: out, w, h };
}

// Render one artifact as a single frame.
async function frame(name: string, vp: Float32Array, jobs: DrawJob[], msaa = false): Promise<void> {
  const r = await drawAndReadback((enc, tex) => encodeJobsPass(enc, tex, vp, jobs, msaa));
  writePng(name, r.px, r.w, r.h);
}

// Render two variants and splice: left = `left` (correct), right = `right` (broken).
async function splitFrame(name: string, vpL: Float32Array, jobsL: DrawJob[], vpR: Float32Array, jobsR: DrawJob[], msaaL = false, msaaR = false): Promise<void> {
  const a = await drawAndReadback((enc, tex) => encodeJobsPass(enc, tex, vpL, jobsL, msaaL));
  let b = await drawAndReadback((enc, tex) => encodeJobsPass(enc, tex, vpR, jobsR, msaaR));
  // The headless surface can settle to its real size only after the first
  // acquire; if the second frame came back a different size, retry it.
  for (let tries = 0; tries < 4 && (b.w !== a.w || b.h !== a.h); tries++) {
    b = await drawAndReadback((enc, tex) => encodeJobsPass(enc, tex, vpR, jobsR, msaaR));
  }
  const s = spliceHalves(a, b);
  writePng(name, s.px, s.w, s.h);
}

// Custom fragment-shader pipelines (uv checker / magenta / gradient).
function uvPipe(code: string, o: PipeOpts = {}): GPURenderPipeline {
  const mod = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: mod, entryPoint: "vs", buffers: UV_ATTRS },
    fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: o.topology ?? "triangle-list", cullMode: o.cullMode ?? "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: o.depthWrite ?? true, depthCompare: o.depthCompare ?? "less" },
  });
}

const UV_VS = /* wgsl */ `
struct U { mvp: mat4x4f, model: mat4x4f, color: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) p: vec3f, @location(1) uv: vec2f) -> VOut {
  var o: VOut;
  o.pos = u.mvp * u.model * vec4f(p, 1.0);
  o.uv = uv;
  return o;
}`;

const CHECKER_FS = /* wgsl */ `
${UV_VS}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let c = floor(v.uv.x * 8.0) + floor(v.uv.y * 8.0);
  let m = c - 2.0 * floor(c / 2.0);
  return select(vec4f(0.85, 0.85, 0.85, 1.0), vec4f(0.3, 0.3, 0.35, 1.0), m > 0.5);
}`;

const MAGENTA_FS = /* wgsl */ `
${UV_VS}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let c = floor(v.uv.x * 8.0) + floor(v.uv.y * 8.0);
  let m = c - 2.0 * floor(c / 2.0);
  return select(vec4f(1.0, 0.0, 1.0, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), m > 0.5);
}`;

// ── Skinned cylinder (pos+nrm+joints+weights) ──

const SKIN_WGSL = /* wgsl */ `
struct U { mvp: mat4x4f, model: mat4x4f, color: vec4f, params: vec4f, bones: array<mat4x4f, 4> };
@group(0) @binding(0) var<uniform> u: U;
struct VOut { @builtin(position) pos: vec4f, @location(0) nrm: vec3f };
@vertex fn vs(
  @location(0) p: vec3f, @location(1) n: vec3f,
  @location(2) joints: vec4f, @location(3) weights: vec4f
) -> VOut {
  var o: VOut;
  var skin = mat4x4f();
  skin += weights.x * u.bones[u32(joints.x)];
  skin += weights.y * u.bones[u32(joints.y)];
  skin += weights.z * u.bones[u32(joints.z)];
  skin += weights.w * u.bones[u32(joints.w)];
  let world = u.model * skin * vec4f(p, 1.0);
  o.pos = u.mvp * world;
  o.nrm = normalize((u.model * skin * vec4f(n, 0.0)).xyz);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let l = normalize(vec3f(0.55, 0.75, 0.45));
  let diff = max(dot(normalize(v.nrm), l), 0.0);
  return vec4f(u.color.rgb * (0.22 + 0.78 * diff), u.color.a);
}`;

const SKIN_ATTRS: GPUVertexBufferLayout[] = [{
  arrayStride: 56,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "float32x3" },
    { shaderLocation: 2, offset: 24, format: "float32x4" },
    { shaderLocation: 3, offset: 40, format: "float32x4" },
  ],
}];

function skinnedCylinder(r = 0.35, h = 3, segs = 20, rings = 12): { vb: GPUBuffer; ib: GPUBuffer; count: number } {
  const v: number[] = [];
  const idx: number[] = [];
  for (let ri = 0; ri <= rings; ri++) {
    const y = (ri / rings) * h;
    // Lower half → bone 0, upper half → bone 1, blend band in the middle.
    const t = Math.min(Math.max((y / h - 0.45) * 10, 0), 1);
    for (let si = 0; si <= segs; si++) {
      const th = (si / segs) * Math.PI * 2;
      const x = Math.cos(th), z = Math.sin(th);
      v.push(r * x, y, r * z, x, 0, z, 0, 1, 0, 0, 1 - t, t, 0, 0);
    }
  }
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      const a = ri * (segs + 1) + si, b = a + segs + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const vdata = new Float32Array(v);
  const idata = new Uint16Array(idx);
  const vb = device.createBuffer({ size: vdata.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const ib = device.createBuffer({ size: idata.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vb, 0, vdata);
  device.queue.writeBuffer(ib, 0, idata);
  return { vb, ib, count: idx.length };
}

function skinUbo(vp: Float32Array, model: Float32Array, color: number[], bones: Float32Array[]): GPUBuffer {
  const buf = device.createBuffer({ size: UBO_SIZE + 4 * 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, vp as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 64, model as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 128, new Float32Array(color));
  bones.forEach((b, i) => device.queue.writeBuffer(buf, 160 + i * 64, b as Float32Array<ArrayBuffer>));
  return buf;
}

// ── Shadow pipelines ──

const SHADOW_SIZE = 1024;
const shadowDepthTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });

const DEPTH_WGSL = /* wgsl */ `
struct U { mvp: mat4x4f, model: mat4x4f, color: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> @builtin(position) vec4f {
  return u.mvp * u.model * vec4f(p, 1.0);
}`;

const depthOnlyPipe = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: device.createShaderModule({ code: DEPTH_WGSL }), entryPoint: "vs", buffers: V_ATTRS },
  primitive: { topology: "triangle-list", cullMode: "none" },
  depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" },
});

const SHADED_WGSL = /* wgsl */ `
struct U { mvp: mat4x4f, model: mat4x4f, color: vec4f, params: vec4f, lightVP: mat4x4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var shadowTex: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
struct VOut { @builtin(position) pos: vec4f, @location(0) nrm: vec3f, @location(1) sc: vec4f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VOut {
  var o: VOut;
  let world = u.model * vec4f(p, 1.0);
  o.pos = u.mvp * world;
  o.nrm = normalize((u.model * vec4f(n, 0.0)).xyz);
  o.sc = u.lightVP * world;
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let l = normalize(vec3f(0.55, 0.75, 0.45));
  var ndl = max(dot(normalize(v.nrm), l), 0.0);
  var sc = v.sc.xyz / v.sc.w;
  var shadow = 1.0;
  if (sc.x > -1.0 && sc.x < 1.0 && sc.y > -1.0 && sc.y < 1.0) {
    let uv = vec2f(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
    shadow = textureSampleCompare(shadowTex, shadowSamp, uv, sc.z - u.params.x);
  }
  let rgb = u.color.rgb * (0.22 + 0.78 * ndl * shadow);
  return vec4f(rgb, 1.0);
}`;

const shadowSamp = device.createSampler({ compare: "less-equal" });
const shadowTexView = shadowDepthTex.createView();

function shadowPipe(): GPURenderPipeline {
  const mod = device.createShaderModule({ code: SHADED_WGSL });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module: mod, entryPoint: "vs", buffers: V_ATTRS },
    fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });
}

function shadowUbo(vp: Float32Array, model: Float32Array, color: number[], lightVP: Float32Array, bias: number): GPUBuffer {
  const buf = device.createBuffer({ size: UBO_SIZE + 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, vp as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 64, model as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(buf, 128, new Float32Array(color));
  device.queue.writeBuffer(buf, 144, new Float32Array([bias, 0, 0, 0]));
  device.queue.writeBuffer(buf, 160, lightVP as Float32Array<ArrayBuffer>);
  return buf;
}

async function shadowPixels(bias: number, lightEye = [12, 9, 8]): Promise<Captured> {
  const ground = planeGeo(30, 30);
  const box = cubeGeo(2);
  const lit = [0.9, 0.8, 0.65, 1];
  const groundCol = [0.55, 0.58, 0.62, 1];

  const lightTgt = [0, 0, 0];
  const lightView = mat4.lookAt(lightEye, lightTgt, [0, 1, 0]);
  const lightProj = mat4.ortho(-16, 16, -16, 16, 1, 45);
  const lightVP = mat4.multiply(lightProj, lightView) as Float32Array;

  // Pass 2: camera view sampling the shadow map. Camera sits opposite the
  // light's horizontal direction so the cast shadow lands on the near side.
  const vp = cam([-9, 7.5, -10], [0, 0.5, 0]);
  const pipe = shadowPipe();

  return drawAndReadback((enc, tex) => {
    // Pass 1: depth from the light (same encoder — ordered before pass 2).
    const dpass = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: shadowTexView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    dpass.setPipeline(depthOnlyPipe);
    ([[ground, mat4.identity()], [box, mat4.translation([0, 1, 0])]] as [Geo, Float32Array][]).forEach(([geo, model]) => {
      dpass.setBindGroup(0, device.createBindGroup({
        layout: depthOnlyPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ubo(lightVP, model, lit) } }],
      }));
      dpass.setVertexBuffer(0, geo.vb);
      dpass.setIndexBuffer(geo.ib, "uint16");
      dpass.drawIndexed(geo.count);
    });
    dpass.end();

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: tex.createView(), clearValue: BG, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depthViewFor(tex), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    pass.setPipeline(pipe);
    const bgl = pipe.getBindGroupLayout(0);
    ([
      [ground, mat4.identity(), groundCol],
      [box, mat4.translation([0, 1, 0]), lit],
    ] as [Geo, Float32Array, number[]][]).forEach(([geo, model, color]) => {
      pass.setBindGroup(0, device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: shadowUbo(vp, model, color, lightVP, bias) } },
          { binding: 1, resource: shadowTexView },
          { binding: 2, resource: shadowSamp },
        ],
      }));
      pass.setVertexBuffer(0, geo.vb);
      pass.setIndexBuffer(geo.ib, "uint16");
      pass.drawIndexed(geo.count);
    });
    pass.end();
  });
}

// ── Artifact scenes ──

const lit = () => litPipe();
const I = () => mat4.identity() as Float32Array;
const T = (p: number[]) => mat4.translation(p) as Float32Array;

const artifacts: Record<string, () => Promise<void>> = {

  // Two surfaces at nearly the same depth — depth-buffer precision runs out
  // and pixels pick a winner per-texel, flickering as the camera moves.
  "z-fighting": async () => {
    // Flat floor + a second coplanar floor whose vertices are perturbed by a
    // sub-depth-quantum noise — it weaves in and out of the first surface and
    // every crossing dissolves into per-pixel patchwork.
    const vp = cam([0, 2.2, 10], [0, 0, -14], 0.1, 400);
    const floor = planeGeo(160, 160);
    const fighting = noisyFloor(160, 160, 64, 8e-5);
    const p = lit();
    await frame("z-fighting", vp, [
      { pipe: p, geo: floor, color: [0.32, 0.42, 0.55, 1] },
      { pipe: p, geo: fighting, color: [0.9, 0.35, 0.2, 1] },
    ]);
  },

  // Right cube has its index order reversed — front faces get culled and you
  // see the inside of the shell ("holes", "inside-out", "see-through mesh").
  "inside-out": async () => {
    const vp = cam([0, 1.4, 5.2], [0, 0.5, 0]);
    const good = cubeGeo(1.4);
    const bad = cubeGeo(1.4, true);
    const marker = cubeGeo(0.55);
    const p = lit();
    await frame("inside-out", vp, [
      { pipe: p, geo: marker, model: T([1.4, 0.7, -2.0]), color: [1.0, 0.85, 0.15, 1] },
      { pipe: p, geo: marker, model: T([-1.4, 0.7, -2.0]), color: [1.0, 0.85, 0.15, 1] },
      { pipe: p, geo: good, model: T([-1.4, 0.7, 0]), color: [0.5, 0.65, 0.9, 1] },
      { pipe: p, geo: bad, model: T([1.4, 0.7, 0]), color: [0.5, 0.65, 0.9, 1] },
    ]);
  },

  // Zeroed normals → the lambert term is 0 everywhere; the mesh renders as a
  // flat dark blob even under a lit scene ("my model is black").
  "bad-normals": async () => {
    const vp = cam([0, 1.2, 6], [0, 0.4, 0]);
    const good = sphereGeo(1.1);
    const bad = sphereGeo(1.1, 32, 20, true);
    const p = lit();
    await frame("bad-normals", vp, [
      { pipe: p, geo: good, model: T([-1.7, 0.6, 0]), color: [0.55, 0.8, 0.55, 1] },
      { pipe: p, geo: bad, model: T([1.7, 0.6, 0]), color: [0.55, 0.8, 0.55, 1] },
    ]);
  },

  // Vertex buffer read with the wrong stride — attributes land on the wrong
  // data and the mesh shatters into a spiky, half-recognizable mess.
  "vertex-scramble": async () => {
    const vp = cam([0, 1.6, 6], [0, 0.6, 0]);
    const good = cubeGeo(1.6);
    const pGood = lit();
    const pBad = litPipe({ arrayStride: 56 });
    await frame("vertex-scramble", vp, [
      { pipe: pGood, geo: good, model: T([-1.9, 0.8, 0]), color: [0.5, 0.65, 0.9, 1] },
      { pipe: pBad, geo: good, model: T([1.9, 0.8, 0]), color: [0.9, 0.45, 0.35, 1] },
    ]);
  },

  // Joint palette has garbage transforms — skinned verts fly to wherever the
  // wrong matrices point ("stretched mesh", "spaghetti monster").
  "skinning-explosion": async () => {
    const vp = cam([0, 2.2, 9], [0.5, 1.4, 0]);
    const cyl = skinnedCylinder();
    const mod = device.createShaderModule({ code: SKIN_WGSL });
    const pipe = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs", buffers: SKIN_ATTRS },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    const tex = ctx.getCurrentTexture();
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: tex.createView(), clearValue: BG, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depthViewFor(tex), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setPipeline(pipe);
    const bgl = pipe.getBindGroupLayout(0);

    // Correct arm on the left: bone 1 bends forward slightly.
    const bend = mat4.multiply(T([0, 1.35, 0]), mat4.multiply(mat4.rotationX(0.5) as Float32Array, T([0, -1.35, 0]))) as Float32Array;
    pass.setBindGroup(0, device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: skinUbo(vp, T([-1.6, 0, 0]), [0.55, 0.8, 0.6, 1], [I(), bend, I(), I()]) } }],
    }));
    pass.setVertexBuffer(0, cyl.vb);
    pass.setIndexBuffer(cyl.ib, "uint16");
    pass.drawIndexed(cyl.count);

    // Broken arm on the right: bone 1 replaced by a garbage transform
    // (huge scale + translation — the classic "wrong bind pose" blast).
    const garbage = mat4.multiply(T([9, 5, -4]), mat4.scaling([6, 9, 6])) as Float32Array;
    pass.setBindGroup(0, device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: skinUbo(vp, T([1.4, 0, 0]), [0.9, 0.55, 0.45, 1], [I(), garbage, I(), I()]) } }],
    }));
    pass.drawIndexed(cyl.count);
    pass.end();
    device.queue.submit([enc.finish()]);
    const [w2, h2] = texSize(tex);
    const px = captureScreenshotPixels(device as never, tex as never, w2, h2, format);
    ctx.present();
    writePng("skinning-explosion", px, w2, h2);
    await new Promise((r) => setTimeout(r, 30));
  },

  // Near translucent quad drawn first WITH depth writes — the far translucent
  // quad gets depth-rejected where they overlap ("transparency sorting bug",
  // "holes in glass/water/particles"). Left: correct — both blend through.
  "transparency-order": async () => {
    // Camera on +z looking -z — quadXY's +z-facing side is the visible one.
    const vp = cam([0, 0.4, 8], [0, 0.4, 0]);
    const wall = quadXY(10, 6);
    const red = quadXY(4.2, 4.2);
    const blue = quadXY(4.2, 4.2);
    const pSolid = lit();
    const pBlend = litPipe({ blend: true, depthWrite: false });
    const pBlendWrite = litPipe({ blend: true });          // depth writes ON — the bug
    const wallJob = { pipe: pSolid, geo: wall, model: T([0, 0.4, -6]), color: [0.55, 0.85, 0.55, 1] };
    const redJob = (pipe: GPURenderPipeline) => ({ pipe, geo: red, model: T([-1.2, 0.5, 4]), color: [1.0, 0.2, 0.15, 0.65] });
    const blueJob = (pipe: GPURenderPipeline) => ({ pipe, geo: blue, model: T([0.4, 0.4, 3]), color: [0.25, 0.5, 1.0, 0.65] });
    await splitFrame("transparency-order",
      // Left: correct — far quad first, no depth writes, both blend.
      vp, [wallJob, blueJob(pBlend), redJob(pBlend)],
      // Right: buggy — red (NEARER) drawn first and writes depth; blue gets
      // depth-rejected wherever red covers it → rectangular bite.
      vp, [wallJob, redJob(pBlendWrite), blueJob(pBlendWrite)]);
  },

  // Depth test disabled on the "enemy" — it renders on top of the wall that
  // should occlude it ("I can see players through walls"). The wall is built
  // with a window opening, so on the left the sphere is only visible through
  // the hole — unmistakably BEHIND the wall — while on the right it's drawn
  // across the whole wall face.
  "no-depth-test": async () => {
    const vp = cam([0, 1.6, 7], [0, 1.3, -1]);
    const ground = planeGeo(22, 22);
    const enemy = sphereGeo(1.3);
    const pLit = lit();
    const pNoDepth = litPipe({ depthWrite: false, depthCompare: "always" });
    // Window gap: x ∈ [-1.1, 1.1], y ∈ [0.5, 2.3] — sphere sits centered in it.
    const wallAt = (w: number, h: number, x: number, y: number) => ({
      pipe: pLit, geo: quadXY(w, h), model: T([x, y, 0]), color: [0.48, 0.5, 0.56, 1],
    });
    const wallJobs: DrawJob[] = [
      wallAt(3.6, 5.0, -2.9, 1.5),   // left panel
      wallAt(3.6, 5.0, 2.9, 1.5),    // right panel
      wallAt(2.2, 1.6, 0, -0.3),     // below window
      wallAt(2.2, 1.9, 0, 3.25),     // above window
    ];
    const groundJob = { pipe: pLit, geo: ground, color: [0.3, 0.32, 0.36, 1] };
    const enemyJob = (pipe: GPURenderPipeline) => ({
      pipe, geo: enemy, model: T([0, 2.15, -3.2]), color: [0.95, 0.85, 0.2, 1],
    });
    await splitFrame("no-depth-test",
      vp, [groundJob, ...wallJobs, enemyJob(pLit)],
      vp, [groundJob, ...wallJobs, enemyJob(pNoDepth)]);
  },

  // Thin diagonal geometry at 1× MSAA — every edge stair-steps. Right half:
  // the same scene at 4× MSAA, smooth ("jagged edges", "pixelated lines").
  "jaggies": async () => {
    const vp = cam([0, 0, 6], [0, 0, 0], 0.1, 50, 50);
    const beam = quadXY(14, 0.09);
    const jobsFor = (p: GPURenderPipeline): DrawJob[] => {
      const jobs: DrawJob[] = [];
      ([[7, 1.9], [12, 0.95], [19, 0.0], [33, -0.95], [57, -1.9]] as const).forEach(([angle, y]) => {
        jobs.push({
          pipe: p, geo: beam,
          model: mat4.multiply(T([0, y, 0]), mat4.rotationZ((angle * Math.PI) / 180)) as Float32Array,
          color: [0.95, 0.92, 0.6, 1],
        });
      });
      return jobs;
    };
    await splitFrame("jaggies", vp, jobsFor(litPipe({ cullMode: "none", samples: 4 })), vp, jobsFor(litPipe({ cullMode: "none" })), true);
  },

  // Left: grid of true squares at the surface's real aspect. Right: the same
  // grid drawn with aspect=1.0 — everything stretches ("game looks squashed").
  "aspect-stretch": async () => {
    const cell = quadXY(0.82, 0.82);
    const p = litPipe({ cullMode: "none" });
    const jobs: DrawJob[] = [];
    for (let ix = -2; ix <= 2; ix++) {
      for (let iy = -2; iy <= 2; iy++) {
        const on = (ix + iy) % 2 === 0;
        jobs.push({
          pipe: p, geo: cell,
          model: T([ix * 0.9, iy * 0.9, 0]),
          color: on ? [0.8, 0.8, 0.85, 1] : [0.25, 0.28, 0.35, 1],
        });
      }
    }
    const vpGood = cam([0, 0, 5], [0, 0, 0], 0.1, 50, 50, W / H);
    const vpBad = cam([0, 0, 5], [0, 0, 0], 0.1, 50, 50, 1.0); // WRONG aspect — the bug
    await splitFrame("aspect-stretch", vpGood, jobs, vpBad, jobs);
  },

  // Left floor: correct UVs. Right floor: u scaled way down — the checkerboard
  // smears into wide streaks ("texture looks stretched/smeared").
  "uv-stretch": async () => {
    const vp = cam([0, 4.0, 7.5], [0, 0, -2]);
    const good = uvGeo(7, 14, 0, 1.4, 2.8);
    const bad = uvGeo(7, 14, 0, 0.12, 2.8);
    const p = uvPipe(CHECKER_FS);
    await frame("uv-stretch", vp, [
      { pipe: p, geo: good, model: T([-3.55, 0, -2]), color: [1, 1, 1, 1] },
      { pipe: p, geo: bad, model: T([3.55, 0, -2]), color: [1, 1, 1, 1] },
    ]);
  },

  // Sphere pushed through the near plane — the front is clipped and you see
  // the hollow inside ("geometry disappears/slices when I get close").
  "near-clip": async () => {
    const sphere = sphereGeo(1.5);
    const p = litPipe({ cullMode: "none" });
    const jobs: DrawJob[] = [
      { pipe: p, geo: sphere, model: T([0, 0.3, 0]), color: [0.7, 0.5, 0.85, 1] },
    ];
    // Left: healthy near plane, sphere intact. Right: near=3.4 slices the
    // front hemisphere off — you're left staring into the hollow shell.
    await splitFrame("near-clip",
      cam([0, 0.4, 4.5], [0, 0.3, 0], 0.1, 60), jobs,
      cam([0, 0.4, 4.5], [0, 0.3, 0], 3.4, 60), jobs);
  },

  // The classic engine fallback for a failed texture bind — magenta/black
  // checkerboard ("my model is pink", "texture won't load").
  "missing-texture": async () => {
    const vp = cam([0, 1.2, 4.5], [0, 0.6, 0]);
    const quad = uvQuadXY(2.6, 2.6);
    const p = uvPipe(MAGENTA_FS, { cullMode: "none" });
    const rot = mat4.multiply(T([0, 0.9, 0]), mat4.rotationY(0.5)) as Float32Array;
    await frame("missing-texture", vp, [
      { pipe: p, geo: quad, model: rot, color: [1, 1, 1, 1] },
    ]);
  },

  // Left: the scene as authored. Right: gamma applied twice — crushed,
  // oversaturated darks ("colors look too dark/washed out").
  "gamma-crush": async () => {
    const vp = cam([0, 2.2, 6.5], [0, 0.6, 0]);
    const ground = planeGeo(18, 18);
    const sphere = sphereGeo(0.8);
    const p = lit();
    const jobs = (crush: number): DrawJob[] => ([
      { pipe: p, geo: ground, color: [0.5, 0.52, 0.55, 1], params: [crush, 0, 0, 0] },
      { pipe: p, geo: sphere, model: T([-1.6, 0.8, 0]), color: [0.85, 0.3, 0.25, 1], params: [crush, 0, 0, 0] },
      { pipe: p, geo: sphere, model: T([0, 0.8, -0.5]), color: [0.35, 0.75, 0.4, 1], params: [crush, 0, 0, 0] },
      { pipe: p, geo: sphere, model: T([1.6, 0.8, 0]), color: [0.35, 0.5, 0.9, 1], params: [crush, 0, 0, 0] },
      { pipe: p, geo: sphere, model: T([0, 0.8, 1.6]), color: [0.9, 0.8, 0.3, 1], params: [crush, 0, 0, 0] },
    ]);
    await splitFrame("gamma-crush", vp, jobs(0), vp, jobs(1));
  },

  "shadow-acne": async () => {
    const c = await shadowPixels(0.00002);
    writePng("shadow-acne", c.px, c.w, c.h);
  },

  // Left: sane bias — shadow touches the caster's base. Right: bias way too
  // large — the shadow is pushed so far along the light ray it detaches and
  // "floats" behind the box ("shadows detach/offset from objects").
  "peter-panning": async () => {
    // Low, grazing light → long shadow; the huge bias then shoves it a
    // couple of meters away from the box — unmistakably detached.
    const good = await shadowPixels(0.004, [14, 4.5, 9]);
    const bad = await shadowPixels(0.09, [14, 4.5, 9]);
    const s = spliceHalves(good, bad);
    writePng("peter-panning", s.px, s.w, s.h);
  },
};

// ── Driver ──

const names = Object.keys(artifacts);
const toRun = ONLY ? names.filter((n) => n === ONLY) : names;
if (ONLY && toRun.length === 0) {
  log.error("atlas", `unknown artifact "${ONLY}" — options: ${names.join(", ")}`);
  host.destroy();
  process.exit(1);
}
// Warm-up: the headless surface reports the requested size on first acquire,
// then settles to its real size after a resize — burn two frames so every
// captured artifact (and both halves of a split) uses the settled dims.
{
  ctx.getCurrentTexture();
  ctx.present();
  await new Promise((r) => setTimeout(r, 120));
  ctx.getCurrentTexture();
  ctx.present();
  await new Promise((r) => setTimeout(r, 120));
}

log.info("atlas", `rendering ${toRun.length} artifact(s) → ${OUT_DIR}`);
for (let i = 0; i < toRun.length; i++) await artifacts[toRun[i]]();

// Give the event loop a beat to flush presents, then tear down.
await new Promise((r) => setTimeout(r, 300));
host.destroy();
log.info("atlas", "done");
