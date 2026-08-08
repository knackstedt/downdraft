// ============================================================================
// FrameGraph — RDG-style render pass orchestration
// Topologically-sorted passes, transient resource allocation, lifetime-based
// aliasing, single command encoder per frame.
// ============================================================================

import type { DebugDrawQueue } from "../debug-draw/queue";
import { createLogger } from "../util/logger";
import type { CameraState } from "./camera";
import type { RenderPass } from "./render-pass";
import { TrackedRenderPass } from "./tracked-render-pass";

const log = createLogger();

// ─── Handles & Descriptors ─────────────────────────────────────────────────

export class TextureHandle {
  readonly id: number;
  readonly name: string;
  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }
}

export interface TextureDesc {
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
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

// ─── Pass Type ─────────────────────────────────────────────────────────────

export enum PassType {
  /** Graph begins/ends the render pass with declared attachments; ctx.pass is a TrackedRenderPass. */
  Render = "render",
  /** Pass manages its own encoders; ctx.pass is null. */
  Custom = "custom",
}

// ─── Render Context ────────────────────────────────────────────────────────

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderContext {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  pass: TrackedRenderPass | null;
  camera: CameraState;
  viewport: ViewportRect;
  viewportIdx: number;
  viewportCount: number;
  dt: number;
  elapsedTime: number;
  isFirstViewport: boolean;
  isLastViewport: boolean;
  getView: (handle: TextureHandle) => GPUTextureView;
  getTexture: (handle: TextureHandle) => GPUTexture;

  // Back-compat FrameContext fields (optional; populated by FrameGraph-based systems)
  width: number;
  height: number;
  viewProj: any;
  invViewProj: any;
  prevViewProj: any;
  cameraPos: [number, number, number];
  lightData: any;
  lightViewProj: any;
  mesh: any;
  modelMatrix: any;
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

// Back-compat re-exports of previous names.
// TODO: remove after full pass migration.
export type GraphRenderContext = RenderContext;
export type FrameContext = RenderContext;

// ─── Builder (used during setup phase) ─────────────────────────────────────

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

// ─── Internal types ────────────────────────────────────────────────────────

interface GraphResource {
  name: string;
  texture: GPUTexture | null;
  externalView?: GPUTextureView | null;
  external: boolean;
  desc?: TextureDesc;
  width?: number;
  height?: number;
  cachedView?: GPUTextureView;
  physicalTexture?: GPUTexture; // aliased physical backing (null if unaliased)
  lifetime?: { first: number; last: number };
}

interface GraphPassEntry {
  pass: RenderPass;
  builder: FrameGraphBuilder;
  slot?: string;
}

interface PhysicalTexture {
  texture: GPUTexture;
  name: string;
  width: number;
  height: number;
  format: GPUTextureFormat;
  usage: GPUTextureUsageFlags;
  sampleCount: number;
  lastUsed: number; // index in execution order
}

// ─── Slot Registry ─────────────────────────────────────────────────────────

export type RenderPassSlot = string;

export interface PassSlotEntry {
  slot: RenderPassSlot;
  pass: RenderPass;
  order: number;
}

export class SlotRegistry {
  private slotOrder: string[] = [];
  private slotIndex: Record<string, number> = {};
  private entries: PassSlotEntry[] = [];

  setSlotOrder(slots: string[]): void {
    this.slotOrder = [...slots];
    this.slotIndex = {};
    this.slotOrder.forEach((s, i) => { this.slotIndex[s] = i; });
  }

  registerPass(slot: RenderPassSlot, pass: RenderPass): void {
    this.entries.push({ slot, pass, order: this.slotIndex[slot] ?? this.slotOrder.length });
  }

  unregisterPass(name: string): void {
    this.entries = this.entries.filter(e => e.pass.name !== name);
  }

  clear(): void {
    this.entries = [];
  }

  getEntries(): readonly PassSlotEntry[] {
    return this.entries
      .filter(e => this.slotOrder.includes(e.slot))
      .sort((a, b) => {
        const oa = a.order;
        const ob = b.order;
        if (oa !== ob) return oa - ob;
        return 0;
      });
  }

  isEmpty(): boolean {
    return this.getEntries().length === 0;
  }
}

// ─── Frame Graph ───────────────────────────────────────────────────────────

export class FrameGraph {
  private passes: GraphPassEntry[] = [];
  private resources: Map<number, GraphResource> = new Map();
  private nextHandleId = 0;
  private compiled = false;
  private executionOrder: GraphPassEntry[] = [];
  private dirty = true;
  private surfaceWidth = 0;
  private surfaceHeight = 0;
  private physicalTextures: PhysicalTexture[] = [];
  private aliasing: Map<string, string> = new Map(); // resource name -> physical texture name
  private slotRegistry = new SlotRegistry();

  importTexture(name: string, texture?: GPUTexture | null): TextureHandle {
    const handle = new TextureHandle(this.nextHandleId++, name);
    this.resources.set(handle.id, {
      name,
      texture: texture ?? null,
      external: true,
    });
    return handle;
  }

  /** Update the GPUTexture backing an imported handle (e.g. swapchain color). */
  setImportedTexture(handle: TextureHandle, texture: GPUTexture): void {
    const resource = this.resources.get(handle.id);
    if (!resource || !resource.external) {
      throw new Error(`FrameGraph: "${handle.name}" is not an imported texture`);
    }
    resource.texture = texture;
    resource.externalView = undefined;
    resource.cachedView = undefined;
  }

  /** Import an externally-created view directly (e.g. XR offscreen color view). */
  importTextureView(name: string, view: GPUTextureView | null): TextureHandle {
    const handle = new TextureHandle(this.nextHandleId++, name);
    this.resources.set(handle.id, {
      name,
      texture: null,
      externalView: view,
      external: true,
    });
    return handle;
  }

  /** Update the GPUTextureView backing an imported view handle. */
  setImportedTextureView(handle: TextureHandle, view: GPUTextureView): void {
    const resource = this.resources.get(handle.id);
    if (!resource || !resource.external) {
      throw new Error(`FrameGraph: "${handle.name}" is not an imported view`);
    }
    resource.externalView = view;
    resource.cachedView = undefined;
  }

  createTransient(name: string, desc: TextureDesc): TextureHandle {
    const handle = new TextureHandle(this.nextHandleId++, name);
    this.resources.set(handle.id, {
      name,
      texture: null,
      external: false,
      desc,
      width: desc.width,
      height: desc.height,
    });
    return handle;
  }

  /** Direct graph registration. Use SlotRegistry for slot-based ordering. */
  addPass(pass: RenderPass): void {
    const builder = new FrameGraphBuilder();
    pass.setup(builder);
    this.passes.push({ pass, builder });
    this.dirty = true;
  }

  getSlotRegistry(): SlotRegistry {
    return this.slotRegistry;
  }

  /** Re-register all passes from the slot registry. Call after slot/pass changes. */
  refreshFromSlots(): void {
    this.passes = [];
    for (const { slot, pass } of this.slotRegistry.getEntries()) {
      const builder = new FrameGraphBuilder();
      pass.setup(builder);
      this.passes.push({ pass, builder, slot });
    }
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  compile(device: GPUDevice, surfaceWidth: number, surfaceHeight: number): void {
    if (this.passes.length === 0) {
      this.compiled = true;
      this.dirty = false;
      return;
    }

    this.surfaceWidth = surfaceWidth;
    this.surfaceHeight = surfaceHeight;

    this.destroyPhysicalTextures();
    this.aliasing.clear();

    // Resolve sizes for all transient resources.
    for (const resource of this.resources.values()) {
      if (!resource.external && resource.desc) {
        resource.width = resource.width || surfaceWidth;
        resource.height = resource.height || surfaceHeight;
      }
    }

    // Topological sort (this also sets execution order).
    this.executionOrder = this.topologicalSort();

    // Compute resource lifetimes over the sorted execution order.
    this.computeLifetimes();

    // Allocate transient textures with lifetime-based aliasing.
    this.allocatePhysicalTextures(device);

    // Validate
    this.validate();

    this.compiled = true;
    this.dirty = false;
  }

  execute(ctx: RenderContext): GPUCommandBuffer | undefined {
    if (!this.compiled) return undefined;

    // Run passes sequentially on the shared encoder.
    for (const entry of this.executionOrder) {
      if (entry.pass.passType === PassType.Render) {
        this.executeRenderPass(ctx, entry);
      } else {
        this.executeCustomPass(ctx, entry);
      }
    }

    return undefined; // caller submits the shared encoder
  }

  private executeRenderPass(ctx: RenderContext, entry: GraphPassEntry): void {
    const { pass, builder } = entry;

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

    const renderPass = ctx.encoder.beginRenderPass({
      colorAttachments,
      depthStencilAttachment: depthAttachment,
    });

    const tracked = new TrackedRenderPass(renderPass);
    const passCtx: RenderContext = { ...ctx, pass: tracked };

    pass.execute(passCtx);
    tracked.end();
    // Caller (GameRenderer) aggregates draw call stats from the tracked pass.
    (ctx as any).lastPassStats = {
      name: pass.name,
      drawCalls: tracked.drawCalls,
      triangles: tracked.triangles,
      pipelineSwitches: tracked.pipelineSwitches,
      bindGroupChanges: tracked.bindGroupChanges,
      bufferRebinds: tracked.bufferRebinds,
    };
  }

  private executeCustomPass(ctx: RenderContext, entry: GraphPassEntry): void {
    const { pass } = entry;
    const passCtx: RenderContext = { ...ctx, pass: null };
    pass.execute(passCtx);
  }

  getTextureView(handle: TextureHandle): GPUTextureView {
    const resource = this.resources.get(handle.id);
    if (!resource) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    if (resource.externalView) {
      return resource.externalView;
    }
    if (!resource.texture) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    if (!resource.cachedView) {
      resource.cachedView = resource.texture.createView();
    }
    return resource.cachedView;
  }

  getTexture(handle: TextureHandle): GPUTexture {
    const resource = this.resources.get(handle.id);
    if (!resource || !resource.texture) {
      throw new Error(`FrameGraph: unresolved texture "${handle.name}"`);
    }
    return resource.texture;
  }

  getPassOrder(): string[] {
    return this.executionOrder.map(e => e.pass.name);
  }

  getAliasing(): Map<string, string> {
    return new Map(this.aliasing);
  }

  private computeLifetimes(): void {
    // Initialize lifetimes with invalid indices.
    for (const resource of this.resources.values()) {
      if (resource.external || !resource.desc) continue;
      resource.lifetime = { first: Infinity, last: -1 };
    }

    for (let i = 0; i < this.executionOrder.length; i++) {
      const { builder } = this.executionOrder[i];
      const all = new Set([...builder.reads, ...builder.writes]);
      for (const id of all) {
        const resource = this.resources.get(id);
        if (!resource || resource.external || !resource.lifetime) continue;
        resource.lifetime.first = Math.min(resource.lifetime.first, i);
        resource.lifetime.last = Math.max(resource.lifetime.last, i);
      }
    }

    // Unused transients have no lifetime.
    for (const resource of this.resources.values()) {
      if (resource.lifetime && resource.lifetime.last === -1) {
        resource.lifetime = undefined;
      }
    }
  }

  private allocatePhysicalTextures(device: GPUDevice): void {
    this.physicalTextures = [];

    const transients: GraphResource[] = [];
    for (const resource of this.resources.values()) {
      if (!resource.external && resource.lifetime) {
        transients.push(resource);
      }
    }

    // Sort by first-use to allocate alias-compatible resources into physical textures.
    transients.sort((a, b) => (a.lifetime!.first - b.lifetime!.first));

    for (const resource of transients) {
      const w = resource.width || this.surfaceWidth;
      const h = resource.height || this.surfaceHeight;
      const desc = resource.desc!;
      const sampleCount = desc.sampleCount ?? 1;

      // Find a compatible physical texture whose lifetime has ended before this resource starts.
      let reused: PhysicalTexture | null = null;
      for (const pt of this.physicalTextures) {
        const compatible =
          pt.width === w &&
          pt.height === h &&
          pt.format === desc.format &&
          pt.usage === desc.usage &&
          pt.sampleCount === sampleCount &&
          pt.lastUsed < resource.lifetime!.first;
        if (compatible) {
          reused = pt;
          break;
        }
      }

      if (reused) {
        resource.physicalTexture = reused.texture;
        resource.texture = reused.texture;
        this.aliasing.set(resource.name, reused.name);
        reused.lastUsed = resource.lifetime!.last;
      } else {
        const name = `${resource.name}_phys`;
        const texture = device.createTexture({
          size: [w, h],
          format: desc.format,
          usage: desc.usage,
          sampleCount,
        });
        this.physicalTextures.push({
          texture,
          name,
          width: w,
          height: h,
          format: desc.format,
          usage: desc.usage,
          sampleCount,
          lastUsed: resource.lifetime!.last,
        });
        resource.physicalTexture = texture;
        resource.texture = texture;
        this.aliasing.set(resource.name, name);
      }
    }
  }

  private destroyPhysicalTextures(): void {
    for (const pt of this.physicalTextures) {
      pt.texture.destroy();
    }
    this.physicalTextures = [];
  }

  private topologicalSort(): GraphPassEntry[] {
    // First pass: collect all producers for each resource.
    const producers = new Map<number, number>();
    for (let i = 0; i < this.passes.length; i++) {
      for (const writeId of this.passes[i].builder.writes) {
        // Last writer wins for ordering purposes.
        producers.set(writeId, i);
      }
    }

    // Second pass: build adjacency from reads -> producer.
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

    // Kahn's algorithm, preserving registration/slot order for ties.
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

  destroy(): void {
    this.destroyPhysicalTextures();
    for (const resource of this.resources.values()) {
      if (resource.external && resource.texture) {
        // External textures are owned by the caller; just drop references.
        resource.texture = null;
      }
      resource.cachedView = undefined;
    }
    this.resources.clear();
    this.passes = [];
    this.executionOrder = [];
    this.compiled = false;
    this.dirty = true;
    this.aliasing.clear();
  }
}
