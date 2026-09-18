// ============================================================================
// GraphComputePass — frame-graph-integrated compute dispatch from a ComputeGraph
// Extends RenderPass with PassType.Custom (manages its own beginComputePass/end
// on the shared encoder, like GpuCullPass). Supports both auto-allocated buffers
// (from StorageBufferDecl/UniformBufferDecl) and externally-provided buffers
// for interop with existing systems.
// ============================================================================

import {
    ComputeGraphCompiler,
    type ComputeGraph,
    type ComputeProfile
} from "@downdraft/shader-graph";
import type { RenderContext } from "../frame-graph";
import { PassType } from "../frame-graph";
import type { FrameGraphBuilder } from "../render-pass";
import { RenderPass } from "../render-pass";
import { createValidatedShaderModule } from "../shader-validator";

/** Default allocation size for runtime-sized storage buffers (1 MB). */
const DEFAULT_RUNTIME_BUFFER_SIZE = 1 << 20;

/** GPUShaderStage.COMPUTE = 0x4. Defined locally to avoid runtime WebGPU dependency in tests. */
const SHADER_STAGE_COMPUTE = 0x4;

/** GPUBufferUsage flags. Defined locally for testability. */
const BUFFER_USAGE = {
  UNIFORM: 0x40,
  STORAGE: 0x80,
  COPY_DST: 0x8,
  COPY_SRC: 0x4,
} as const;

export interface GraphComputeBuffer {
  name: string;
  buffer: GPUBuffer;
}

export class GraphComputePass extends RenderPass {
  readonly name: string;
  passType: PassType = PassType.Custom;

  private graph: ComputeGraph;
  private profile: ComputeProfile | undefined;
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private shaderModule: GPUShaderModule | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  // Buffer management — both modes
  private ownedBuffers: Map<string, GPUBuffer> = new Map();
  private externalBuffers: Map<string, GPUBuffer> = new Map();
  private pendingUniformData: Map<string, ArrayBufferView> = new Map();

  constructor(name: string, graph: ComputeGraph, profile?: ComputeProfile) {
    super();
    this.name = name;
    this.graph = graph;
    this.profile = profile;
  }

  prepare(device: GPUDevice): void {
    this.device = device;
    this.recompile();
    this.allocateOwnedBuffers();
    this.createBindGroup();
  }

