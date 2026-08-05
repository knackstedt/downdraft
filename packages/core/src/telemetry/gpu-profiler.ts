// ============================================================================
// GPUProfiler — consolidated GPU debugging: pass timing, error capture,
// GPU info/limits snapshot, and tracked render pass wrapping.
// ============================================================================

import type { PassTiming } from "./collector";
import { GPUTimerPool } from "./gpu-timer-pool";

// ─── Frame Graph Visualizer Data ──────────────────────────────────────────

export interface FrameGraphNode {
  id: string;
  name: string;
  category: "scene" | "postprocess" | "pixelation" | "ui";
  layer: number;
  cpuMs: number;
  gpuMs: number;
  drawCalls: number;
  triangles: number;
  pipelineSwitches: number;
  bindGroupChanges: number;
  bufferRebinds: number;
  active: boolean;
}

export interface FrameGraphEdge {
  from: string;
  to: string;
  resource: string;
  type: "color" | "depth" | "chain";
}

export interface FrameGraphValidation {
  level: "warning" | "info";
  message: string;
  passName?: string;
}

export interface FrameGraphData {
  nodes: FrameGraphNode[];
  edges: FrameGraphEdge[];
  validations: FrameGraphValidation[];
  totalGpuMs: number;
  totalCpuMs: number;
  totalDrawCalls: number;
  totalTriangles: number;
  timestamp: number;
}

export interface PostProcessInfo {
  pixelationEnabled: boolean;
  pixelSize: number;
  postProcessEffects: string[];
}

// ─── End Frame Graph Types ─────────────────────────────────────────────────

export interface GPUErrors {
  timestamp: number;
  message: string;
  label?: string;
}

export interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface GPUInfo {
  adapter: GPUAdapterInfo | null;
  deviceLost: boolean;
  canvasFormat: GPUTextureFormat | null;
  msaaSampleCount: number;
  canvasSize: { width: number; height: number };
  deviceLimits: Record<string, number> | null;
}

export interface PassTrackerStats {
  pipelineSwitches: number;
  bindGroupChanges: number;
  bufferRebinds: number;
  drawCalls: number;
  triangles: number;
}

interface PassTimingEntry {
  cpuMs: number;
  gpuMs: number;
  drawCalls: number;
  triangles: number;
  pipelineSwitches: number;
  bindGroupChanges: number;
  bufferRebinds: number;
}

export class GPUProfiler {
  private passTimings: Map<string, PassTimingEntry> = new Map();
  private passStartTimes: Map<string, number> = new Map();
  private passGpuIndices: Map<string, number> = new Map();
  private gpuPassCounter: number = 0;
  private gpuTimerPool: GPUTimerPool | null = null;
  private passTracker: PassTrackerStats = {
    pipelineSwitches: 0,
    bindGroupChanges: 0,
    bufferRebinds: 0,
    drawCalls: 0,
    triangles: 0,
  };

  private adapterInfo: any = null;
  private gpuErrors: GPUErrors[] = [];
  private deviceLost: boolean = false;
  private canvasFormat: GPUTextureFormat | null = null;

  private device: GPUDevice | null = null;

  // Error throttling — uncaptured GPU errors fire per-frame when something is
  // wrong, which floods the console. We log the first occurrence immediately,
  // suppress duplicates within a throttle window, then emit a summary.
  private static readonly ERROR_THROTTLE_MS = 1000;
  private static readonly ERROR_LOG_CAP = 100;
  private errorThrottle: Map<string, { count: number; firstSeen: number; lastLogged: number; suppressed: number }> = new Map();

  // Once an uncaptured error fires, subsequent GPU operations on the same
  // invalid resources produce a cascade of native validation warnings every
  // frame. This flag lets the render loop skip GPU work until recovery.
  private uncapturedErrorFired = false;

