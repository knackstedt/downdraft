// ============================================================================
// gpu-slot.ts — a live WebGPU surface composited INSIDE a Blitz scroll area.
//
// The Blitz doc carries a placeholder element (`#gpu-slot`) inside a
// `.dd-scroll` container. This renderer module renders an animated scene
// into an offscreen texture every frame, tracks the placeholder's rect via
// the panel's getRect() (scroll-adjusted doc coords), clips it against the
// scroll container's rect, and draws the texture through PanelBlitPass in a
// custom ScreenUiCompositor — so real GPU-rendered content scrolls and clips
// with the document exactly like a native <canvas> would.
//
//   const gpu = createGpuSlot();
//   renderer.useRendererModule(gpu.module);
//   // inside createHtmlUi build():
//   gpu.attach(doc, {
//     slot: "#gpu-slot", clip: "#gallery-scroll",
//     zoom: () => surface.width / surface.clientWidth * ui.uiZoom,
//   });
//   gpu.refresh(); // after page switches / doc mutations / scroll events
// ============================================================================

import type { RendererModule, RendererModuleContext } from "@downdraft/engine/module";
import { PanelBlitPass, type CompositePanel, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";

interface DocRect { x: number; y: number; w: number; h: number }
interface ScreenRect { x: number; y: number; w: number; h: number }

export interface GpuSlotAttach {
  /** Selector of the placeholder element that gets the GPU texture. */
  slot: string;
  /** Selector of the scroll/viewport container the slot is clipped to. */
  clip?: string;
  /** Selector matching elements that must cover the surface (modals,
   *  blades, context menus) — the slot composites ABOVE the whole panel,
   *  so any match suppresses the blit entirely. */
  occluders?: string;
  /** Doc-CSS-px → surface-buffer-px factor (panel zoom × app uiZoom). */
  zoom: () => number;
}

const TEX_W = 640;
const TEX_H = 400;

const BG_WGSL = /* wgsl */`
struct VOut { @builtin(position) p: vec4<f32>, @location(0) uv: vec2<f32> };
@group(0) @binding(0) var<uniform> t: f32;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var pos = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: VOut;
  o.p = vec4(pos[vi], 0.999, 1.0);
  o.uv = pos[vi] * 0.5 + 0.5;
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let wave = 0.5 + 0.5 * sin(v.uv.x * 9.0 + t * 0.9) * cos(v.uv.y * 7.0 - t * 0.6);
  let base = mix(vec3(0.04, 0.07, 0.11), vec3(0.10, 0.20, 0.30), v.uv.y);
  let glow = vec3(0.10, 0.45, 0.65) * wave * 0.35;
  let grid = step(0.97, fract(v.uv.x * 24.0 + t * 0.15)) + step(0.97, fract(v.uv.y * 15.0));
  return vec4(base + glow + vec3(0.05, 0.18, 0.22) * clamp(grid, 0.0, 1.0), 1.0);
}
`;

const CUBE_WGSL = /* wgsl */`
struct U { mvp: mat4x4<f32>, light: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VIn { @location(0) pos: vec3<f32>, @location(1) norm: vec3<f32>, @location(2) tint: vec3<f32> };
struct VOut { @builtin(position) p: vec4<f32>, @location(0) c: vec3<f32> };
@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.p = u.mvp * vec4(v.pos, 1.0);
  let l = max(dot(normalize(v.norm), normalize(u.light.xyz)), 0.0);
  o.c = v.tint * (0.30 + 0.70 * l);
  return o;
}
@fragment fn fs(v: VOut) -> @location(0) vec4<f32> { return vec4(v.c, 1.0); }
`;

// ── minimal mat4 (column-major, matches WGSL layout) ──
function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  const o = new Float32Array(16);
  o[0] = f / aspect; o[5] = f;
  o[10] = (far + near) * nf; o[11] = -1;
  o[14] = 2 * far * near * nf;
  return o;
}
function mat4RotY(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  // column-major rotation about Y
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}
function mat4RotX(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}
function mat4Translate(x: number, y: number, z: number): Float32Array {
  const o = new Float32Array(16);
  o[0] = o[5] = o[10] = o[15] = 1;
  o[12] = x; o[13] = y; o[14] = z;
  return o;
}

