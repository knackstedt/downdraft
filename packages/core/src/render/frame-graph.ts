import type { Mat4 } from "wgpu-matrix";
import type { DebugDrawQueue } from "../debug-draw/queue.ts";
import type { MeshData } from "../mesh/builder.ts";
import { createLogger } from "../util/logger.ts";
import type { RenderBackend } from "./backend/render-backend.ts";
import type { BackendTexture, BackendTextureView, TextureFormat } from "./backend/types.ts";
import type { LightUniformData } from "./lighting.ts";
import type { RenderPass } from "./render-pass.ts";
import { TrackedRenderPass } from "./tracked-render-pass.ts";

const log = createLogger();

// ─── Handles & Descriptors ──────────────────────────────────────────────

export class TextureHandle {
  readonly id: number;
  readonly name: string;
  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }
}

export interface TextureDesc {
  format: GPUTextureFormat | TextureFormat;
  usage: GPUTextureUsageFlags | number;
  sampleCount?: number;
  width?: number;  // 0 or undefined = surface width
  height?: number; // 0 or undefined = surface height
}

export interface ColorAttachmentDesc {
  handle: TextureHandle;
  loadOp: GPULoadOp;
  storeOp: GPUStoreOp;
  clearValue?: GPUColor;
}

export interface DepthAttachmentDesc {
  handle: TextureHandle;
  depthLoadOp: GPULoadOp;
  depthStoreOp: GPUStoreOp;
  depthClearValue?: number;
  depthReadOnly?: boolean;
}

// ─── Pass Type ───────────────────────────────────────────────────────────

export enum PassType {
  /** Graph creates encoder + render pass with declared attachments. ctx.pass is a TrackedRenderPass. */
  Render = "render",
  /** Pass creates its own encoders internally. ctx.pass is null. */
  Custom = "custom",
}

// ─── Frame Context ───────────────────────────────────────────────────────

export interface FrameContext {
  /** Backend-agnostic render backend (always available when using backend path). */
  backend: RenderBackend | null;
  /** Native WebGPU device. Only available when using WebGPU backend. */
  device: GPUDevice | null;
  width: number;
  height: number;
  viewProj: Mat4;
  invViewProj: Mat4;
  prevViewProj: Mat4;
  cameraPos: [number, number, number];
  lightData: LightUniformData;
  lightViewProj: Mat4;
  mesh: MeshData;
  modelMatrix: Mat4;
  shadowsEnabled: boolean;
  bloomEnabled: boolean;
  shadowSampler: GPUSampler | null;
  debugQueue: DebugDrawQueue | null;
  opaqueVertexBuffer: GPUBuffer | null;
  opaqueIndexBuffer: GPUBuffer | null;
  opaqueIndexCount: number;
  opaqueIndexFormat: GPUIndexFormat;
  addDrawCalls: (n: number) => void;
  addTriangles: (n: number) => void;
}

export interface GraphRenderContext extends FrameContext {
  /** TrackedRenderPass for Render-type passes. null for Custom passes. */
  pass: TrackedRenderPass | null;
  /** Resolve a texture handle to a GPUTextureView (native WebGPU). */
  getView: (handle: TextureHandle) => GPUTextureView;
  /** Resolve a texture handle to a GPUTexture (native WebGPU). */
  getTexture: (handle: TextureHandle) => GPUTexture;
  /** Resolve a texture handle to a backend-agnostic BackendTextureView. */
  getBackendView: (handle: TextureHandle) => BackendTextureView;
  /** Resolve a texture handle to a backend-agnostic BackendTexture. */
  getBackendTexture: (handle: TextureHandle) => BackendTexture;
}

// ─── Builder (used during setup phase) ───────────────────────────────────

export class FrameGraphBuilder {
  colorAttachments: ColorAttachmentDesc[] = [];
  depthAttachmentDesc: DepthAttachmentDesc | null = null;
  private _reads: Set<number> = new Set();
  private _writes: Set<number> = new Set();