  init(device: GPUDevice, adapterInfo: any, canvasFormat: GPUTextureFormat, maxPasses: number = 16): void {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.canvasFormat = canvasFormat;
    this.gpuTimerPool = new GPUTimerPool(device, maxPasses);

    const self = this;
    device.onuncapturederror = function (ev: GPUUncapturedErrorEvent) {
      const label = (ev.error as any)?.label ?? "";
      const message = ev.error.message;
      const entry: GPUErrors = {
        timestamp: performance.now(),
        message,
        label: label || undefined,
      };
      self.gpuErrors.push(entry);
      if (self.gpuErrors.length > GPUProfiler.ERROR_LOG_CAP) self.gpuErrors.shift();
      self.uncapturedErrorFired = true;

      const key = `${label}\u0000${message}`;
      const now = performance.now();
      const state = self.errorThrottle.get(key);
      if (!state) {
        // First occurrence — log immediately and start a throttle window.
        self.errorThrottle.set(key, { count: 1, firstSeen: now, lastLogged: now, suppressed: 0 });
        console.error(`[GPU] ${label || ""} WebGPU uncaptured error: ${message}`);
        return;
      }
      state.count++;
      const elapsed = now - state.lastLogged;
      if (elapsed < GPUProfiler.ERROR_THROTTLE_MS) {
        // Within the throttle window — suppress.
        state.suppressed++;
        return;
      }
      // Window elapsed — emit a summary of suppressed duplicates and reset.
      const suppressed = state.suppressed + 1; // +1 for this occurrence
      console.error(
        `[GPU] ${label || ""} WebGPU uncaptured error: ${message} ` +
          `(repeated ${suppressed}× in ${Math.round(elapsed)}ms)`,
      );
      state.lastLogged = now;
      state.suppressed = 0;
    };

    device.lost.then((info: any) => {
      self.deviceLost = true;
      console.error(`[GPU] WebGPU device lost: ${info?.reason ?? "unknown"} — ${info?.message ?? ""}`);
    });
  }

  getGPUTimerPool(): GPUTimerPool | null {
    return this.gpuTimerPool;
  }

  isGpuTimerSupported(): boolean {
    return this.gpuTimerPool?.isSupported() ?? false;
  }

  /** True after an uncaptured GPU error — the render loop should skip GPU work
   *  to avoid per-frame validation warning cascades. Stays true until cleared. */
  hasUncapturedError(): boolean {
    return this.uncapturedErrorFired;
  }

  /** Clear the uncaptured-error flag (e.g. after recreating resources). */
  clearUncapturedError(): void {
    this.uncapturedErrorFired = false;
  }

  // --- Pass timing ---

  beginFrame(): void {
    this.passStartTimes.clear();
    this.passTimings.clear();
    this.passGpuIndices.clear();
    this.gpuPassCounter = 0;
  }

  beginPass(name: string, passEncoder: GPURenderPassEncoder, viewportIdx: number): void {
    if (viewportIdx !== 0) return;
    this.passStartTimes.set(name, performance.now());
    this.passTracker.pipelineSwitches = 0;
    this.passTracker.bindGroupChanges = 0;
    this.passTracker.bufferRebinds = 0;
    this.passTracker.drawCalls = 0;
    this.passTracker.triangles = 0;
    if (!this.gpuTimerPool || !this.gpuTimerPool.isSupported()) return;
    const maxPasses = this.gpuTimerPool.getMaxPasses();
    const idx = this.gpuPassCounter++;
    if (idx >= maxPasses) return;
    this.passGpuIndices.set(name, idx);
    this.gpuTimerPool.begin(passEncoder, idx);
  }

  endPass(name: string, passEncoder: GPURenderPassEncoder, viewportIdx: number, drawCalls: number = 0, triangles: number = 0): void {
    if (viewportIdx !== 0) return;
    // End GPU timer
    if (this.gpuTimerPool && this.gpuTimerPool.isSupported()) {
      const idx = this.passGpuIndices.get(name);
      if (idx !== undefined && idx < this.gpuTimerPool.getMaxPasses()) {
        this.gpuTimerPool.end(passEncoder, idx);
      }
    }
    // Record timing
    const start = this.passStartTimes.get(name);
    if (start === undefined) return;
    const cpuMs = performance.now() - start;
    const existing = this.passTimings.get(name);
    const gpuIdx = this.passGpuIndices.get(name);
    const gpuMs = (gpuIdx !== undefined && this.gpuTimerPool) ? this.gpuTimerPool.getPassGpuMs(gpuIdx) : 0;
    this.passTimings.set(name, {
      cpuMs,
      gpuMs,
      drawCalls: this.passTracker.drawCalls || drawCalls || existing?.drawCalls || 0,
      triangles: this.passTracker.triangles || triangles || existing?.triangles || 0,
      pipelineSwitches: this.passTracker.pipelineSwitches,
      bindGroupChanges: this.passTracker.bindGroupChanges,
      bufferRebinds: this.passTracker.bufferRebinds,
    });
  }