interface Gpu {
  device: GPUDevice;
  blit: PanelBlitPass;
  tex: GPUTexture;
  depth: GPUTexture;
  texW: number;
  texH: number;
  ubo: GPUBuffer;
  bindGroup: GPUBindGroup;
  bgPipe: GPURenderPipeline;
  bgUbo: GPUBuffer;
  bgBgl: GPUBindGroupLayout;
  bgBg: GPUBindGroup;
  cubePipe: GPURenderPipeline;
  cubeUbo: GPUBuffer;
  cubeBgl: GPUBindGroupLayout;
  cubeBg: GPUBindGroup;
  vbo: GPUBuffer;
  ibo: GPUBuffer;
  indexCount: number;
}

export interface GpuSlot {
  module: RendererModule;
  /** Called by the UI build once the panel exists. */
  attach(handle: UiPanelHandle, cfg: GpuSlotAttach): void;
  /** Re-query the slot/clip rects (scroll events, page switches, mutations). */
  refresh(): void;
  /** Pause/resume the animation (click on the surface toggles). */
  toggleSpin(): void;
  /** Instant hide/show — the overlay poll converges within a frame or two,
   *  but an opening modal can't wait: callers set this directly when a
   *  covering element appears. The occluder selector poll clears it. */
  setOccluded(on: boolean): void;
  readonly spinning: boolean;
}