  colorAttachment(desc: ColorAttachmentDesc): void {
    this.colorAttachments.push(desc);
    this._writes.add(desc.handle.id);
  }

  depthAttachment(desc: DepthAttachmentDesc): void {
    this.depthAttachmentDesc = desc;
    if (desc.depthReadOnly) {
      this._reads.add(desc.handle.id);
    } else {
      this._writes.add(desc.handle.id);
    }
  }

  read(handle: TextureHandle): void {
    this._reads.add(handle.id);
  }

  write(handle: TextureHandle): void {
    this._writes.add(handle.id);
  }

  get reads(): Set<number> { return this._reads; }
  get writes(): Set<number> { return this._writes; }
}

// ─── Internal types ──────────────────────────────────────────────────────

interface GraphResource {
  name: string;
  texture: GPUTexture | null;
  backendTexture: BackendTexture | null;
  external: boolean;
  desc?: TextureDesc;
  width?: number;
  height?: number;
  cachedView?: GPUTextureView;
  cachedBackendView?: BackendTextureView;
}

interface GraphPassEntry {
  pass: RenderPass;
  builder: FrameGraphBuilder;
}

// ─── Frame Graph ─────────────────────────────────────────────────────────

export class FrameGraph {
  private passes: GraphPassEntry[] = [];
  private resources: Map<number, GraphResource> = new Map();
  private nextHandleId = 0;
  private compiled = false;
  private executionOrder: GraphPassEntry[] = [];
  private _compileBackend: RenderBackend | null = null;

  importTexture(name: string, texture: GPUTexture | BackendTexture): TextureHandle {
    const handle = new TextureHandle(this.nextHandleId++, name);
    const isBackend = texture && typeof (texture as BackendTexture).getNative === 'function' && !(texture as unknown as GPUTexture).createView;
    this.resources.set(handle.id, {
      name,
      texture: isBackend ? null : texture as GPUTexture,
      backendTexture: isBackend ? texture as BackendTexture : null,
      external: true,
    });
    return handle;
  }

  createTransient(name: string, desc: TextureDesc): TextureHandle {
    const handle = new TextureHandle(this.nextHandleId++, name);
    this.resources.set(handle.id, {
      name,
      texture: null,
      backendTexture: null,
      external: false,
      desc,
      width: desc.width,
      height: desc.height,
    });
    return handle;
  }

  addPass(pass: RenderPass): void {
    const builder = new FrameGraphBuilder();
    pass.setup(builder);
    this.passes.push({ pass, builder });
  }

  /**
   * Compile the frame graph, allocating transient textures.
   * @param device Native WebGPU device (used when available)
   * @param surfaceWidth Surface width for transient sizing
   * @param surfaceHeight Surface height for transient sizing
   * @param backend Optional RenderBackend for backend-agnostic texture allocation
   */
  compile(device: GPUDevice | null, surfaceWidth: number, surfaceHeight: number, backend?: RenderBackend | null): void {
    this._compileBackend = backend ?? null;
    // Allocate transient textures
    for (const resource of this.resources.values()) {
      if (!resource.external && !resource.texture && !resource.backendTexture && resource.desc) {
        const w = resource.width || surfaceWidth;
        const h = resource.height || surfaceHeight;
        if (backend) {
          resource.backendTexture = backend.createTexture({
            label: resource.name,
            size: [w, h],
            format: resource.desc.format as TextureFormat,
            usage: resource.desc.usage as number,
            sampleCount: resource.desc.sampleCount ?? 1,
          });
        } else if (device) {
          resource.texture = device.createTexture({
            size: [w, h],
            format: resource.desc.format as GPUTextureFormat,
            usage: resource.desc.usage as GPUTextureUsageFlags,
            sampleCount: resource.desc.sampleCount ?? 1,
          });
        }
      }
    }

    // Topological sort
    this.executionOrder = this.topologicalSort();

    // Validate
    this.validate();

    this.compiled = true;
  }

