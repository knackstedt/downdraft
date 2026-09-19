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

  /**
   * Remove all registered passes. Imported/transient resources are preserved.
   * Used by renderers that rebuild the pass list each frame (e.g. when the
   * pass set is dynamic per-viewport).
   */
  clearPasses(): void {
    this.passes.length = 0;
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

    // Pool the previous compile's physical textures — resources whose specs
    // are unchanged get the same GPUTexture back instead of a destroy+alloc
    // cycle (pass-list churn would otherwise thrash VRAM on every recompile).
    const pool = this.physicalTextures;
    this.physicalTextures = [];
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

    // Allocate transient textures with lifetime-based aliasing, reusing
    // pooled textures from the previous compile where specs match.
    this.allocatePhysicalTextures(device, pool);

    // Pooled textures that no resource claimed are now garbage.
    for (const pt of pool) pt.texture.destroy();

    // Validate
    this.validate();

    this.compiled = true;
    this.dirty = false;
  }

  execute(ctx: RenderContext): GPUCommandBuffer | undefined {
    if (!this.compiled) return undefined;

    // Run passes sequentially on the shared encoder.
    for (let i = 0; i < this.executionOrder.length; i++) {
      const entry = this.executionOrder[i];
      if (entry.pass.passType === PassType.Render) {
        this.executeRenderPass(ctx, entry, i);
      } else {
        this.executeCustomPass(ctx, entry);
      }
    }

    return undefined; // caller submits the shared encoder
  }

  /** Reusable TrackedRenderPass wrappers — one per execution slot, avoiding
   *  an allocation per pass per frame. */
  private trackedPassPool: TrackedRenderPass[] = [];

  private executeRenderPass(ctx: RenderContext, entry: GraphPassEntry, slot: number): void {
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

    let tracked = this.trackedPassPool[slot];
    if (!tracked) {
      tracked = this.trackedPassPool[slot] = new TrackedRenderPass(renderPass);
    } else {
      tracked.resetForReuse(renderPass);
    }
    // Mutate the shared ctx rather than `{...ctx}` per pass — a fresh spread
    // per pass per frame was measurable GC churn (~N objects/frame).
    ctx.pass = tracked;

    pass.execute(ctx);
    tracked.end();
    ctx.pass = null;
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
    ctx.pass = null;
    pass.execute(ctx);
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

  private allocatePhysicalTextures(device: GPUDevice, pool: PhysicalTexture[]): void {
    this.physicalTextures = [];

    const transients: GraphResource[] = [];
    for (const resource of this.resources.values()) {
      if (!resource.external && resource.lifetime) {
        transients.push(resource);
      }
    }

    // Sort by first-use to allocate alias-compatible resources into physical textures.
    transients.sort((a, b) => (a.lifetime!.first - b.lifetime!.first));

    const specMatches = (pt: PhysicalTexture, w: number, h: number, desc: TextureDesc, sampleCount: number) =>
      pt.width === w &&
      pt.height === h &&
      pt.format === desc.format &&
      (pt.usage & desc.usage) === desc.usage &&
      pt.sampleCount === sampleCount;

    for (const resource of transients) {
      const w = resource.width || this.surfaceWidth;
      const h = resource.height || this.surfaceHeight;
      const desc = resource.desc!;
      const sampleCount = desc.sampleCount ?? 1;

      // Find a compatible physical texture whose lifetime has ended before this resource starts.
      // Usage compatibility: the physical texture's usage must be a superset of the
      // resource's required usage (i.e. it must support all flags the resource needs).
      let reused: PhysicalTexture | null = null;
      for (const pt of this.physicalTextures) {
        if (specMatches(pt, w, h, desc, sampleCount) && pt.lastUsed < resource.lifetime!.first) {
          reused = pt;
          break;
        }
      }
      // No intra-frame alias — try a pooled texture from the previous compile.
      if (!reused) {
        const pi = pool.findIndex((pt) => specMatches(pt, w, h, desc, sampleCount));
        if (pi >= 0) {
          reused = pool.splice(pi, 1)[0];
          this.physicalTextures.push(reused);
        }
      }

      if (reused) {
        resource.physicalTexture = reused.texture;
        resource.texture = reused.texture;
        // The texture may differ from the previous compile's — drop the stale view.
        resource.cachedView = undefined;
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
        resource.cachedView = undefined;
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
    // Build dependency edges per resource, tracking ALL accesses — not just
    // "last writer wins". For each read at registration index i of resource R:
    //   - RAW: depends on the last writer ≤ i (its data source); if no writer
    //     precedes i, it binds to the first writer > i — the pass that will
    //     produce the data it reads.
    //   - WAR: the reader must run before the next writer after its bound
    //     producer, so that writer doesn't clobber the data first.
    //   - WAW: consecutive writers keep registration order.
    // Collapsing writers to the last one (the old approach) could order a
    // sandwiched reader after the later writer (wrong data) or synthesize a
    // false dependency cycle that silently fell back to registration order.
    const n = this.passes.length;
    const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
    const addEdge = (from: number, to: number) => {
      if (from !== to) adj[from].add(to);
    };

    const writers = new Map<number, number[]>(); // resourceId -> writer indices (ascending)
    const readsOf = new Map<number, number[]>(); // resourceId -> reader indices (ascending)
    for (let i = 0; i < n; i++) {
      const { reads, writes } = this.passes[i].builder;
      for (const readId of reads) {
        let list = readsOf.get(readId);
        if (!list) readsOf.set(readId, (list = []));
        list.push(i);
      }
      for (const writeId of writes) {
        let list = writers.get(writeId);
        if (!list) writers.set(writeId, (list = []));
        list.push(i);
      }
    }

    // WAW edges between consecutive writers.
    for (const ws of writers.values()) {
      for (let k = 1; k < ws.length; k++) addEdge(ws[k - 1], ws[k]);
    }

    for (const [resId, readers] of readsOf) {
      const ws = writers.get(resId);
      if (!ws || ws.length === 0) continue; // no producer — validate() reports it
      for (const i of readers) {
        // Bound producer: last writer at-or-before i, else first writer after i.
        let bound = -1;
        for (const wIdx of ws) { if (wIdx <= i) bound = wIdx; else break; }
        const boundPos = bound === -1 ? 0 : ws.indexOf(bound);
        const producer = bound === -1 ? ws[0] : bound;
        addEdge(producer, i); // RAW
        // WAR: next writer after the bound producer must wait for this reader.
        const next = ws[boundPos + 1];
        if (next !== undefined) addEdge(i, next);
      }
    }

    const inDegree = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (const to of adj[i]) inDegree[to]++;
    }

    // Kahn's algorithm, preserving registration order for ties. The queue is
    // kept sorted by binary insertion instead of re-sorting every iteration
    // (the old sort+shift loop was O(n²·log n) per compile).
    const queue: number[] = [];
    const pushSorted = (v: number) => {
      let lo = 0, hi = queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (queue[mid] < v) lo = mid + 1; else hi = mid;
      }
      queue.splice(lo, 0, v);
    };
    for (let i = 0; i < n; i++) {
      if (inDegree[i] === 0) pushSorted(i);
    }

    const result: number[] = [];
    while (queue.length > 0) {
      const idx = queue.shift()!;
      result.push(idx);
      for (const neighbor of adj[idx]) {
        if (--inDegree[neighbor] === 0) pushSorted(neighbor);
      }
    }

    if (result.length !== n) {
      log.error("FrameGraph", "Cycle detected in render graph, falling back to registration order");
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