export function createGpuSlot(): GpuSlot {
  let ctx: RendererModuleContext | null = null;
  let handle: UiPanelHandle | null = null;
  let cfg: GpuSlotAttach | null = null;
  let gpu: Gpu | null = null;

  let slotDoc: DocRect | null = null;
  let clipDoc: DocRect | null = null;
  let visible: ScreenRect | null = null;
  let srcUv: [number, number, number, number] | undefined;
  /** Occluder selector list (split from cfg.occluders' comma union) — each
   *  is rect-watched; any match's presence suppresses the blit. */
  let occSels: string[] = [];
  /** App-set suppression (instant, caller-managed) + doc-queried suppression
   *  (catches paths the app didn't instrument, converges in a tick or two). */
  let occludedApp = false;
  let occludedDoc = false;
  let dirty = true;
  let time = 0;
  let spinning = true;
  let firstRenderDone = false;

  // ── geometry: colored cube (pos + face normal + face tint, indexed) ──
  function buildCube() {
    const F = [
      { n: [0, 0, 1], c: [0.31, 0.76, 0.97] },  // front  — accent
      { n: [0, 0, -1], c: [0.16, 0.42, 0.60] }, // back
      { n: [1, 0, 0], c: [0.44, 0.75, 0.45] },  // right  — good
      { n: [-1, 0, 0], c: [0.94, 0.63, 0.29] }, // left   — warn
      { n: [0, 1, 0], c: [0.63, 0.55, 0.95] },  // top    — violet
      { n: [0, -1, 0], c: [0.90, 0.33, 0.30] }, // bottom — bad
    ];
    const s = 0.9;
    const verts: number[] = [];
    const idx: number[] = [];
    F.forEach((f, fi) => {
      const [nx, ny, nz] = f.n;
      // basis: t = tangent, b = bitangent so the face looks at n
      const ax = ny !== 0 || nz !== 0 ? [1, 0, 0] : [0, 1, 0];
      // t = ax × n … build face basis orthonormal-ish by hand:
      const t = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
      const b = [ny * t[2] - nz * t[1], nz * t[0] - nx * t[2], nx * t[1] - ny * t[0]];
      const base = fi * 4;
      ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).forEach(([u, v]) => {
        verts.push(
          nx * s + t[0] * u * s + b[0] * v * s,
          ny * s + t[1] * u * s + b[1] * v * s,
          nz * s + t[2] * u * s + b[2] * v * s,
          nx, ny, nz,
          f.c[0], f.c[1], f.c[2],
        );
      });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    return { verts: new Float32Array(verts), idx: new Uint16Array(idx) };
  }

  function ensureGpu(): Gpu | null {
    if (gpu) return gpu;
    if (!ctx) return null;
    const device = ctx.getDevice();
    if (!device) return null;
    const format = ctx.getFormat();

    const blit = new PanelBlitPass(device, format);
    const tex = device.createTexture({
      size: { width: TEX_W, height: TEX_H },
      format: "rgba8unorm",
      viewFormats: ["rgba8unorm-srgb"],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const depth = device.createTexture({
      size: { width: TEX_W, height: TEX_H },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const ubo = blit.createUbo();
    const bindGroup = blit.createBindGroup(tex, ubo);

    // Background gradient pass (no depth write, fullscreen triangle).
    const bgBgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });
    const bgShader = device.createShaderModule({ code: BG_WGSL, label: "gpu-slot-bg" });
    const bgPipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgBgl] }),
      vertex: { module: bgShader, entryPoint: "vs" },
      fragment: { module: bgShader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" },
    });
    const bgUbo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgBg = device.createBindGroup({ layout: bgBgl, entries: [{ binding: 0, resource: { buffer: bgUbo } }] });

    // Cube pass.
    const cubeBgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const cubeShader = device.createShaderModule({ code: CUBE_WGSL, label: "gpu-slot-cube" });
    const cubePipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cubeBgl] }),
      vertex: {
        module: cubeShader, entryPoint: "vs",
        buffers: [{
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: cubeShader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    const cubeUbo = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const cubeBg = device.createBindGroup({ layout: cubeBgl, entries: [{ binding: 0, resource: { buffer: cubeUbo } }] });

    const { verts, idx } = buildCube();
    const vbo = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbo, 0, verts);
    const ibo = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ibo, 0, idx);

    gpu = {
      device, blit, tex, depth, texW: TEX_W, texH: TEX_H, ubo, bindGroup,
      bgPipe, bgUbo, bgBgl, bgBg,
      cubePipe, cubeUbo, cubeBgl, cubeBg,
      vbo, ibo, indexCount: idx.length,
    };
    return gpu;
  }

  /** The blit maps the WHOLE texture onto the slot rect, so a texture
   *  whose aspect differs from the slot's stretches (the recurring wide-slot
   *  squash). Recreate tex/depth at the slot's aspect whenever it drifts —
   *  width stays TEX_W, height follows slotDoc.w/slotDoc.h. */
  function syncTexAspect(g: Gpu, aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    if (Math.abs(g.texW / g.texH - aspect) / aspect < 0.02) return;
    const w = TEX_W;
    const h = Math.max(32, Math.min(1024, Math.round(w / aspect)));
    g.tex.destroy();
    g.depth.destroy();
    g.tex = g.device.createTexture({
      size: { width: w, height: h },
      format: "rgba8unorm",
      viewFormats: ["rgba8unorm-srgb"],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    g.depth = g.device.createTexture({
      size: { width: w, height: h },
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    g.bindGroup = g.blit.createBindGroup(g.tex, g.ubo);
    g.texW = w; g.texH = h;
    firstRenderDone = false;
  }

  function renderScene(): void {
    const g = ensureGpu();
    if (!g) return;
    if (slotDoc) syncTexAspect(g, slotDoc.w / slotDoc.h);
    const aspect = g.texW / g.texH;
    const proj = mat4Perspective(Math.PI / 3.2, aspect, 0.1, 20);
    const view = mat4Translate(0, -0.15, -3.6);
    const model = mat4Mul(mat4RotY(time * 0.9), mat4RotX(0.45 + Math.sin(time * 0.4) * 0.2));
    const mvp = mat4Mul(proj, mat4Mul(view, model));
    const uni = new Float32Array(20);
    uni.set(mvp, 0);
    uni.set([0.5, 0.8, 1.0, 0], 16);
    g.device.queue.writeBuffer(g.cubeUbo, 0, uni);
    g.device.queue.writeBuffer(g.bgUbo, 0, new Float32Array([time, 0, 0, 0]));

    const enc = g.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: g.tex.createView(),
        clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
      depthStencilAttachment: {
        view: g.depth.createView(),
        depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
      },
    });
    pass.setPipeline(g.bgPipe);
    pass.setBindGroup(0, g.bgBg);
    pass.draw(3);
    pass.setPipeline(g.cubePipe);
    pass.setBindGroup(0, g.cubeBg);
    pass.setVertexBuffer(0, g.vbo);
    pass.setIndexBuffer(g.ibo, "uint16");
    pass.drawIndexed(g.indexCount);
    pass.end();
    g.device.queue.submit([enc.finish()]);
    firstRenderDone = true;
    dirty = true;
  }

  // ── rect tracking ──

  function recompute(): void {
    if (!handle || !cfg || !slotDoc || slotDoc.w <= 0 || slotDoc.h <= 0) {
      if (visible !== null) {
        // Stopping the blit must present a frame WITHOUT it — under
        // damageOnly nothing else clears the last-presented quad, which is
        // how the surface used to linger over hidden pages as a stale frame.
        visible = null; srcUv = undefined;
        dirty = true;
        ctx?.requestFrame();
        return;
      }
      visible = null; srcUv = undefined;
      return;
    }
    const z = cfg.zoom();
    const pr = handle.rect;
    const slot: ScreenRect = {
      x: pr.x + slotDoc.x * z, y: pr.y + slotDoc.y * z,
      w: slotDoc.w * z, h: slotDoc.h * z,
    };
    let clip: ScreenRect = { ...pr };
    if (clipDoc && clipDoc.w > 0 && clipDoc.h > 0) {
      clip = {
        x: Math.max(pr.x, pr.x + clipDoc.x * z),
        y: Math.max(pr.y, pr.y + clipDoc.y * z),
        w: clipDoc.w * z, h: clipDoc.h * z,
      };
      clip.w = Math.min(pr.x + pr.w, clip.x + clip.w) - clip.x;
      clip.h = Math.min(pr.y + pr.h, clip.y + clip.h) - clip.y;
    }
    const x0 = Math.max(slot.x, clip.x), y0 = Math.max(slot.y, clip.y);
    const x1 = Math.min(slot.x + slot.w, clip.x + clip.w);
    const y1 = Math.min(slot.y + slot.h, clip.y + clip.h);
    if (x1 - x0 <= 0.5 || y1 - y0 <= 0.5) {
      visible = null; srcUv = undefined;
      return;
    }
    const prev = visible;
    visible = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    srcUv = [
      (x0 - slot.x) / slot.w, (y0 - slot.y) / slot.h,
      (x1 - slot.x) / slot.w, (y1 - slot.y) / slot.h,
    ];
    if (!prev || Math.abs(prev.x - x0) > 0.5 || Math.abs(prev.y - y0) > 0.5
      || Math.abs(prev.w - visible.w) > 0.5 || Math.abs(prev.h - visible.h) > 0.5) {
      dirty = true;
    }
  }

  /** Read the watched rects — streamed by the backend with each emitted
   *  frame, so slotDoc/clipDoc describe the SAME doc state as the raster
   *  the panel is about to present. The old getRect poll (every 8th tick +
   *  a roundtrip) left the surface visibly trailing a smooth scroll. */
  function syncDoc(): void {
    if (!handle || !cfg) return;
    const s = handle.trackedRect(cfg.slot);
    const c = cfg.clip ? handle.trackedRect(cfg.clip) : null;
    if (JSON.stringify(s) !== JSON.stringify(slotDoc)
      || JSON.stringify(c) !== JSON.stringify(clipDoc)) {
      slotDoc = s; clipDoc = c;
      recompute();
    }
    const occ = occSels.some((sel) => handle!.trackedRect(sel) !== null);
    if (occ !== occludedDoc) { occludedDoc = occ; dirty = true; ctx?.requestFrame(); }
  }

  const self: GpuSlot = {
    get spinning() { return spinning; },
    module: {
      name: "gpu-slot",
      version: "1.0.0",
      register(c) {
        ctx = c;
        c.registerUiCompositor?.({
          order: 10, // above the Blitz panel composite (order 0)
          hasContent: () => visible !== null && firstRenderDone && !occludedApp && !occludedDoc,
          takeDirty: () => {
            const d = (spinning && visible !== null && !occludedApp && !occludedDoc) || dirty;
            dirty = false;
            return d;
          },
          render(pass, w, h) {
            const g = gpu;
            if (!g || !visible || occludedApp || occludedDoc) return;
            const panel: CompositePanel = {
              ubo: g.ubo, bindGroup: g.bindGroup,
              rect: { x: visible.x, y: visible.y, w: visible.w, h: visible.h },
              src: srcUv,
            };
            g.blit.render(pass, [panel], w, h);
          },
        });
        c.onFrame("afterFrame", (dt) => {
          if (spinning) time += dt;
          // Rects + occlusion sync every tick — synchronous trackedRect
          // reads, so a scrolling doc's surface follows within one frame.
          syncDoc();
          if (visible !== null && (spinning || !firstRenderDone)) renderScene();
        });
        c.onResize(() => { dirty = true; ctx?.requestFrame(); });
      },
    },
    attach(h, c) {
      handle = h; cfg = c;
      occSels = (c.occluders ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      h.watchRects([c.slot, ...(c.clip ? [c.clip] : []), ...occSels]);
      dirty = true;
      ctx?.requestFrame();
    },
    refresh() { dirty = true; ctx?.requestFrame(); },
    toggleSpin() {
      spinning = !spinning;
      dirty = true;
      if (handle && cfg) handle.setAttr(cfg.slot, "data-paused", spinning ? "false" : "true");
      ctx?.requestFrame();
    },
    setOccluded(on) { if (occludedApp !== on) { occludedApp = on; dirty = true; ctx?.requestFrame(); } },
  };
  return self;
}