  execute(frameCtx: FrameContext): void {
    if (!this.compiled) return;

    for (const entry of this.executionOrder) {
      const { pass, builder } = entry;

      if (pass.passType === PassType.Render) {
        this.executeRenderPass(frameCtx, entry);
      } else {
        this.executeCustomPass(frameCtx, entry);
      }
    }
  }

  private executeRenderPass(frameCtx: FrameContext, entry: GraphPassEntry): void {
    const { pass, builder } = entry;
    const device = frameCtx.device;
    if (!device) {
      // Backend-only path not yet supported for Render-type passes
      // (requires backend TrackedRenderPass wrapper)
      this.executeCustomPass(frameCtx, entry);
      return;
    }
    const encoder = device.createCommandEncoder();

    const colorAttachments: GPURenderPassColorAttachment[] = builder.colorAttachments.map(a => ({
      view: this.getTextureView(a.handle),
      loadOp: a.loadOp,
      storeOp: a.storeOp,
      clearValue: a.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
    }));

    let depthAttachment: GPURenderPassDepthStencilAttachment | undefined;
    if (builder.depthAttachmentDesc) {
      const da = builder.depthAttachmentDesc;
      depthAttachment = {
        view: this.getTextureView(da.handle),
        depthLoadOp: da.depthLoadOp,
        depthStoreOp: da.depthStoreOp,
        depthClearValue: da.depthClearValue ?? 1.0,
        depthReadOnly: da.depthReadOnly ?? false,
      };
    }

    const renderPass = encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: depthAttachment,
    });

    const tracked = new TrackedRenderPass(renderPass);

    const ctx: GraphRenderContext = {
      ...frameCtx,
      pass: tracked,
      getView: (h: TextureHandle) => this.getTextureView(h),
      getTexture: (h: TextureHandle) => this.getTexture(h),
      getBackendView: (h: TextureHandle) => this.getBackendTextureView(h),
      getBackendTexture: (h: TextureHandle) => this.getBackendTexture(h),
    };

    pass.execute(ctx);
    tracked.end();
    frameCtx.addDrawCalls(tracked.drawCalls);
    frameCtx.addTriangles(tracked.triangles);
    (frameCtx as any).lastPassStats = {
      name: pass.name,
      drawCalls: tracked.drawCalls,
      triangles: tracked.triangles,
      pipelineSwitches: tracked.pipelineSwitches,
      bindGroupChanges: tracked.bindGroupChanges,
      bufferRebinds: tracked.bufferRebinds,
    };
    device.queue.submit([encoder.finish()]);
  }

  private executeCustomPass(frameCtx: FrameContext, entry: GraphPassEntry): void {
    const { pass } = entry;
    const ctx: GraphRenderContext = {
      ...frameCtx,
      pass: null,
      getView: (h: TextureHandle) => this.getTextureView(h),
      getTexture: (h: TextureHandle) => this.getTexture(h),
      getBackendView: (h: TextureHandle) => this.getBackendTextureView(h),
      getBackendTexture: (h: TextureHandle) => this.getBackendTexture(h),
    };
    pass.execute(ctx);
  }

  private getTextureView(handle: TextureHandle): GPUTextureView {
    const resource = this.resources.get(handle.id);
    if (!resource || !resource.texture) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    if (!resource.cachedView) {
      resource.cachedView = resource.texture.createView();
    }
    return resource.cachedView;
  }

  private getTexture(handle: TextureHandle): GPUTexture {
    const resource = this.resources.get(handle.id);
    if (!resource || !resource.texture) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    return resource.texture;
  }

  private getBackendTextureView(handle: TextureHandle): BackendTextureView {
    const resource = this.resources.get(handle.id);
    if (!resource) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    if (!resource.cachedBackendView) {
      if (resource.backendTexture) {
        // Use the backend to create a view
        // We need a backend reference — stored on the resource during compile
        if (this._compileBackend) {
          resource.cachedBackendView = this._compileBackend.createTextureView(resource.backendTexture);
        } else {
          throw new Error(`FrameGraph: no backend available to create view for "${handle.name}"`);
        }
      } else if (resource.texture) {
        // Wrap native GPUTextureView as backend view (for WebGPU path)
        if (!resource.cachedView) {
          resource.cachedView = resource.texture.createView();
        }
        // Return a wrapper — but we don't have a BackendTextureView wrapper here
        // This path is used when the graph is compiled with a native device
        // The backend view is the native view cast
        resource.cachedBackendView = resource.cachedView as unknown as BackendTextureView;
      } else {
        throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
      }
    }
    return resource.cachedBackendView;
  }

  private getBackendTexture(handle: TextureHandle): BackendTexture {
    const resource = this.resources.get(handle.id);
    if (!resource) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    if (resource.backendTexture) {
      return resource.backendTexture;
    }
    if (resource.texture) {
      return resource.texture as unknown as BackendTexture;
    }
    throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
  }

  private topologicalSort(): GraphPassEntry[] {
    // First pass: collect all producers for each resource
    const producers = new Map<number, number>();
    for (let i = 0; i < this.passes.length; i++) {
      for (const writeId of this.passes[i].builder.writes) {
        producers.set(writeId, i);
      }
    }

    // Second pass: build adjacency from reads → producer
    const adj: number[][] = Array.from({ length: this.passes.length }, () => []);
    const inDegree = new Array(this.passes.length).fill(0);

    for (let i = 0; i < this.passes.length; i++) {
      const { builder } = this.passes[i];
      for (const readId of builder.reads) {
        const producerIdx = producers.get(readId);
        if (producerIdx !== undefined && producerIdx !== i) {
          adj[producerIdx].push(i);
          inDegree[i]++;
        }
      }
    }

    // Kahn's algorithm, preserving registration order for ties
    const queue: number[] = [];
    for (let i = 0; i < this.passes.length; i++) {
      if (inDegree[i] === 0) queue.push(i);
    }

    const result: number[] = [];
    while (queue.length > 0) {
      queue.sort((a, b) => a - b);
      const idx = queue.shift()!;
      result.push(idx);
      for (const neighbor of adj[idx]) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) queue.push(neighbor);
      }
    }

    if (result.length !== this.passes.length) {
      log.warn("FrameGraph", "Cycle detected in render graph, falling back to registration order");
      return this.passes;
    }

    return result.map(i => this.passes[i]);
  }

  private validate(): void {
    const produced = new Set<number>();
    const errors: string[] = [];

    for (const entry of this.executionOrder) {
      for (const readId of entry.builder.reads) {
        if (!produced.has(readId) && !this.resources.get(readId)?.external) {
          errors.push(`Pass "${entry.pass.name}" reads "${this.resources.get(readId)?.name ?? readId}" before it is produced`);
        }
      }
      for (const writeId of entry.builder.writes) {
        produced.add(writeId);
      }
    }

    if (errors.length > 0) {
      log.warn("FrameGraph", `Validation errors:\n${errors.join("\n")}`);
    }
  }

  getPassOrder(): string[] {
    return this.executionOrder.map(e => e.pass.name);
  }

  destroy(): void {
    for (const resource of this.resources.values()) {
      if (!resource.external && resource.texture) {
        resource.texture.destroy();
        resource.texture = null;
        resource.cachedView = undefined;
      }
      if (!resource.external && resource.backendTexture && this._compileBackend) {
        // Backend textures are destroyed via backend.destroy() which handles all tracked resources
        // Individual texture destruction is backend-specific
        resource.backendTexture = null;
        resource.cachedBackendView = undefined;
      }
    }
    this.compiled = false;
  }
}
