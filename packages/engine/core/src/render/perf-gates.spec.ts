// ============================================================================
// perf-gates.spec.ts — deterministic performance invariants
//
// Wall-clock thresholds flake on shared CI runners under software rendering,
// so these gates assert work-count invariants that encode the renderer's perf
// contract: one queue.submit per frame regardless of how many passes submit
// internally, surface/depth resources acquired once per frame (not per
// viewport), and zero pipeline creation in steady state.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { PassType } from "./frame-graph";
import { GameRenderer } from "./game-renderer";
import { pipelinePool } from "./pipeline-pool";
import { RenderPass } from "./render-pass";

// Full flag values — passes read these while preparing/recording.
const _g = globalThis as unknown as Record<string, unknown>;
_g.GPUTextureUsage = {
  COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10,
};
_g.GPUBufferUsage = {
  MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10,
  VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
};
_g.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

function createMockCanvas(): HTMLCanvasElement {
  return { width: 800, height: 600 } as unknown as HTMLCanvasElement;
}

interface CountingDevice {
  device: GPUDevice;
  counts: { submit: number; createTexture: number; createRenderPipeline: number; acquire: number };
}

/** Mock device that counts the calls these gates care about. */
function mockDevice(): CountingDevice {
  const counts = { submit: 0, createTexture: 0, createRenderPipeline: 0, acquire: 0 };
  const device = {
    queue: {
      submit: () => { counts.submit++; },
      writeBuffer() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createCommandEncoder: () => ({ finish: () => ({}), beginRenderPass: () => ({ end() {} }) }),
    createShaderModule: () => ({}),
    createRenderPipeline: () => { counts.createRenderPipeline++; return { getBindGroupLayout: () => ({}) }; },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({ destroy() {} }),
    createTexture: () => { counts.createTexture++; return { createView: () => ({}), destroy() {} }; },
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    limits: {},
    features: new Set(),
  } as unknown as GPUDevice;
  return { device, counts };
}

/** Wire a renderer for renderOnce() without a real device/context. */
function install(renderer: GameRenderer, cd: CountingDevice): void {
  const r = renderer as unknown as Record<string, unknown>;
  r.device = cd.device;
  r.context = {
    getCurrentTexture: () => { cd.counts.acquire++; return { createView: () => ({}) }; },
    present() {},
  };
  r.gpuProfiler = {
    beginFrame() {},
    resolveGpuTimers() {},
    readGpuTimers: () => Promise.resolve(),
    hasUncapturedError: () => false,
    getPassTimings: () => [],
  };
  renderer.setCallbacks({
    onViewport: () => ({
      camera: {
        position: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0],
        fov: 60, near: 0.1, far: 100, aspect: 1,
      },
      viewport: { x: 0, y: 0, w: 400, h: 600 },
    }),
  });
  (renderer as any).installQueueSubmitInterceptor(cd.device);
}

class NoopPass extends RenderPass {
  override passType = PassType.Custom;
  constructor(name: string, viewDependent = true) {
    super();
    this.name = name;
    this.viewDependent = viewDependent;
  }
  setup(): void {}
  prepare(): void {}
  execute(): void {}
}

describe("performance gates", () => {
  it("flushes exactly one queue.submit per frame — mid-frame pass submits join the batch", () => {
    const cd = mockDevice();
    const renderer = new GameRenderer(createMockCanvas());
    renderer.setViewportCount(2);
    install(renderer, cd);

    // A pass that submits its own command buffer mid-frame — the interceptor
    // must capture it into the frame batch, not hit the real queue.
    const submitter = new NoopPass("submitter");
    submitter.execute = () => {
      cd.device.queue.submit([{} as GPUCommandBuffer]);
    };
    (renderer as any).frameGraph.addPass(submitter);

    renderer.renderOnce();
    expect(cd.counts.submit).toBe(1);

    renderer.renderOnce();
    expect(cd.counts.submit).toBe(2);
  });

  it("creates no new textures on repeat frames — depth targets are LRU-cached", () => {
    const cd = mockDevice();
    const renderer = new GameRenderer(createMockCanvas());
    renderer.setViewportCount(3);
    install(renderer, cd);
    (renderer as any).frameGraph.addPass(new NoopPass("p"));

    renderer.renderOnce();
    const afterFrame1 = cd.counts.createTexture;
    // Distinct viewport sizes legitimately get distinct depth targets — the
    // gate is that the count is small and bounded, not per-viewport-per-frame.
    expect(afterFrame1).toBeLessThanOrEqual(3);

    // Second and third frames: every depth entry is an LRU cache hit.
    renderer.renderOnce();
    renderer.renderOnce();
    expect(cd.counts.createTexture).toBe(afterFrame1);
  });

  it("creates zero pipelines on steady-state frames — pool memoizes per device", () => {
    const cd = mockDevice();
    const renderer = new GameRenderer(createMockCanvas());
    renderer.setViewportCount(1);
    install(renderer, cd);

    class PooledPass extends NoopPass {
      pipeline: GPURenderPipeline | null = null;
      override execute(): void {
        this.pipeline ??= pipelinePool(cd.device).acquireRender(
          "perf-gates-pipe", () => ({ label: "perf-gates" }) as GPURenderPipelineDescriptor,
        );
      }
    }
    const pass = new PooledPass("pooled");
    (renderer as any).frameGraph.addPass(pass);

    renderer.renderOnce();
    const warmup = cd.counts.createRenderPipeline;
    expect(warmup).toBe(1);
    expect(pass.pipeline).not.toBeNull();

    renderer.renderOnce();
    renderer.renderOnce();
    expect(cd.counts.createRenderPipeline).toBe(warmup);
  });

  it("acquires the surface texture once per frame regardless of viewport count", () => {
    const cd = mockDevice();
    const renderer = new GameRenderer(createMockCanvas());
    renderer.setViewportCount(4);
    install(renderer, cd);
    (renderer as any).frameGraph.addPass(new NoopPass("p", false));

    renderer.renderOnce();
    expect(cd.counts.acquire).toBe(1);

    renderer.renderOnce();
    expect(cd.counts.acquire).toBe(2);
  });
});
