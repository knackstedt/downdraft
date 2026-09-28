// ============================================================================
// splash-screen.ts — boot splash for the native window
//
// Between `createNativeHost()` (window + surface configured) and the game's
// first real frame sits module evaluation + renderer init — several seconds
// under the dev shell's ModuleRunner. During that time the swapchain has
// never presented, so the window shows uninitialized/black content and reads
// as hung.
//
// The splash is a tiny self-contained WGSL pass (fullscreen triangle with a
// procedural spinner — no fonts, no assets) driven by the window's own rAF
// pump. It stops the moment ANY other rAF callback registers — that is the
// earliest reliable signal that the game's render loop is starting — or after
// a 60s safety timeout for event-driven games that never rAF.
//
// GPU objects are (re)built against `ctx.getDevice()` per frame: a renderer
// that creates its own device (GameRenderer.init) reconfigures the surface,
// and drawing with stale-device resources would panic on cross-device use.
// ============================================================================

import type { WgpuDevice } from "../gpu/wgpu-wrapper";
import type { NativeSurface } from "./native-surface";
import type { NativeWindow } from "./native-window";

const SPLASH_WGSL = /* wgsl */ `
struct Uniforms {
  res: vec2f,
  time: f32,
  pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  // Centered, aspect-corrected UVs in units of the shorter edge.
  let uv = (fc.xy - 0.5 * u.res) / min(u.res.x, u.res.y);
  let d = length(uv);
  let ang = atan2(uv.y, uv.x);

  // Spinner: a thin ring whose brightness sweeps around once per ~1.5s,
  // easing toward the head of the arc.
  let ring = 1.0 - smoothstep(0.0, 0.006, abs(d - 0.14));
  let sweep = fract((ang - u.time * 4.2) / 6.2831853);
  let ringAlpha = ring * (0.06 + 0.94 * pow(1.0 - sweep, 3.0));

  // Faint breathing dot at the center so a frozen frame is distinguishable
  // from a static one even if the arc lands at a dim angle.
  let pulse = 0.5 + 0.5 * sin(u.time * 2.4);
  let dot_ = (1.0 - smoothstep(0.028, 0.034, d)) * (0.25 + 0.35 * pulse);

  let bg = vec3f(0.047, 0.055, 0.071);
  let accent = vec3f(0.35, 0.68, 0.9);
  let a = clamp(ringAlpha + dot_, 0.0, 1.0);
  return vec4f(mix(bg, accent, a), 1.0);
}
`;

/** Hard cap on splash lifetime — a game that never registers a rAF callback
 *  (event-driven renderer, headless harness) would otherwise spin forever. */
const SPLASH_TIMEOUT_MS = 60_000;

export class SplashScreen {
  /** Stable callback identity — NativeWindow compares against this to detect
   *  the first external rAF registration (see requestAnimationFrame). */
  readonly tick: (time: number) => void;

  private running = false;
  private rafId = -1;
  private readonly deadline = performance.now() + SPLASH_TIMEOUT_MS;
  private readonly t0 = performance.now();

  // GPU objects keyed to the surface's *current* device — rebuilt on change.
  private device: WgpuDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniforms: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  constructor(
    private readonly window: NativeWindow,
    private readonly surface: NativeSurface,
  ) {
    this.tick = () => this.onTick();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.rafId = this.window.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.window.cancelAnimationFrame(this.rafId);
    this.rafId = -1;
  }

  get isRunning(): boolean { return this.running; }

  private initGpu(device: WgpuDevice): void {
    const ctx = this.surface.getContext("webgpu")!;
    const shader = device.createShaderModule({ code: SPLASH_WGSL, label: "dd-splash" }) as unknown as GPUShaderModule;
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: ctx.getFormat() ?? "bgra8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    }) as unknown as GPURenderPipeline;
    this.uniforms = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }) as unknown as GPUBuffer;
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    }) as unknown as GPUBindGroup;
    this.device = device;
  }

  private onTick(): void {
    if (!this.running) return;
    // Reschedule first so a draw failure still animates (and an external rAF
    // registration — which stops the splash — lands before the next frame).
    this.rafId = this.window.requestAnimationFrame(this.tick);
    if (performance.now() > this.deadline) { this.stop(); return; }

    const ctx = this.surface.getContext("webgpu");
    const device = ctx?.getDevice();
    if (!ctx || !device) return; // surface not configured / mid-reconfigure
    try {
      if (device !== this.device || !this.pipeline || !this.uniforms || !this.bindGroup) {
        this.initGpu(device);
      }
      const time = (performance.now() - this.t0) / 1000;
      device.queue.writeBuffer(
        this.uniforms! as any, 0,
        new Float32Array([this.surface.width, this.surface.height, time, 0]) as any,
      );
      const tex = ctx.getCurrentTexture();
      if (!tex) return; // occluded/minimized — keep ticking
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: (tex as any).createView(),
          clearValue: { r: 0.047, g: 0.055, b: 0.071, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      (pass as any).setPipeline(this.pipeline);
      (pass as any).setBindGroup(0, this.bindGroup);
      (pass as any).draw(3);
      (pass as any).end();
      device.queue.submit([(encoder as any).finish()]);
      // The window's end-of-frame auto-present (queueMicrotask after the rAF
      // dispatch) presents the texture the pass marked __ddWritten.
    } catch {
      // Transient failures (surface reconfigure mid-init, device swap) must
      // not kill the splash — retry next frame.
    }
  }
}