  resolveGpuTimers(encoder: GPUCommandEncoder): void {
    if (this.gpuTimerPool && this.gpuTimerPool.isSupported()) {
      this.gpuTimerPool.resolve(encoder);
    }
  }

  readGpuTimers(): Promise<Map<number, number>> {
    if (this.gpuTimerPool && this.gpuTimerPool.isSupported()) {
      return this.gpuTimerPool.readAll();
    }
    return Promise.resolve(new Map());
  }

  getPassTimings(): PassTiming[] {
    const result: PassTiming[] = [];
    for (const [name, t] of this.passTimings) {
      result.push({
        name,
        cpuMs: t.cpuMs,
        gpuMs: t.gpuMs,
        drawCalls: t.drawCalls,
        triangles: t.triangles,
        pipelineSwitches: t.pipelineSwitches,
        bindGroupChanges: t.bindGroupChanges,
        bufferRebinds: t.bufferRebinds,
      });
    }
    return result;
  }

  // --- Tracked render pass ---

  wrapTrackedPass(pass: GPURenderPassEncoder): GPURenderPassEncoder {
    const tracker = this.passTracker;
    return new Proxy(pass, {
      get(target, prop) {
        if (prop === "setPipeline") {
          return (pipeline: GPURenderPipeline) => {
            tracker.pipelineSwitches++;
            target.setPipeline(pipeline);
          };
        }
        if (prop === "setBindGroup") {
          return (index: number, group: GPUBindGroup, dynamicOffsets?: number[] | Uint32Array) => {
            tracker.bindGroupChanges++;
            target.setBindGroup(index, group, dynamicOffsets ?? []);
          };
        }
        if (prop === "setVertexBuffer") {
          return (slot: number, buffer: GPUBuffer, offset: number = 0, size?: number) => {
            tracker.bufferRebinds++;
            target.setVertexBuffer(slot, buffer, offset, size);
          };
        }
        if (prop === "setIndexBuffer") {
          return (buffer: GPUBuffer, format: GPUIndexFormat, offset: number = 0, size?: number) => {
            tracker.bufferRebinds++;
            target.setIndexBuffer(buffer, format, offset, size);
          };
        }
        if (prop === "draw") {
          return (vertexCount: number, instanceCount: number = 1, firstVertex: number = 0, firstInstance: number = 0) => {
            tracker.drawCalls++;
            tracker.triangles += Math.floor(vertexCount / 3) * instanceCount;
            target.draw(vertexCount, instanceCount, firstVertex, firstInstance);
          };
        }
        if (prop === "drawIndexed") {
          return (indexCount: number, instanceCount: number = 1, firstIndex: number = 0, baseVertex: number = 0, firstInstance: number = 0) => {
            tracker.drawCalls++;
            tracker.triangles += Math.floor(indexCount / 3) * instanceCount;
            target.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
          };
        }
        const value = Reflect.get(target, prop);
        if (typeof value === "function") return value.bind(target);
        return value;
      },
    }) as unknown as GPURenderPassEncoder;
  }

  // --- GPU errors ---

  getGPUErrors(): GPUErrors[] {
    return this.gpuErrors;
  }

  clearGPUErrors(): void {
    this.gpuErrors = [];
  }

  isDeviceLost(): boolean {
    return this.deviceLost;
  }

  // --- GPU info / limits ---

