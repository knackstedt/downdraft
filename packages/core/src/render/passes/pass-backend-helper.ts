import type { RenderBackend } from "../backend/render-backend.ts";
import type {
  BackendBindGroup,
  BackendBindGroupLayout,
  BackendBuffer,
  BackendCommandEncoder,
  BackendRenderPassEncoder,
  BackendRenderPipeline,
  BackendSampler,
  BackendShaderModule,
  BackendTextureView,
  BindGroupLayoutDescriptor,
  RenderPassDescriptor,
  ShaderStageFlags,
} from "../backend/types.ts";
import { SHADER_STAGE_VERTEX, SHADER_STAGE_FRAGMENT } from "../backend/types.ts";
import { wgslShader } from "../backend/shader-source.ts";
import type { GraphRenderContext } from "../frame-graph.ts";

/**
 * Helper for creating backend-agnostic resources for fullscreen post-process passes.
 * Each pass creates a PassBackendResources instance in prepareBackend() and uses it in execute().
 */
export class PassBackendResources {
  constructor(private backend: RenderBackend) {}

  createShaderModule(wgslCode: string, label?: string): BackendShaderModule {
    return this.backend.createShaderModule(wgslShader(wgslCode, label), "wgsl");
  }

  createSampler(descriptor: {
    magFilter?: "linear" | "nearest";
    minFilter?: "linear" | "nearest";
    mipmapFilter?: "linear" | "nearest";
    addressModeU?: "clamp-to-edge" | "repeat" | "mirror-repeat";
    addressModeV?: "clamp-to-edge" | "repeat" | "mirror-repeat";
    addressModeW?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  }): BackendSampler {
    return this.backend.createSampler(descriptor);
  }

  createUniformBuffer(size: number, label?: string): BackendBuffer {
    return this.backend.createBuffer({
      label,
      size,
      usage: 0x40 | 0x08, // UNIFORM | COPY_DST
    });
  }

  createFullscreenPipeline(
    vsCode: string,
    fsCode: string,
    fsEntryPoint: string,
    targets: { format: string }[],
    bindGroupLayout?: BackendBindGroupLayout,
  ): BackendRenderPipeline {
    const vsModule = this.createShaderModule(vsCode, "fullscreen-vs");
    const fsModule = this.createShaderModule(fsCode, "fullscreen-fs");

    const layout = bindGroupLayout
      ? this.backend.createPipelineLayout({ label: "fullscreen-layout", bindGroupLayouts: [bindGroupLayout] })
      : "auto" as const;

    return this.backend.createRenderPipeline({
      label: "fullscreen-pipeline",
      layout,
      vertex: { module: vsModule, entryPoint: "vs_main" },
      fragment: { module: fsModule, entryPoint: fsEntryPoint, targets },
      primitive: { topology: "triangle-list" },
    });
  }

  createBindGroup(
    layout: BackendBindGroupLayout,
    entries: { binding: number; resource: { buffer: BackendBuffer; offset?: number; size?: number } | { sampler: BackendSampler } | { textureView: BackendTextureView } }[],
  ): BackendBindGroup {
    return this.backend.createBindGroup({ layout, entries });
  }

  createBindGroupLayout(entries: BindGroupLayoutDescriptor["entries"]): BackendBindGroupLayout {
    return this.backend.createBindGroupLayout({ entries });
  }

  get queue() {
    return this.backend.queue;
  }

  get backend() {
    return this.backend;
  }
}

/**
 * Create a uniform+texture bind group layout for a fullscreen pass.
 * Pattern: [uniformBuffer, textureViews..., sampler]
 */
export function createFullscreenBindGroupLayout(
  backend: RenderBackend,
  textureCount: number,
  textureViewDimension: "2d" | "3d" = "2d",
): BackendBindGroupLayout {
  const entries: BindGroupLayoutDescriptor["entries"] = [
    { binding: 0, visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT as ShaderStageFlags, buffer: { type: "uniform" } },
  ];
  for (let i = 0; i < textureCount; i++) {
    entries.push({
      binding: i + 1,
      visibility: SHADER_STAGE_FRAGMENT as ShaderStageFlags,
      texture: { sampleType: "float", viewDimension: textureViewDimension },
    });
  }
  entries.push({
    binding: textureCount + 1,
    visibility: SHADER_STAGE_FRAGMENT as ShaderStageFlags,
    sampler: { type: "filtering" },
  });
  return backend.createBindGroupLayout({ entries });
}

/**
 * Execute a fullscreen post-process pass using the backend-agnostic path.
 */
export function executeFullscreenPass(
  ctx: GraphRenderContext,
  outputView: BackendTextureView,
  pipeline: BackendRenderPipeline,
  bindGroup: BackendBindGroup,
  vertexCount = 6,
): void {
  const backend = ctx.backend;
  if (!backend) throw new Error("executeFullscreenPass requires ctx.backend");

  const encoder = backend.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: outputView,
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear" as const,
      storeOp: "store" as const,
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(vertexCount);
  pass.end();
  backend.queue.submit([encoder.finish()]);
}