  /** Recompile the graph → new shader module → new pipeline. Supports hot-reload. */
  recompile(): void {
    if (!this.device) return;

    const compiler = new ComputeGraphCompiler();
    const result = compiler.compileDetailed(this.graph, { profile: this.profile });
    if (result.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[GraphComputePass:${this.name}] Compilation errors:`, result.errors);
    }

    this.shaderModule = createValidatedShaderModule(this.device, {
      label: this.name,
      code: result.wgsl,
    });

    this.bindGroupLayout = this.buildBindGroupLayout();
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      label: this.name,
      layout: pipelineLayout,
      compute: { module: this.shaderModule, entryPoint: this.graph.getEntryPoint() },
    });
  }

  setup(builder: FrameGraphBuilder): void {
    void builder;
    // Compute passes operate on buffers, not textures. The frame graph's
    // resource tracking is texture-only, so we don't declare reads/writes here.
    // Ordering is handled via slot registration (same approach as GpuCullPass).
  }

  execute(ctx: RenderContext): void {
    if (!this.pipeline || !this.bindGroup || !this.device) return;

    // Flush pending uniform data
    for (const [name, data] of this.pendingUniformData) {
      const buf = this.getBuffer(name);
      if (buf) {
        ctx.device.queue.writeBuffer(buf, 0, data as unknown as BufferSource);
      }
    }
    this.pendingUniformData.clear();

    // Rebuild bind group if external buffers changed
    this.createBindGroup();

    const pass = ctx.encoder.beginComputePass({ label: this.name });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);

    const dispatch = this.graph.getDispatchConfig().dispatchCount;
    if (dispatch !== "runtime") {
      pass.dispatchWorkgroups(dispatch[0], dispatch[1], dispatch[2]);
    }
    // "runtime" dispatch requires an indirect buffer — caller handles via
    // dispatchWorkgroupsIndirect before calling execute, or we extend the API.

    pass.end();
  }

  // ── Buffer management API ────────────────────────────────────────────────

  /** Provide an externally-owned buffer (skips auto-allocation for this name). */
  setExternalBuffer(name: string, buffer: GPUBuffer): void {
    this.externalBuffers.set(name, buffer);
  }

  /** Get a buffer by name (owned or external). */
  getBuffer(name: string): GPUBuffer | null {
    return this.externalBuffers.get(name) ?? this.ownedBuffers.get(name) ?? null;
  }

  /** Queue uniform data to be written before the next dispatch. */
  writeUniform(name: string, data: ArrayBufferView): void {
    this.pendingUniformData.set(name, data);
  }

  /** Immediately write storage buffer data via the device queue. */
  writeStorage(name: string, data: ArrayBufferView): void {
    if (!this.device) return;
    const buf = this.getBuffer(name);
    if (buf) {
      this.device.queue.writeBuffer(buf, 0, data as unknown as BufferSource);
    }
  }

  /** Get all owned buffers (for interop with other passes). */
  getOwnedBuffers(): GraphComputeBuffer[] {
    return [...this.ownedBuffers.entries()].map(([name, buffer]) => ({ name, buffer }));
  }

  destroy(): void {
    for (const buf of this.ownedBuffers.values()) {
      buf.destroy();
    }
    this.ownedBuffers.clear();
    this.externalBuffers.clear();
    this.pendingUniformData.clear();
    this.shaderModule = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.device = null;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private buildBindGroupLayout(): GPUBindGroupLayout {
    if (!this.device) throw new Error("Device not initialized");

    const entries: GPUBindGroupLayoutEntry[] = [];
    const maxBinding = new Map<number, number>();

    for (const sb of this.graph.getStorageBuffers()) {
      const access: "read-only" | "read-write" =
        sb.access === "read" ? "read-only" : "read-write";
      entries.push({
        binding: sb.binding,
        visibility: SHADER_STAGE_COMPUTE,
        buffer: { type: access === "read-write" ? "storage" : "read-only-storage" },
      });
      maxBinding.set(sb.group, Math.max(maxBinding.get(sb.group) ?? 0, sb.binding));
    }

    for (const ub of this.graph.getUniformBuffers()) {
      entries.push({
        binding: ub.binding,
        visibility: SHADER_STAGE_COMPUTE,
        buffer: { type: "uniform" },
      });
      maxBinding.set(ub.group, Math.max(maxBinding.get(ub.group) ?? 0, ub.binding));
    }

    return this.device.createBindGroupLayout({ entries });
  }

  private allocateOwnedBuffers(): void {
    if (!this.device) return;

    for (const sb of this.graph.getStorageBuffers()) {
      if (this.externalBuffers.has(sb.name)) continue;

      const structSize = this.computeStructSize(sb.structFields);
      const elementCount = sb.elementCount ?? Math.floor(
        (sb.defaultSize ?? DEFAULT_RUNTIME_BUFFER_SIZE) / Math.max(structSize, 4),
      );
      const size = Math.max(structSize * elementCount, 16);

      const buffer = this.device.createBuffer({
        label: `${this.name}:${sb.name}`,
        size,
        usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST | BUFFER_USAGE.COPY_SRC,
      });
      this.ownedBuffers.set(sb.name, buffer);
    }

    for (const ub of this.graph.getUniformBuffers()) {
      if (this.externalBuffers.has(ub.name)) continue;

      const structSize = this.computeStructSize(ub.structFields);
      const size = Math.max(structSize, 16);

      const buffer = this.device.createBuffer({
        label: `${this.name}:${ub.name}`,
        size,
        usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
      });
      this.ownedBuffers.set(ub.name, buffer);
    }
  }

  private createBindGroup(): void {
    if (!this.device || !this.bindGroupLayout) return;

    const entries: GPUBindGroupEntry[] = [];
    let hasAllBuffers = true;

    for (const sb of this.graph.getStorageBuffers()) {
      const buf = this.getBuffer(sb.name);
      if (!buf) {
        hasAllBuffers = false;
        break;
      }
      entries.push({ binding: sb.binding, resource: { buffer: buf } });
    }

    if (hasAllBuffers) {
      for (const ub of this.graph.getUniformBuffers()) {
        const buf = this.getBuffer(ub.name);
        if (!buf) {
          hasAllBuffers = false;
          break;
        }
        entries.push({ binding: ub.binding, resource: { buffer: buf } });
      }
    }

    if (hasAllBuffers) {
      this.bindGroup = this.device.createBindGroup({
        label: `${this.name}:bindgroup`,
        layout: this.bindGroupLayout,
        entries,
      });
    }
  }

  private computeStructSize(fields: { name: string; type: string }[]): number {
    let size = 0;
    for (const f of fields) {
      size += this.wgslTypeSize(f.type);
    }
    // Round up to 16-byte alignment (WGSL uniform buffer min alignment)
    return Math.ceil(size / 16) * 16;
  }

  private wgslTypeSize(type: string): number {
    if (type.startsWith("vec2")) return 8;
    if (type.startsWith("vec3")) return 12;
    if (type.startsWith("vec4")) return 16;
    if (type.startsWith("mat4x4")) return 64;
    if (type.startsWith("mat3x3")) return 48;
    if (type === "f32" || type === "u32" || type === "i32") return 4;
    return 4; // default to scalar
  }
}