  getGPUInfo(canvas: HTMLCanvasElement, msaaSampleCount: number): GPUInfo {
    const a = this.adapterInfo;
    const adapter = a ? {
      vendor: a.vendor ?? "",
      architecture: a.architecture ?? "",
      device: a.device ?? "",
      description: a.description ?? "",
    } : null;

    const limits = this.device?.limits;
    const deviceLimits = limits ? {
      maxTextureDimension1D: limits.maxTextureDimension1D,
      maxTextureDimension2D: limits.maxTextureDimension2D,
      maxTextureDimension3D: limits.maxTextureDimension3D,
      maxTextureArrayLayers: limits.maxTextureArrayLayers,
      maxBindGroups: limits.maxBindGroups,
      maxBindGroupsPerShaderStage: (limits as any).maxBindGroupsPerShaderStage,
      maxBindingsPerBindGroup: (limits as any).maxBindingsPerBindGroup,
      maxBufferSize: limits.maxBufferSize,
      maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
      maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
      maxDynamicUniformBuffersPerPipelineLayout: limits.maxDynamicUniformBuffersPerPipelineLayout,
      maxDynamicStorageBuffersPerPipelineLayout: limits.maxDynamicStorageBuffersPerPipelineLayout,
      maxSampledTexturesPerShaderStage: limits.maxSampledTexturesPerShaderStage,
      maxSamplersPerShaderStage: limits.maxSamplersPerShaderStage,
      maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
      maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage,
      maxUniformBuffersPerShaderStage: limits.maxUniformBuffersPerShaderStage,
      maxVertexAttributes: limits.maxVertexAttributes,
      maxVertexBuffers: limits.maxVertexBuffers,
      maxVertexBufferArrayStride: limits.maxVertexBufferArrayStride,
      minUniformBufferOffsetAlignment: limits.minUniformBufferOffsetAlignment,
      minStorageBufferOffsetAlignment: limits.minStorageBufferOffsetAlignment,
      maxColorAttachments: limits.maxColorAttachments,
      maxColorAttachmentBytesPerSample: limits.maxColorAttachmentBytesPerSample,
      maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY: limits.maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ: limits.maxComputeWorkgroupSizeZ,
      maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
    } : null;

    return {
      adapter,
      deviceLost: this.deviceLost,
      canvasFormat: this.canvasFormat,
      msaaSampleCount,
      canvasSize: { width: canvas.width, height: canvas.height },
      deviceLimits,
    };
  }

  getAdapterInfo(): any {
    return this.adapterInfo;
  }

  // --- Frame Graph Builder ---

  static buildFrameGraphData(
    passTimings: PassTiming[],
    ppInfo: PostProcessInfo,
    scenePassOrder: string[],
    alwaysOnPasses: string[] = [],
  ): FrameGraphData {
    const timingMap = new Map<string, PassTiming>();
    for (const t of passTimings) timingMap.set(t.name, t);

    const nodes: FrameGraphNode[] = [];
    const edges: FrameGraphEdge[] = [];
    const validations: FrameGraphValidation[] = [];

    let totalGpuMs = 0;
    let totalCpuMs = 0;
    let totalDrawCalls = 0;
    let totalTriangles = 0;

    // --- Scene passes (layer 0) ---
    const activeScenePasses: string[] = [];
    for (const name of scenePassOrder) {
      const t = timingMap.get(name);
      const active = !!t;
      const node: FrameGraphNode = {
        id: "scene:" + name,
        name,
        category: "scene",
        layer: 0,
        cpuMs: t?.cpuMs ?? 0,
        gpuMs: t?.gpuMs ?? 0,
        drawCalls: t?.drawCalls ?? 0,
        triangles: t?.triangles ?? 0,
        pipelineSwitches: t?.pipelineSwitches ?? 0,
        bindGroupChanges: t?.bindGroupChanges ?? 0,
        bufferRebinds: t?.bufferRebinds ?? 0,
        active,
      };
      nodes.push(node);
      if (active) {
        activeScenePasses.push(node.id);
        totalGpuMs += node.gpuMs;
        totalCpuMs += node.cpuMs;
        totalDrawCalls += node.drawCalls;
        totalTriangles += node.triangles;
      }
    }

    // Edges between consecutive active scene passes (shared color+depth)
    for (let i = 0; i < activeScenePasses.length - 1; i++) {
      edges.push({
        from: activeScenePasses[i],
        to: activeScenePasses[i + 1],
        resource: "color+depth",
        type: "color",
      });
    }

    // --- Post-process / pixelation (layer 1) ---
    const layer1NodeIds: string[] = [];

    if (ppInfo.pixelationEnabled) {
      const pxId = "pp:Pixelation";
      nodes.push({
        id: pxId,
        name: "Pixelation (size=" + ppInfo.pixelSize + ")",
        category: "pixelation",
        layer: 1,
        cpuMs: 0, gpuMs: 0, drawCalls: 0, triangles: 0,
        pipelineSwitches: 0, bindGroupChanges: 0, bufferRebinds: 0,
        active: true,
      });
      layer1NodeIds.push(pxId);
    } else if (ppInfo.postProcessEffects.length > 0) {
      for (const effName of ppInfo.postProcessEffects) {
        const eid = "pp:" + effName;
        nodes.push({
          id: eid,
          name: effName,
          category: "postprocess",
          layer: 1,
          cpuMs: 0, gpuMs: 0, drawCalls: 0, triangles: 0,
          pipelineSwitches: 0, bindGroupChanges: 0, bufferRebinds: 0,
          active: true,
        });
        layer1NodeIds.push(eid);
      }
      // Chain edges between consecutive post-process effects
      for (let i = 0; i < layer1NodeIds.length - 1; i++) {
        edges.push({
          from: layer1NodeIds[i],
          to: layer1NodeIds[i + 1],
          resource: "intermediate",
          type: "chain",
        });
      }
    }

    // Edge: last scene pass → first layer-1 node (or UI if no layer 1)
    const lastSceneId = activeScenePasses.length > 0
      ? activeScenePasses[activeScenePasses.length - 1]
      : null;

    if (lastSceneId && layer1NodeIds.length > 0) {
      edges.push({
        from: lastSceneId,
        to: layer1NodeIds[0],
        resource: "color attachment",
        type: "color",
      });
    }

    // --- UI composite (layer 2) ---
    const uiId = "ui:Composite";
    nodes.push({
      id: uiId,
      name: "UI Composite",
      category: "ui",
      layer: 2,
      cpuMs: 0, gpuMs: 0, drawCalls: 0, triangles: 0,
      pipelineSwitches: 0, bindGroupChanges: 0, bufferRebinds: 0,
      active: true,
    });

    // Edge: layer 1 → UI (or scene → UI if no layer 1)
    if (layer1NodeIds.length > 0) {
      edges.push({
        from: layer1NodeIds[layer1NodeIds.length - 1],
        to: uiId,
        resource: "canvas",
        type: "color",
      });
    } else if (lastSceneId) {
      edges.push({
        from: lastSceneId,
        to: uiId,
        resource: "canvas",
        type: "color",
      });
    }

    // --- Validation warnings ---
    for (const node of nodes) {
      if (node.category !== "scene") continue;
      if (!node.active) continue;
      if (node.drawCalls === 0 && !alwaysOnPasses.includes(node.name)) {
        validations.push({
          level: "info",
          message: `Pass "${node.name}" executed with 0 draw calls — consider skipping when empty`,
          passName: node.name,
        });
      }
      if (node.pipelineSwitches > 0 && node.drawCalls > 0) {
        const ratio = node.pipelineSwitches / node.drawCalls;
        if (ratio > 2) {
          validations.push({
            level: "warning",
            message: `Pass "${node.name}" has ${node.pipelineSwitches} pipeline switches for ${node.drawCalls} draw calls (ratio ${ratio.toFixed(1)}) — excessive state changes`,
            passName: node.name,
          });
        }
      }
      if (node.gpuMs > 3) {
        validations.push({
          level: "warning",
          message: `Pass "${node.name}" took ${node.gpuMs.toFixed(2)}ms GPU time — exceeds 3ms budget`,
          passName: node.name,
        });
      }
    }

    // Check for inactive scene passes that are always-on
    for (const name of alwaysOnPasses) {
      const node = nodes.find(n => n.name === name);
      if (node && !node.active) {
        validations.push({
          level: "info",
          message: `Pass "${name}" was not executed this frame`,
          passName: name,
        });
      }
    }

    return {
      nodes,
      edges,
      validations,
      totalGpuMs,
      totalCpuMs,
      totalDrawCalls,
      totalTriangles,
      timestamp: performance.now(),
    };
  }

  destroy(): void {
    this.gpuTimerPool?.destroy();
    this.gpuTimerPool = null;
  }
}
